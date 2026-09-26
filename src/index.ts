import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, Text } from "@earendil-works/pi-tui";
import {
	type LeverageConnection,
	type PromptFile,
	SessionClient,
	type SessionInfo,
} from "./api";
import { resolveConnection } from "./config";
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
	newRemoteSession,
	pickRemoteSession,
	type SessionLink,
	sameSession,
	sessionLink,
	viewRemoteHistory,
} from "./session-ui";

type Prompt = {
	id: string;
	text: string;
	files?: PromptFile[];
	delivery: "steer" | "queue";
};

export default function leverage(pi: ExtensionAPI): void {
	for (const [name, description] of Object.entries({
		host: "Leverage server origin",
		workspace: "Leverage workspace slug",
		session: "Leverage session to open; otherwise show the session picker",
		directory:
			"Workspace or channel folder for the session picker and new sessions",
		cwd: "Remote working directory for manual shell commands",
	}))
		pi.registerFlag(`leverage-${name}`, { type: "string", description });

	let api: SessionClient | undefined;
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
	let model = "Session model";
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
					: "Leverage: disconnected",
			),
		);
		ctx.ui.setWidget(
			"leverage-session",
			selected
				? [
						stripVTControlCharacters(
							`${selected.title || selected.id} · ${!ready ? "Connecting" : running ? "Working · Esc or /leverage stop" : "Ready"}`,
						),
						...(failedPrompt
							? [
									"Send not confirmed. /leverage retry sends the same message ID.",
								]
							: []),
					]
				: undefined,
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
		for (const entry of changes) {
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
		model = "Session model";
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
		if (!api) {
			connection = settings();
			lifetime = new AbortController();
			api = new SessionClient(connection);
		}
		return api;
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
		const signal = lifetime.signal;
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
				if (opening !== generation) return;
				display(projection.merge(page.data, load), ctx);
				display(projection.inbox(inbox), ctx);
				if (activity === activityVersion)
					running = !!active[projection.sessionId];
				status(ctx);
			} while (refreshRequested);
		})().finally(() => {
			if (opening === generation) refresh = undefined;
		});
		return refresh;
	};
	const stop = async (ctx: ExtensionContext) => {
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
		const signal = lifetime.signal;
		selected = session;
		history = new SharedHistory(session.id);
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
		interactions = new PendingInteractions(client, ctx, session.id, signal);
		if (!sessionLink(ctx.sessionManager.getBranch()))
			pi.appendEntry(LINK_ENTRY, linkFor(session));
		pi.setSessionName(session.title || "Leverage session");
		streamState = "connecting";
		status(ctx);
		const completeAttach = () => {
			if (opening !== generation || streamFailed || ready) return;
			ready = true;
			failure = "Choose a Leverage session with /leverage.";
			void client.markRead(session.id, signal).catch(() => {});
			status(ctx);
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
					if (opening !== generation) return;
					streamState = state === "connected" ? "live" : "reconnecting";
					status(ctx);
					if (state === "connected") repair();
				},
				onEvent(event) {
					if (opening !== generation || !history) return;
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
				if (opening !== generation) return;
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
		await send(
			{
				id: `msg_${randomUUID()}`,
				text: event.text,
				...(files?.length ? { files } : {}),
				delivery,
			},
			ctx,
		);
	};
	const compact = async (ctx: ExtensionContext) => {
		const { client, session, signal } = requireSession();
		await client.compact(session.id, `msg_${randomUUID()}`, signal);
		ctx.ui.notify("Compaction requested for the shared session.", "info");
	};

	pi.registerEntryRenderer<Pick<HistoryEntry, "sessionId" | "id">>(
		HISTORY_ENTRY,
		(entry, options) =>
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
	pi.on("session_start", async (event, ctx) => {
		disconnect();
		lifetime = new AbortController();
		const opening = generation;
		pi.setActiveTools([]);
		const previousEditor = ctx.ui.getEditorComponent();
		ctx.ui.setEditorComponent((tui, theme, keys) => {
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
		ctx.ui.setHeader(
			(_tui, theme) =>
				new Text(
					theme.fg(
						"accent",
						"Leverage · /leverage sessions · /leverage new · /leverage model",
					),
					1,
					1,
				),
		);
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render: (width) =>
				new Text(
					theme.fg(
						"dim",
						stripVTControlCharacters(
							`${connection?.workspace ?? "Leverage"} · ${model} · ${streamState}`,
						),
					),
					0,
					0,
				).render(width),
		}));
		try {
			const link = sessionLink(ctx.sessionManager.getBranch());
			connection = settings(link);
			if (
				link &&
				(link.host !== connection.host ||
					link.workspace !== connection.workspace)
			)
				throw new Error(
					"This view belongs to another workspace. Use /leverage to choose a session.",
				);
			api = new SessionClient(connection);
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
			} else if (ctx.hasUI) {
				dialogCount++;
				try {
					const session = await pickRemoteSession(api, ctx, {
						workspace: connection.workspace,
						directory: connection.directory,
						signal: lifetime.signal,
					});
					if (session && opening === generation)
						pi.sendUserMessage(`/leverage open ${session.id}`, {
							expandPromptTemplates: true,
						});
				} finally {
					dialogCount--;
				}
			} else ctx.ui.notify(failure, "info");
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
			"Sessions, new, open, history, stop, queue, approvals, questions, inbox, model, compact, rename, archive",
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
				const client = ensureApi();
				if (action === "history") {
					const { session, signal } = requireSession();
					await viewRemoteHistory(client, ctx, session, signal);
					return;
				}
				if (
					action === "rename" ||
					action === "archive" ||
					action === "restore"
				) {
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
				const options = {
					workspace: connection!.workspace,
					directory: connection!.directory,
					signal: lifetime.signal,
				};
				let session: SessionInfo | undefined;
				if (action === "new")
					session = await newRemoteSession(client, ctx, {
						...options,
						title: text,
					});
				else if (action === "open") {
					if (!words[0]) throw new Error("Use /leverage open <session-id>.");
					session = await client.get(words[0], lifetime.signal);
				} else if (action === "sessions")
					session = await pickRemoteSession(client, ctx, {
						...options,
						search: text,
					});
				else
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
}
