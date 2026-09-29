import { randomUUID } from "node:crypto";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type LeverageConnection,
	SessionClient,
	type SessionInfo,
} from "./api";
import { resolveConnection } from "./config";
import { chooseDrawer, clean, report, textDrawer } from "./drawers";
import {
	createHistoryComponent,
	HISTORY_ENTRY,
	type HistoryEntry,
} from "./history";
import { createRemoteBashOperations, RemoteWorkspace } from "./remote";
import {
	LINK_ENTRY,
	type SessionLink,
	sameSession,
	sessionLink,
	viewRemoteHistory,
} from "./session-ui";
import { type Prompt, SessionView } from "./session-view";
import { BorderStatus, footerLines, statusLines } from "./status";
import { WorkspaceClient } from "./workspace/api";
import type { SessionDraft } from "./workspace/schema";
import { contextName, editDraft, sessionsDrawer } from "./workspace/ui";

// F1 and F2 open these draft settings directly.
const SETTING_SECTIONS = ["context", "model"] as const;
const FUNCTION_KEYS = [
	["f1", "settings context"],
	["f2", "settings model"],
	["f3", "sessions"],
	["f4", "approvals"],
] as const;
// Pi's own model and session keys open the matching Leverage control.
const PI_KEYS = [
	["app.model.select", "model"],
	["app.model.cycleForward", "model"],
	["app.model.cycleBackward", "model"],
	["app.thinking.cycle", "model"],
	["app.session.new", "new"],
	["app.session.resume", "sessions"],
] as const;
const PI_COMMANDS: Record<string, string> = {
	"/model": "model",
	"/resume": "sessions",
	"/new": "new",
	"/compact": "compact",
};
// These commands use the open view as it is. The others reconnect after a lost connection.
const VIEW_COMMANDS = new Set(["stop", "retry", "queue", "compact", "status"]);
// Pi creates a new extension instance when it switches sessions.
const composerDrafts = new Map<string, string>();
let nextDraft: Partial<SessionDraft> | undefined;

type Interaction = "approvals" | "questions" | "inbox" | "model";
type Command = (
	ctx: ExtensionCommandContext,
	words: string[],
	opening: number,
) => Promise<void>;

