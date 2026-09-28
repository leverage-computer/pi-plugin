import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type LeverageConnection,
	type PromptFile,
	SessionClient,
	type SessionInfo,
} from "./api";
import { resolveConnection } from "./config";
import { chooseDrawer, drawerContext, textDrawer } from "./drawers";
import {
	createHistoryComponent,
	HISTORY_ENTRY,
	type HistoryEntry,
	SharedHistory,
} from "./history";
import { PendingInteractions } from "./interactions";
import { createRemoteBashOperations, RemoteWorkspace } from "./remote";
import {
	LINK_ENTRY,
	type SessionLink,
	sameSession,
	sessionLink,
	viewRemoteHistory,
} from "./session-ui";
import { WorkspaceClient } from "./workspace-api";
import type { SessionDraft } from "./workspace-schema";
import { SharedSession } from "./workspace-state";
import { contextName, editDraft, sessionsDrawer } from "./workspace-ui";

type Prompt = {
	id: string;
	text: string;
	files?: PromptFile[];
	delivery: "steer" | "queue";
};

// F1 and F2 open these draft settings directly.
const SETTING_SECTIONS = ["context", "model"] as const;
// Pi creates a new extension instance when it switches sessions.
const composerDrafts = new Map<string, string>();
let nextDraft: Partial<SessionDraft> | undefined;

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

	let api: SessionClient | undefined;
	let workspace: WorkspaceClient | undefined;
	let shared: SharedSession | undefined;
	let draft: SessionDraft | undefined;
	let draftLoading: Promise<void> | undefined;
	let draftError: string | undefined;
	let creating = false;
	let pendingCreation: Prompt | undefined;
	let draftContext = "Standalone";
	let attachment: AbortController | undefined;
	let composerKey: string | undefined;
	let editorInstalled = false;
	let redrawConversation = () => {};
	let priorEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
	let connection: LeverageConnection | undefined;
	let selected: SessionInfo | undefined;
	let history: SharedHistory | undefined;
	let interactions: PendingInteractions | undefined;
	let terminal: RemoteWorkspace | undefined;
	let lifetime = new AbortController();
	let generation = 0;
	let ready = false;
	let running = false;
	let activityVersion = 0;
	let streamState = "disconnected";
	let model = "";
	let failure = "Choose or create a session with /leverage.";
	let sending = false;
	let stopping = false;
	let manualShells = 0;
	let failedPrompt: Prompt | undefined;
	let refresh: Promise<void> | undefined;
	let refreshRequested = false;
	let dialogCount = 0;
	const displayed = new Set<string>();
	const flag = (name: string) => {
		const value = pi.getFlag(`leverage-${name}`);
		return typeof value === "string" ? value : undefined;
	};
	const status = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			"leverage",
			stripVTControlCharacters(
				selected
					? `${selected.title || selected.id} · ${streamState}`
					: draft
						? "Leverage: new session"
						: "Leverage: connecting",
			),
		);
		// Other modes forward widget text, so only the terminal gets colors.
		const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
		const paint = (color: ThemeColor, value: string, bold = false) => {
			const text = stripVTControlCharacters(value);
			return theme ? theme.fg(color, bold ? theme.bold(text) : text) : text;
		};
		const pairs = (rows: string[][]) =>
			rows
				.map(
					([key, label, value]) =>
						`${paint("accent", key)} ${paint(value ? "dim" : "muted", label)}${value ? ` ${paint("text", value)}` : ""}`,
				)
				.join("   ");
		if (theme)
			ctx.ui.setWidget(
				"leverage-keys",
				[
					pairs(
						selected
							? [
									["F1", "Details"],
									["F2", "Model"],
									["F3", "Sessions"],
									["F4", "Approvals"],
								]
							: [["F3", "Sessions"]],
					),
				],
				{ placement: "belowEditor" },
			);
		const approvals = interactions?.approvalCount ?? 0;
		const questions = interactions?.questionCount ?? 0;
		ctx.ui.setWidget(
			"leverage-session",
			selected
				? [
						`${paint("text", selected.title || selected.id, true)}  ${
							!ready
								? paint("muted", "○ Connecting…")
								: running
									? paint("warning", "● Working · Esc to stop")
									: paint("success", "● Ready")
						}`,
						...(shared && !shared.canWrite
							? [
									paint(
										"warning",
										"Read-only · ask the owner for collaborator access",
									),
								]
							: []),
						...(approvals
							? [
									paint(
										"warning",
										`▲ ${approvals === 1 ? "1 approval" : `${approvals} approvals`} waiting · F4 to review`,
									),
								]
							: []),
						...(questions
							? [
									paint(
										"warning",
										`? ${questions === 1 ? "1 question" : `${questions} questions`} waiting · /leverage questions`,
									),
								]
							: []),
						...(failedPrompt
							? [
									paint(
										"warning",
										"▲ Send not confirmed · /leverage retry sends the same message",
									),
								]
							: []),
					]
				: [
						`${paint("accent", "◆ New Leverage session", true)}${
							draft ? paint("dim", "  Enter creates it") : ""
						}`,
						draft
							? pairs([
									["F1", "Context", draftContext],
									[
										"F2",
										"Model",
										draft.model
											? `${draft.model}${draft.reasoningEffort ? ` · ${draft.reasoningEffort}` : ""}`
											: "Default",
									],
								])
							: paint(
									draftError ? "error" : "dim",
									draftError ?? "Loading the workspace…",
								),
						...(pendingCreation
							? [
									paint(
										"warning",
										"▲ Setup not confirmed · /leverage retry continues the same session",
									),
								]
							: []),
					],
		);
	};
	const report = (ctx: ExtensionContext, error: unknown) => {
		ctx.ui.notify(
			stripVTControlCharacters(
				error instanceof Error ? error.message : "Leverage request failed",
			),
			"error",
		);
	};
	const display = (changes: HistoryEntry[], ctx: ExtensionContext) => {
		for (const entry of [...changes].sort((a, b) => a.created - b.created)) {
			if (displayed.has(entry.id)) continue;
			displayed.add(entry.id);
			pi.appendEntry(HISTORY_ENTRY, {
				sessionId: entry.sessionId,
				id: entry.id,
			});
		}
		if (changes.length) status(ctx);
	};
	const disconnect = () => {
		generation++;
		interactions?.close();
		interactions = undefined;
		lifetime.abort();
		attachment?.abort();
		attachment = undefined;
		shared?.close();
		shared = undefined;
		workspace?.close();
		workspace = undefined;
		draft = undefined;
		draftLoading = undefined;
		draftError = undefined;
		creating = false;
		pendingCreation = undefined;
		draftContext = "Standalone";
		terminal?.close();
		api?.close();
		terminal = undefined;
		api = undefined;
		selected = undefined;
		history = undefined;
		ready = false;
		running = false;
		activityVersion = 0;
		streamState = "disconnected";
		model = "";
		refresh = undefined;
		refreshRequested = false;
		sending = false;
		stopping = false;
		manualShells = 0;
		failedPrompt = undefined;
		displayed.clear();
	};
	const settings = (link?: SessionLink) =>
		resolveConnection({
			host: flag("host") ?? link?.host,
			workspace: flag("workspace") ?? link?.workspace,
			session: link?.sessionId ?? flag("session"),
			cwd: flag("cwd") ?? link?.cwd,
			directory: flag("directory"),
		});
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
	const writable = () => {
		if (shared && (!shared.canWrite || shared.revoked))
			throw new Error(
				"This session is read-only. Ask the owner for collaborator access.",
			);
	};
	const linkFor = (session: SessionInfo): SessionLink => ({
		version: 1,
		host: connection!.host,
		workspace: connection!.workspace,
		sessionId: session.id,
		...(connection!.cwd ? { cwd: connection!.cwd } : {}),
	});
	const requireSession = () => {
		if (!api || !selected || !ready) throw new Error(failure);
		return { client: api, session: selected, signal: lifetime.signal };
	};
	const sync = (ctx: ExtensionContext): Promise<void> => {
		if (refresh) {
			refreshRequested = true;
			return refresh;
		}
		const client = api;
		const projection = history;
		if (!client || !projection) return Promise.resolve();
		const opening = generation;
		const signal = attachment
			? AbortSignal.any([lifetime.signal, attachment.signal])
			: lifetime.signal;
		refresh = (async () => {
			do {
				refreshRequested = false;
				const load = projection.beginLoad();
				const activity = activityVersion;
				const [page, active, inbox] = await Promise.all([
					client.history(projection.sessionId, {
						order: "desc",
						limit: 100,
						signal,
					}),
					client.active(signal),
					client.inbox(projection.sessionId, signal),
					interactions?.refresh(),
				]);
				if (opening !== generation || signal.aborted) return;
				display(projection.merge(page.data, load), ctx);
				display(projection.inbox(inbox), ctx);
				if (activity === activityVersion)
					running = !!active[projection.sessionId];
				status(ctx);
			} while (refreshRequested);
		})().finally(() => {
			if (opening === generation && !signal.aborted) refresh = undefined;
		});
		return refresh;
	};
	const stop = async (ctx: ExtensionContext) => {
		writable();
		if (stopping) return;
		const { client, session, signal } = requireSession();
		stopping = true;
		try {
			await client.interrupt(session.id, signal);
			ctx.ui.notify("Stop requested for the shared session.", "info");
			await sync(ctx);
		} finally {
			if (!signal.aborted) stopping = false;
		}
	};
	const attach = async (session: SessionInfo, ctx: ExtensionContext) => {
		const client = ensureApi();
		const opening = generation;
		attachment?.abort();
		refresh = undefined;
		refreshRequested = false;
		interactions?.close();
		terminal?.close();
		terminal = undefined;
		attachment = new AbortController();
		const signal = AbortSignal.any([lifetime.signal, attachment.signal]);
		ready = false;
		selected = session;
		composerKey = `${connection!.host}/${connection!.workspace}/${session.id}`;
		history = new SharedHistory(session.id);
		shared?.close();
		shared = new SharedSession(
			workspace!,
			session.id,
			() => {
				if (opening !== generation || signal.aborted || !shared) return;
				display(
					history?.attribute(
						shared.messages.values(),
						shared.members,
						shared.userId,
					) ?? [],
					ctx,
				);
				if (shared.session)
					model = `${shared.session.model ?? shared.session.providerFamily}${shared.session.reasoningEffort ? ` · ${shared.session.reasoningEffort}` : ""}`;
				interactions?.permissionsChanged();
				status(ctx);
			},
			(error) => {
				if (opening === generation && !signal.aborted) report(ctx, error);
			},
			() => {
				if (opening !== generation) return;
				ready = false;
				history = undefined;
				interactions?.close();
				lifetime.abort();
				failure =
					"Session access was removed. Use /leverage sessions to open another session.";
				ctx.ui.notify(failure, "warning");
				status(ctx);
			},
		);
		await shared.start(signal);
		if (opening !== generation || signal.aborted) return;
		let streamFailed = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== HISTORY_ENTRY)
				continue;
			const marker = entry.data as
				| { sessionId?: unknown; id?: unknown }
				| undefined;
			if (marker?.sessionId === session.id && typeof marker.id === "string")
				displayed.add(marker.id);
		}
		interactions = new PendingInteractions(
			client,
			ctx.mode === "tui" ? drawerContext(ctx) : ctx,
			session.id,
			signal,
			() => !!shared?.canWrite && !shared.revoked,
			() => status(ctx),
		);
		if (!sessionLink(ctx.sessionManager.getBranch()))
			pi.appendEntry(LINK_ENTRY, linkFor(session));
		pi.setSessionName(session.title || "Leverage session");
		streamState = "connecting";
		status(ctx);
		const completeAttach = () => {
			if (opening !== generation || signal.aborted || streamFailed || ready)
				return;
			ready = true;
			failure = "Choose a Leverage session with /leverage.";
			void client.markRead(session.id, signal).catch(() => {});
			status(ctx);
			redrawConversation();
		};
		const initialSync = sync(ctx);
		const repair = () => {
			const pending = sync(ctx);
			if (pending === initialSync) return;
			void pending.then(completeAttach).catch((error: unknown) => {
				if (opening === generation) report(ctx, error);
			});
		};
		void client
			.events({
				signal,
				onConnection(state) {
					if (opening !== generation || signal.aborted) return;
					streamState = state === "connected" ? "live" : "reconnecting";
					status(ctx);
					if (state === "connected") repair();
				},
				onEvent(event) {
					if (opening !== generation || signal.aborted || !history) return;
					interactions?.apply(event);
					if (
						!("sessionID" in event.data) ||
						event.data.sessionID !== session.id
					)
						return;
					display(history.apply(event), ctx);
					if (event.type === "session.status") {
						activityVersion++;
						running = event.data.status.type !== "idle";
					} else if (event.type === "session.execution.started") {
						activityVersion++;
						running = true;
					} else if (event.type === "session.renamed") {
						selected = { ...selected!, title: event.data.title };
						pi.setSessionName(event.data.title);
					} else if (event.type === "session.model.selected") {
						model = `${event.data.model.id}${event.data.model.variant ? ` · ${event.data.model.variant}` : ""}`;
					} else if (event.type === "session.deleted") {
						ready = false;
						streamFailed = true;
						interactions?.close();
						failure =
							"This session is no longer available. Choose another with /leverage.";
						ctx.ui.notify(failure, "warning");
					}
					if (
						[
							"session.execution.succeeded",
							"session.execution.failed",
							"session.execution.interrupted",
							"session.compaction.ended",
							"session.compaction.failed",
							"session.shell.ended",
							"session.inbox.delivered",
							"session.inbox.cancelled",
						].includes(event.type)
					)
						repair();
					status(ctx);
				},
			})
			.catch((error: unknown) => {
				if (opening !== generation || signal.aborted) return;
				streamFailed = true;
				ready = false;
				interactions?.close();
				streamState = "disconnected";
				failure =
					"The live connection failed. Reopen this session with /leverage.";
				status(ctx);
				report(ctx, error);
			});
		await initialSync;
		completeAttach();
	};
	const switchTo = async (
		session: SessionInfo,
		ctx: ExtensionCommandContext,
	) => {
		if (!ctx.isIdle() || ctx.hasPendingMessages())
			throw new Error("Stop local work before opening a Leverage session.");
		const link = linkFor(session);
		const currentLink = sessionLink(ctx.sessionManager.getBranch());
		if (currentLink && sameSession(link, currentLink) && ready) {
			await sync(ctx);
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
	const send = async (prompt: Prompt, ctx: ExtensionContext) => {
		writable();
		const { client, session, signal } = requireSession();
		if (sending) throw new Error("Wait for the current message to be sent.");
		const opening = generation;
		sending = true;
		try {
			const accepted = await client.prompt(session.id, prompt, signal);
			if (opening !== generation) return;
			if (failedPrompt?.id === prompt.id) failedPrompt = undefined;
			display(history!.inbox([accepted]), ctx);
			void sync(ctx).catch((error: unknown) => {
				if (!signal.aborted) report(ctx, error);
			});
		} catch (error) {
			if (opening === generation) failedPrompt = prompt;
			throw error;
		} finally {
			if (opening === generation) {
				sending = false;
				status(ctx);
			}
		}
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
		if (!selected) {
			await createAndSend(prompt, ctx);
			return;
		}
		await send(prompt, ctx);
	};
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
			if (!ready || selected?.id !== session.id) await attach(session, ctx);
			await send(prompt, ctx);
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
	const compact = async (ctx: ExtensionContext) => {
		writable();
		const { client, session, signal } = requireSession();
		await client.compact(session.id, `msg_${randomUUID()}`, signal);
		ctx.ui.notify("Compaction requested for the shared session.", "info");
	};

	pi.registerEntryRenderer<Pick<HistoryEntry, "sessionId" | "id">>(
		HISTORY_ENTRY,
		(entry, options, theme) =>
			createHistoryComponent(
				() =>
					history
						?.entries()
						.find(
							(item) =>
								item.id === entry.data?.id &&
								item.sessionId === entry.data?.sessionId,
						),
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
				new CustomEditor(tui, theme, keys);
			const handleInput = editor.handleInput.bind(editor);
			const actions = [
				["app.model.select", "model"],
				["app.model.cycleForward", "model"],
				["app.model.cycleBackward", "model"],
				["app.thinking.cycle", "model"],
				["app.session.new", "new"],
				["app.session.resume", "sessions"],
			] as const;
			editor.handleInput = (data) => {
				const completing =
					"isShowingAutocomplete" in editor &&
					typeof editor.isShowingAutocomplete === "function" &&
					editor.isShowingAutocomplete() === true;
				if (
					matchesKey(data, "escape") &&
					!completing &&
					running &&
					!manualShells &&
					!dialogCount &&
					!interactions?.hasDialog
				) {
					void stop(ctx).catch((error: unknown) => {
						if (opening === generation) report(ctx, error);
					});
					return;
				}
				const action = actions.find(([key]) => keys.matches(data, key));
				if (!completing && !dialogCount && !interactions?.hasDialog && action) {
					pi.sendUserMessage(`/leverage ${action[1]}`, {
						expandPromptTemplates: true,
					});
					return;
				}
				if (matchesKey(data, "enter")) {
					const text = editor.getText().trim();
					const aliases: Record<string, string> = {
						"/model": "model",
						"/resume": "sessions",
						"/new": "new",
						"/compact": "compact",
					};
					const [command, ...args] = text.split(/\s+/);
					if (command && aliases[command])
						editor.setText(
							`/leverage ${aliases[command]} ${args.join(" ")}`.trim(),
						);
				}
				handleInput(data);
			};
			return editor;
		});
		ctx.ui.setHeader((_tui, theme) => ({
			invalidate() {},
			render: (width) => [
				"",
				truncateToWidth(
					` ${theme.bold(theme.fg("accent", "◆ Leverage"))}${theme.fg("dim", stripVTControlCharacters(connection ? `  ${connection.workspace}` : ""))}`,
					width,
				),
			],
		}));
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render: (width) => {
				const state = theme.fg(
					streamState === "live"
						? "success"
						: streamState === "disconnected"
							? "error"
							: "warning",
					`● ${streamState}`,
				);
				const place = truncateToWidth(
					theme.fg(
						"dim",
						stripVTControlCharacters(
							[connection?.workspace ?? "Leverage", model]
								.filter(Boolean)
								.join(" · "),
						),
					),
					Math.max(0, width - visibleWidth(state) - 2),
				);
				return [
					truncateToWidth(
						`${place}${" ".repeat(Math.max(2, width - visibleWidth(place) - visibleWidth(state)))}${state}`,
						width,
					),
				];
			},
		}));
		try {
			const link = sessionLink(ctx.sessionManager.getBranch());
			connection = settings(link);
			composerKey = `${connection.host}/${connection.workspace}/${link?.sessionId ?? (event.reason !== "new" ? connection.sessionId : undefined) ?? ctx.sessionManager.getSessionId()}`;
			const savedComposer = composerDrafts.get(composerKey);
			ctx.ui.setEditorText(savedComposer ?? "");
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
					const localConversation = ctx.sessionManager
						.getBranch()
						.some(
							(entry) =>
								entry.type === "message" &&
								(entry.message.role === "user" ||
									entry.message.role === "assistant"),
						);
					if (localConversation)
						pi.sendUserMessage(`/leverage open ${session.id}`, {
							expandPromptTemplates: true,
						});
					else await attach(session, ctx);
				}
			} else {
				const nativeSocket = await workspace.socket(lifetime.signal);
				const unstate = nativeSocket.onState((state) => {
					if (opening === generation) {
						streamState = state;
						status(ctx);
					}
				});
				lifetime.signal.addEventListener("abort", unstate, { once: true });
				void nativeSocket.connect().catch((error) => {
					if (opening === generation) report(ctx, error);
				});
				const overrides = nextDraft;
				nextDraft = undefined;
				const loaded: SessionDraft = { ...workspace.draft(), ...overrides };
				draftLoading = (async () => {
					const channels =
						loaded.context.type === "channel" || connection?.directory
							? await workspace!.channels(lifetime.signal)
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
			}
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
			await compact(ctx);
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
			writable();
			const { client, session } = requireSession();
			terminal ??= new RemoteWorkspace(
				{ ...connection!, sessionId: session.id },
				client,
			);
			return terminal;
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
				const text = words.join(" ");
				if (action === "stop") {
					await stop(ctx);
					return;
				}
				if (action === "retry") {
					if (pendingCreation && draft) {
						await createAndSend(pendingCreation, ctx);
						return;
					}
					if (!failedPrompt)
						throw new Error("There is no unconfirmed message to retry.");
					await send(failedPrompt, ctx);
					return;
				}
				if (action === "queue") {
					if (!text) throw new Error("Use /leverage queue <message>.");
					await submit({ text }, ctx, "queue");
					return;
				}
				if (action === "compact") {
					await compact(ctx);
					return;
				}
				if (action === "status") {
					ctx.ui.notify(
						stripVTControlCharacters(
							selected
								? `${selected.title || selected.id}\n${selected.location.directory}\n${selected.id}\n${model} · ${running ? "working" : "idle"} · ${streamState}`
								: failure,
						),
						"info",
					);
					return;
				}
				const client = ensureApi();
				if (action === "new") {
					nextDraft = { ...(text ? { title: text } : {}) };
					const result = await ctx.newSession();
					if (result.cancelled) nextDraft = undefined;
					return;
				}
				if (action === "settings" || (action === "model" && !selected)) {
					const section =
						action === "model"
							? "model"
							: SETTING_SECTIONS.find((one) => one === words[0]);
					if (!selected) {
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
					} else {
						// An open session has no context to change, so F1 shows its details.
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
													detail: model,
												},
												{ value: "info", label: "Session details" },
											],
											lifetime.signal,
										);
						if (picked === "model") await interactions!.show("model");
						if (picked === "info")
							await textDrawer(
								ctx,
								"Session details",
								() =>
									[
										selected?.title || "Untitled session",
										selected?.location.directory,
										selected?.id,
										model,
									]
										.filter(Boolean)
										.join("\n"),
								lifetime.signal,
							);
					}
					return;
				}
				if (
					action === "approvals" ||
					action === "questions" ||
					action === "inbox" ||
					action === "model"
				) {
					requireSession();
					await interactions!.show(action);
					return;
				}
				if (action === "history") {
					const { session, signal } = requireSession();
					await viewRemoteHistory(client, ctx, session, signal, {
						messages: (await workspace!.bootstrap(session.id, signal)).messages,
						members: shared?.members ?? [],
						viewerId: shared?.userId,
					});
					return;
				}
				if (
					action === "rename" ||
					action === "archive" ||
					action === "restore"
				) {
					writable();
					const { session, signal } = requireSession();
					if (action === "rename") {
						if (!text) throw new Error("Use /leverage rename <title>.");
						await client.rename(session.id, text, signal);
					} else {
						let directory = `/${connection!.workspace}/.archive`;
						if (action === "restore") {
							if (!ctx.hasUI && !text)
								throw new Error("Use /leverage restore /workspace/channel.");
							const folder =
								text ||
								(await ctx.ui.select(
									"Restore to original folder",
									await client.folders(signal),
									{ signal },
								));
							if (!folder || signal.aborted) return;
							directory = folder;
						}
						await client.archive(session.id, directory, signal);
					}
					selected = await client.get(session.id, signal);
					pi.setSessionName(selected.title || "Leverage session");
					status(ctx);
					return;
				}
				let session: SessionInfo | undefined;
				if (action === "open") {
					if (!words[0]) throw new Error("Use /leverage open <session-id>.");
					session = await client.get(words[0], lifetime.signal);
				} else if (action === "sessions") {
					const picked = await sessionsDrawer(
						workspace!,
						ctx,
						lifetime.signal,
						text,
					);
					if (picked === "new") {
						await ctx.newSession();
						return;
					}
					if (picked)
						session = await client.get(`ses_${picked}`, lifetime.signal);
				} else
					throw new Error(
						"Use /leverage sessions, new, open, history, stop, queue, approvals, questions, inbox, model, compact, rename, archive, or restore.",
					);
				if (session && opening === generation) await switchTo(session, ctx);
			} catch (error) {
				if (opening === generation) report(ctx, error);
			} finally {
				dialogCount--;
			}
		},
	});
	for (const [key, action] of [
		["f1", "settings context"],
		["f2", "settings model"],
		["f3", "sessions"],
		["f4", "approvals"],
	] as const)
		pi.registerShortcut(key, {
			description: `Leverage ${action}`,
			handler: async () => {
				if (!dialogCount && !interactions?.hasDialog)
					pi.sendUserMessage(`/leverage ${action}`, {
						expandPromptTemplates: true,
					});
			},
		});
}