export default function leverage(pi: ExtensionAPI): void {
	// Pi needs a model entry to open its composer without a local provider login.
	pi.registerProvider("leverage", {
		name: "Leverage",
		baseUrl: "https://leverage.invalid",
		apiKey: "remote-session",
		api: "openai-completions",
		models: [
			{
				id: "session",
				name: "Leverage session",
				reasoning: false,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 64000,
			},
		],
		streamSimple: () => {
			throw new Error(
				"Use the Leverage composer to send prompts to the remote session.",
			);
		},
	});
	for (const [name, description] of Object.entries({
		host: "Leverage server origin",
		workspace: "Leverage workspace slug",
		session: "Leverage session to open; otherwise open a new draft",
		directory:
			"Workspace or channel folder for the session picker and new sessions",
		cwd: "Remote working directory for manual shell commands",
	}))
		pi.registerFlag(`leverage-${name}`, { type: "string", description });

	// The connection. A new generation starts each time it closes.
	let connection: LeverageConnection | undefined;
	let api: SessionClient | undefined;
	let workspace: WorkspaceClient | undefined;
	let lifetime = new AbortController();
	let generation = 0;
	let stream = "disconnected";
	let failure = "Choose or create a session with /leverage.";
	// The open Leverage session.
	let view: SessionView | undefined;
	// A new session is a local draft until its first prompt creates it.
	let draft: SessionDraft | undefined;
	let draftLoading: Promise<void> | undefined;
	let draftError: string | undefined;
	let draftContext = "Standalone";
	let creating = false;
	let pendingCreation: Prompt | undefined;
	// Pi's composer and the dialogs above it.
	let composerKey: string | undefined;
	let editorInstalled = false;
	let priorEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let composer: { editor: CustomEditor; tui: TUI } | undefined;
	let working: BorderStatus | undefined;
	let redrawConversation = () => {};
	let dialogCount = 0;
	let manualShells = 0;

	const flag = (name: string) => {
		const value = pi.getFlag(`leverage-${name}`);
		return typeof value === "string" ? value : undefined;
	};
	const settings = (link?: SessionLink) =>
		resolveConnection({
			host: flag("host") ?? link?.host,
			workspace: flag("workspace") ?? link?.workspace,
			session: link?.sessionId ?? flag("session"),
			cwd: flag("cwd") ?? link?.cwd,
			directory: flag("directory"),
		});
	const linkFor = (session: SessionInfo): SessionLink => ({
		version: 1,
		host: connection!.host,
		workspace: connection!.workspace,
		sessionId: session.id,
		...(connection!.cwd ? { cwd: connection!.cwd } : {}),
	});
	const busy = () => dialogCount > 0 || !!view?.interactions?.hasDialog;
	// Shortcuts go through Pi's command path. Only a command can switch sessions.
	const runCommand = (args: string) =>
		pi.sendUserMessage(`/leverage ${args}`, { expandPromptTemplates: true });

	const stopWorking = () => {
		composer?.editor.setWorkingStatusIndicator(undefined);
		working?.stop();
		working = undefined;
	};
	const status = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			"leverage",
			clean(
				view
					? `${view.session.title || view.session.id} · ${view.stream}`
					: draft
						? "Leverage: new session"
						: "Leverage: connecting",
			),
		);
		const spinner =
			view && (!view.ready || view.running)
				? view.ready
					? "Working"
					: "Connecting"
				: undefined;
		if (!spinner) stopWorking();
		else if (composer) {
			const { editor, tui } = composer;
			working ??= new BorderStatus(
				tui,
				(text) => editor.borderColor(text),
				(text) => editor.borderColor(text),
				spinner,
			);
			working.setMessage(spinner);
			// Pi does not export its indicator type; the composer calls only the border methods.
			editor.setWorkingStatusIndicator(
				working as unknown as Parameters<
					CustomEditor["setWorkingStatusIndicator"]
				>[0],
			);
		}
		// Other modes forward widget text, so only the terminal gets colors.
		const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
		const lines = statusLines(
			view,
			{
				settings: draft,
				place: draftContext,
				error: draftError,
				unconfirmed: !!pendingCreation,
			},
			theme,
		);
		if (!theme) {
			ctx.ui.setWidget("leverage-session", lines);
			return;
		}
		// Pi indents text widgets by a column, so these lines sit flush with the composer.
		ctx.ui.setWidget("leverage-session", (tui) => {
			// Another extension's composer may not draw the indicator, so it goes here instead.
			if (spinner && !composer) {
				working ??= new BorderStatus(
					tui,
					(text) => theme.fg("accent", text),
					(text) => theme.fg("muted", text),
					spinner,
				);
				working.setMessage(spinner);
			}
			const indicator = composer ? undefined : working;
			return {
				invalidate() {},
				render: (width: number) => [
					...(indicator ? indicator.render(width) : []),
					...lines.flatMap((line) => wrapTextWithAnsi(line, width)),
				],
			};
		});
	};

	const disconnect = () => {
		generation++;
		stopWorking();
		view?.close();
		view = undefined;
		lifetime.abort();
		workspace?.close();
		api?.close();
		workspace = undefined;
		api = undefined;
		stream = "disconnected";
		draft = undefined;
		draftLoading = undefined;
		draftError = undefined;
		draftContext = "Standalone";
		creating = false;
		pendingCreation = undefined;
		manualShells = 0;
	};
	const ensureApi = () => {
		if (lifetime.signal.aborted) disconnect();
		if (!api) {
			connection = settings();
			lifetime = new AbortController();
			api = new SessionClient(connection);
			workspace = new WorkspaceClient(api, connection);
		}
		return api;
	};
	// The open session once it is ready. A write also needs collaborator access.
	const requireSession = (write = false): SessionView => {
		if (write && view && !view.writable)
			throw new Error(
				"This session is read-only. Ask the owner for collaborator access.",
			);
		if (!api || !view?.ready) throw new Error(view?.problem ?? failure);
		return view;
	};
	const stop = async () => {
		await requireSession(true).stop();
	};
	const showInteraction = async (kind: Interaction) => {
		await requireSession().interactions!.show(kind);
	};

	const attach = async (session: SessionInfo, ctx: ExtensionContext) => {
		const client = ensureApi();
		const owner = lifetime;
		view?.close();
		composerKey = `${connection!.host}/${connection!.workspace}/${session.id}`;
		view = new SessionView(pi, ctx, client, workspace!, session, owner.signal, {
			changed: () => status(ctx),
			opened: () => redrawConversation(),
			revoked: () => owner.abort(),
		});
		await view.open(linkFor(session));
	};
	const switchTo = async (
		session: SessionInfo,
		ctx: ExtensionCommandContext,
	) => {
		if (!ctx.isIdle() || ctx.hasPendingMessages())
			throw new Error("Stop local work before opening a Leverage session.");
		const link = linkFor(session);
		const currentLink = sessionLink(ctx.sessionManager.getBranch());
		if (currentLink && sameSession(link, currentLink) && view?.ready) {
			await view.sync();
			return;
		}
		const result = await ctx.newSession({
			setup: async (manager) => {
				manager.appendCustomEntry(LINK_ENTRY, link);
				manager.appendSessionInfo(session.title || "Leverage session");
			},
		});
		if (result.cancelled)
			ctx.ui.notify(
				`Open ${session.id} with /leverage open to continue.`,
				"info",
			);
	};
	const submit = async (
		event: Pick<InputEvent, "text" | "images">,
		ctx: ExtensionContext,
		delivery: "steer" | "queue" = "steer",
	) => {
		const files = event.images?.map((image, index) => ({
			name: `image-${index + 1}.${image.mimeType.split("/")[1] || "png"}`,
			uri: `data:${image.mimeType};base64,${image.data}`,
		}));
		const prompt: Prompt = {
			id: `msg_${randomUUID()}`,
			text: event.text,
			...(files?.length ? { files } : {}),
			delivery,
		};
		if (view) await requireSession(true).send(prompt);
		else await createAndSend(prompt, ctx);
	};
	// The first prompt creates the empty session, opens it, then sends the prompt.
	const createAndSend = async (prompt: Prompt, ctx: ExtensionContext) => {
		if (creating) throw new Error("Session setup is already in progress.");
		await draftLoading;
		if (creating) throw new Error("Session setup is already in progress.");
		if (!draft || !workspace || !api)
			throw new Error(
				"Leverage defaults are unavailable. Use /leverage new to retry.",
			);
		if (pendingCreation && pendingCreation.id !== prompt.id)
			throw new Error(
				"The previous setup is unconfirmed. Use /leverage retry first.",
			);
		const opening = generation;
		creating = true;
		pendingCreation = prompt;
		status(ctx);
		try {
			const id = await workspace.create(draft, lifetime.signal);
			const session = await api.get(`ses_${id}`, lifetime.signal);
			if (opening !== generation) return;
			if (!view?.ready || view.session.id !== session.id)
				await attach(session, ctx);
			await requireSession(true).send(prompt);
			if (opening === generation) {
				draft = undefined;
				pendingCreation = undefined;
			}
		} finally {
			if (opening === generation) {
				creating = false;
				status(ctx);
			}
		}
	};
	// A new session starts as a local draft. --leverage-directory can name its channel.
	const startDraft = async (ctx: ExtensionContext, opening: number) => {
		const client = workspace!;
		const nativeSocket = await client.socket(lifetime.signal);
		const unstate = nativeSocket.onState((state) => {
			if (opening === generation) {
				stream = state;
				status(ctx);
			}
		});
		lifetime.signal.addEventListener("abort", unstate, { once: true });
		void nativeSocket.connect().catch((error) => {
			if (opening === generation) report(ctx, error);
		});
		const overrides = nextDraft;
		nextDraft = undefined;
		const loaded: SessionDraft = { ...client.draft(), ...overrides };
		draftLoading = (async () => {
			const channels =
				loaded.context.type === "channel" || connection?.directory
					? await client.channels(lifetime.signal)
					: [];
			if (opening !== generation) return;
			const channel = channels.find(
				(one) =>
					connection!.directory === `/${connection!.workspace}/${one.name}`,
			);
			if (!overrides?.context && channel)
				loaded.context = { type: "channel", channelId: channel.id };
			draft = loaded;
			draftContext = contextName(loaded, channels);
			status(ctx);
		})().catch((error: unknown) => {
			if (opening === generation && !lifetime.signal.aborted) {
				failure =
					error instanceof Error
						? error.message
						: "Cannot load the workspace channels";
				draftError = failure;
				status(ctx);
				report(ctx, error);
			}
		});
	};
	// Pi's composer, with Pi's model and session controls sent to Leverage.
	const installEditor = (ctx: ExtensionContext, opening: number) => {
		const previousEditor = editorInstalled
			? priorEditor
			: ctx.ui.getEditorComponent();
		priorEditor = previousEditor;
		editorInstalled = true;
		ctx.ui.setEditorComponent((tui, theme, keys) => {
			redrawConversation = () => {
				// Reset the old viewport before a different conversation fills the terminal.
				tui.terminal.write("\u001b[2J\u001b[H\u001b[3J");
				tui.requestRender(true);
			};
			const editor =
				previousEditor?.(tui, theme, keys) ??
				new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
			composer =
				editor instanceof CustomEditor && editor.embedWorkingStatus
					? { editor, tui }
					: undefined;
			const handleInput = editor.handleInput.bind(editor);
			editor.handleInput = (data) => {
				const completing =
					"isShowingAutocomplete" in editor &&
					typeof editor.isShowingAutocomplete === "function" &&
					editor.isShowingAutocomplete() === true;
				if (
					matchesKey(data, "escape") &&
					!completing &&
					view?.running &&
					!manualShells &&
					!busy()
				) {
					void stop().catch((error: unknown) => {
						if (opening === generation) report(ctx, error);
					});
					return;
				}
				const action = PI_KEYS.find(([key]) => keys.matches(data, key));
				if (!completing && !busy() && action) {
					runCommand(action[1]);
					return;
				}
				if (matchesKey(data, "enter")) {
					const [command, ...args] = editor.getText().trim().split(/\s+/);
					if (command && PI_COMMANDS[command])
						editor.setText(
							`/leverage ${PI_COMMANDS[command]} ${args.join(" ")}`.trim(),
						);
				}
				handleInput(data);
			};
			return editor;
		});
	};
	// Draft settings before creation. An open session has no context, so F1 shows its details.
	const editSettings = async (
		ctx: ExtensionCommandContext,
		section?: (typeof SETTING_SECTIONS)[number],
	) => {
		if (!view) {
			await draftLoading;
			if (!draft) throw new Error(failure);
			await editDraft(
				workspace!,
				ctx,
				draft,
				lifetime.signal,
				(context) => {
					draftContext = context;
					status(ctx);
				},
				section,
			);
			return;
		}
		const picked =
			section === "model"
				? "model"
				: section === "context"
					? "info"
					: await chooseDrawer(
							ctx,
							"Session settings",
							[
								{
									value: "model",
									label: "Model and reasoning",
									detail: view.model,
								},
								{ value: "info", label: "Session details" },
							],
							lifetime.signal,
						);
		if (picked === "model") await showInteraction("model");
		if (picked === "info")
			await textDrawer(
				ctx,
				"Session details",
				() =>
					[
						view?.session.title || "Untitled session",
						view?.session.location.directory,
						view?.session.id,
						view?.model,
					]
						.filter(Boolean)
						.join("\n"),
				lifetime.signal,
			);
	};
	// Reads the session again after its title or folder changes.
	const reload = async (current: SessionView, ctx: ExtensionContext) => {
		current.session = await api!.get(current.session.id, current.signal);
		pi.setSessionName(current.session.title || "Leverage session");
		status(ctx);
	};

	const commands: Record<string, Command> = {
		stop,
		retry: async (ctx) => {
			if (pendingCreation && draft) {
				await createAndSend(pendingCreation, ctx);
				return;
			}
			const prompt = view?.failedPrompt;
			if (!prompt) throw new Error("There is no unconfirmed message to retry.");
			await requireSession(true).send(prompt);
		},
		queue: async (ctx, words) => {
			if (!words.length) throw new Error("Use /leverage queue <message>.");
			await submit({ text: words.join(" ") }, ctx, "queue");
		},
		compact: async () => {
			await requireSession(true).compact();
		},
		status: async (ctx) => {
			ctx.ui.notify(
				clean(
					view
						? `${view.session.title || view.session.id}\n${view.session.location.directory}\n${view.session.id}\n${view.model} · ${view.running ? "working" : "idle"} · ${view.stream}`
						: failure,
				),
				"info",
			);
		},
		new: async (ctx, words) => {
			nextDraft = words.length ? { title: words.join(" ") } : {};
			const result = await ctx.newSession();
			if (result.cancelled) nextDraft = undefined;
		},
		settings: (ctx, words) =>
			editSettings(
				ctx,
				SETTING_SECTIONS.find((one) => one === words[0]),
			),
		model: (ctx) =>
			view ? showInteraction("model") : editSettings(ctx, "model"),
		approvals: () => showInteraction("approvals"),
		questions: () => showInteraction("questions"),
		inbox: () => showInteraction("inbox"),
		history: async (ctx) => {
			const current = requireSession();
			const { session, signal } = current;
			await viewRemoteHistory(api!, ctx, session, signal, {
				messages: (await workspace!.bootstrap(session.id, signal)).messages,
				members: current.shared.members,
				viewerId: current.shared.userId,
			});
		},
		rename: async (ctx, words) => {
			const current = requireSession(true);
			if (!words.length) throw new Error("Use /leverage rename <title>.");
			await api!.rename(current.session.id, words.join(" "), current.signal);
			await reload(current, ctx);
		},
		archive: async (ctx) => {
			const current = requireSession(true);
			await api!.archive(
				current.session.id,
				`/${connection!.workspace}/.archive`,
				current.signal,
			);
			await reload(current, ctx);
		},
		restore: async (ctx, words) => {
			const current = requireSession(true);
			const { signal } = current;
			if (!ctx.hasUI && !words.length)
				throw new Error("Use /leverage restore /workspace/channel.");
			const folder =
				words.join(" ") ||
				(await ctx.ui.select(
					"Restore to original folder",
					await api!.folders(signal),
					{ signal },
				));
			if (!folder || signal.aborted) return;
			await api!.archive(current.session.id, folder, signal);
			await reload(current, ctx);
		},
		open: async (ctx, words, opening) => {
			if (!words[0]) throw new Error("Use /leverage open <session-id>.");
			const session = await api!.get(words[0], lifetime.signal);
			if (opening === generation) await switchTo(session, ctx);
		},
		sessions: async (ctx, words, opening) => {
			const picked = await sessionsDrawer(
				workspace!,
				ctx,
				lifetime.signal,
				words.join(" "),
			);
			if (picked === "new") {
				await ctx.newSession();
				return;
			}
			if (!picked) return;
			const session = await api!.get(`ses_${picked}`, lifetime.signal);
			if (opening === generation) await switchTo(session, ctx);
		},
	};

	pi.registerEntryRenderer<Pick<HistoryEntry, "sessionId" | "id">>(
		HISTORY_ENTRY,
		(entry, options, theme) =>
			createHistoryComponent(
				() => {
					const history = view?.history;
					const marker = entry.data;
					return marker && history?.sessionId === marker.sessionId
						? history.entry(marker.id)
						: undefined;
				},
				options.expanded,
				theme,
			),
	);
	pi.on("input", async (event, ctx) => {
		try {
			await submit(event, ctx);
		} catch (error) {
			if (!lifetime.signal.aborted) report(ctx, error);
		}
		// Pi continues to its local model if an input handler throws.
		return { action: "handled" };
	});
	pi.on("session_before_switch", (_event, ctx) => {
		if (creating) {
			ctx.ui.notify("Wait for session setup to finish.", "info");
			return { cancel: true };
		}
		if (composerKey) composerDrafts.set(composerKey, ctx.ui.getEditorText());
	});
	pi.on("session_start", async (event, ctx) => {
		disconnect();
		lifetime = new AbortController();
		const opening = generation;
		composerKey = undefined;
		pi.setActiveTools([]);
		installEditor(ctx, opening);
		// Pi's footer layout, with the Leverage folder and model in place of local ones.
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render: (width) =>
				footerLines(
					theme,
					width,
					[
						view?.session.location.directory ??
							(connection ? `/${connection.workspace}` : ""),
						view?.session.title,
					]
						.filter(Boolean)
						.join(" • "),
					view?.stream ?? stream,
					view?.model ?? "",
				),
		}));
		try {
			const link = sessionLink(ctx.sessionManager.getBranch());
			connection = settings(link);
			composerKey = `${connection.host}/${connection.workspace}/${link?.sessionId ?? (event.reason !== "new" ? connection.sessionId : undefined) ?? ctx.sessionManager.getSessionId()}`;
			ctx.ui.setEditorText(composerDrafts.get(composerKey) ?? "");
			if (
				link &&
				(link.host !== connection.host ||
					link.workspace !== connection.workspace)
			)
				throw new Error(
					"This view belongs to another workspace. Use /leverage to choose a session.",
				);
			api = new SessionClient(connection);
			workspace = new WorkspaceClient(api, connection);
			if (link || (connection.sessionId && event.reason !== "new")) {
				const session = await api.get(
					link?.sessionId ?? connection.sessionId!,
					lifetime.signal,
				);
				if (opening === generation) {
					// A view with local Pi messages opens the session in a new view instead.
					const localConversation = ctx.sessionManager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								(entry.message.role === "user" ||
									entry.message.role === "assistant"),
						);
					if (localConversation) runCommand(`open ${session.id}`);
					else await attach(session, ctx);
				}
			} else await startDraft(ctx, opening);
		} catch (error) {
			if (opening !== generation) return;
			failure =
				error instanceof Error ? error.message : "Cannot connect to Leverage.";
			report(ctx, error);
		}
		if (opening === generation) status(ctx);
	});
	pi.on("session_shutdown", disconnect);
	pi.on("session_before_compact", async (_event, ctx) => {
		try {
			await requireSession(true).compact();
		} catch (error) {
			report(ctx, error);
		}
		return { cancel: true };
	});
	pi.on("session_before_fork", (_event, ctx) => {
		ctx.ui.notify(
			"Leverage does not support session forks. Use /leverage new.",
			"info",
		);
		return { cancel: true };
	});
	pi.on("user_bash", () => {
		const operations = createRemoteBashOperations(() => {
			const current = requireSession(true);
			current.terminal ??= new RemoteWorkspace(
				api!,
				current.session.id,
				connection!.cwd,
			);
			return current.terminal;
		});
		return {
			operations: {
				async exec(...args: Parameters<typeof operations.exec>) {
					const opening = generation;
					manualShells++;
					try {
						return await operations.exec(...args);
					} finally {
						if (opening === generation) manualShells--;
					}
				},
			},
		};
	});
	pi.registerCommand("leverage", {
		description:
			"New, sessions, settings, approvals, history, stop, queue, model",
		handler: async (args, ctx) => {
			const opening = generation;
			dialogCount++;
			try {
				const [action = "sessions", ...words] = args
					.trim()
					.split(/\s+/)
					.filter(Boolean);
				if (!VIEW_COMMANDS.has(action)) ensureApi();
				const command = Object.hasOwn(commands, action)
					? commands[action]
					: undefined;
				if (!command)
					throw new Error(
						"Use /leverage sessions, new, open, history, stop, queue, approvals, questions, inbox, model, compact, rename, archive, or restore.",
					);
				await command(ctx, words, opening);
			} catch (error) {
				if (opening === generation) report(ctx, error);
			} finally {
				dialogCount--;
			}
		},
	});
	for (const [key, action] of FUNCTION_KEYS)
		pi.registerShortcut(key, {
			description: `Leverage ${action}`,
			handler: async () => {
				if (!busy()) runCommand(action);
			},
		});
}
