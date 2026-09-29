import { randomUUID } from "node:crypto";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PromptFile, SessionClient, SessionInfo } from "./api";
import { drawerContext, report } from "./drawers";
import { HISTORY_ENTRY, type HistoryEntry, SharedHistory } from "./history";
import { PendingInteractions } from "./interactions";
import type { RemoteWorkspace } from "./remote";
import { LINK_ENTRY, type SessionLink, sessionLink } from "./session-ui";
import type { WorkspaceClient } from "./workspace/api";
import { SharedSession } from "./workspace/state";

export type Prompt = {
	id: string;
	text: string;
	files?: PromptFile[];
	delivery: "steer" | "queue";
};

// After these events, a new read gives the settled transcript, inbox and approvals.
const SETTLED = new Set([
	"session.execution.succeeded",
	"session.execution.failed",
	"session.execution.interrupted",
	"session.compaction.ended",
	"session.compaction.failed",
	"session.shell.ended",
	"session.inbox.delivered",
	"session.inbox.cancelled",
]);

export interface ViewHooks {
	// The status lines and footer need a redraw.
	changed(): void;
	// The first read is complete, so Pi shows the conversation from the top.
	opened(): void;
	// The server removed access, so the connection must start again.
	revoked(): void;
}

/** One Leverage session that this Pi view shows. */
export class SessionView {
	// Access removal clears the shown conversation.
	history?: SharedHistory;
	readonly shared: SharedSession;
	interactions?: PendingInteractions;
	terminal?: RemoteWorkspace;
	ready = false;
	running = false;
	stream = "connecting";
	model = "";
	// Why the view cannot take input, after a lost connection or access.
	problem?: string;
	failedPrompt?: Prompt;
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly displayed = new Set<string>();
	private closed = false;
	private sending = false;
	private stopping = false;
	private streamFailed = false;
	// Live status events are newer than a read that started before them.
	private activity = 0;
	private refreshing?: Promise<void>;
	private refreshAgain = false;

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly ctx: ExtensionContext,
		private readonly client: SessionClient,
		workspace: WorkspaceClient,
		public session: SessionInfo,
		lifetime: AbortSignal,
		private readonly hooks: ViewHooks,
	) {
		this.signal = AbortSignal.any([lifetime, this.controller.signal]);
		this.history = new SharedHistory(session.id);
		this.shared = new SharedSession(
			workspace,
			session.id,
			() => {
				if (this.signal.aborted) return;
				const { shared } = this;
				this.display(
					this.history?.attribute(
						shared.messages.values(),
						shared.members,
						shared.userId,
					) ?? [],
				);
				if (shared.session)
					this.model = `${shared.session.model ?? shared.session.providerFamily}${shared.session.reasoningEffort ? ` • ${shared.session.reasoningEffort}` : ""}`;
				this.interactions?.permissionsChanged();
				this.hooks.changed();
			},
			(error) => {
				if (!this.signal.aborted) report(ctx, error);
			},
			() => {
				if (this.closed) return;
				this.ready = false;
				this.history = undefined;
				this.interactions?.close();
				this.hooks.revoked();
				this.lose(
					"Session access was removed. Use /leverage sessions to open another session.",
				);
			},
		);
	}

	get writable(): boolean {
		return this.shared.canWrite && !this.shared.revoked;
	}

	// Reads the session, then follows its live events until the view closes.
	async open(link: SessionLink): Promise<void> {
		const { ctx, client, session, signal } = this;
		await this.shared.start(signal);
		if (signal.aborted) return;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== HISTORY_ENTRY)
				continue;
			const marker = entry.data as
				| { sessionId?: unknown; id?: unknown }
				| undefined;
			if (marker?.sessionId === session.id && typeof marker.id === "string")
				this.displayed.add(marker.id);
		}
		this.interactions = new PendingInteractions(
			client,
			ctx.mode === "tui" ? drawerContext(ctx) : ctx,
			session.id,
			signal,
			() => this.writable,
			() => this.hooks.changed(),
		);
		if (!sessionLink(ctx.sessionManager.getBranch()))
			this.pi.appendEntry(LINK_ENTRY, link);
		this.pi.setSessionName(session.title || "Leverage session");
		this.stream = "connecting";
		this.hooks.changed();
		const initialSync = this.sync();
		// A reconnect or a settled turn reads the session again.
		const repair = () => {
			const pending = this.sync();
			if (pending === initialSync) return;
			void pending
				.then(() => this.complete())
				.catch((error: unknown) => {
					if (!this.closed) report(ctx, error);
				});
		};
		void client
			.events({
				signal,
				onConnection: (state) => {
					if (signal.aborted) return;
					this.stream = state === "connected" ? "live" : "reconnecting";
					this.hooks.changed();
					if (state === "connected") repair();
				},
				onEvent: (event) => {
					if (signal.aborted || !this.history) return;
					this.interactions?.apply(event);
					if (
						!("sessionID" in event.data) ||
						event.data.sessionID !== session.id
					)
						return;
					this.display(this.history.apply(event));
					if (event.type === "session.status") {
						this.activity++;
						this.running = event.data.status.type !== "idle";
					} else if (event.type === "session.execution.started") {
						this.activity++;
						this.running = true;
					} else if (event.type === "session.renamed") {
						this.session = { ...this.session, title: event.data.title };
						this.pi.setSessionName(event.data.title);
					} else if (event.type === "session.model.selected") {
						this.model = `${event.data.model.id}${event.data.model.variant ? ` • ${event.data.model.variant}` : ""}`;
					} else if (event.type === "session.deleted") {
						this.ready = false;
						this.streamFailed = true;
						this.interactions?.close();
						this.lose(
							"This session is no longer available. Choose another with /leverage.",
						);
					}
					if (SETTLED.has(event.type)) repair();
					this.hooks.changed();
				},
			})
			.catch((error: unknown) => {
				if (signal.aborted) return;
				this.streamFailed = true;
				this.ready = false;
				this.interactions?.close();
				this.stream = "disconnected";
				this.problem =
					"The live connection failed. Reopen this session with /leverage.";
				this.hooks.changed();
				report(ctx, error);
			});
		await initialSync;
		this.complete();
	}

	// Reads the transcript, inbox and running state. Calls during a read share it.
	sync(): Promise<void> {
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		const { client, signal } = this;
		const projection = this.history;
		if (!projection) return Promise.resolve();
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				const load = projection.beginLoad();
				const activity = this.activity;
				const [page, active, inbox] = await Promise.all([
					client.history(projection.sessionId, {
						order: "desc",
						limit: 100,
						signal,
					}),
					client.active(signal),
					client.inbox(projection.sessionId, signal),
					this.interactions?.refresh(),
				]);
				if (signal.aborted) return;
				this.display(projection.merge(page.data, load));
				this.display(projection.inbox(inbox));
				if (activity === this.activity)
					this.running = !!active[projection.sessionId];
				this.hooks.changed();
			} while (this.refreshAgain);
		})().finally(() => {
			if (!signal.aborted) this.refreshing = undefined;
		});
		return this.refreshing;
	}

	async send(prompt: Prompt): Promise<void> {
		if (this.sending)
			throw new Error("Wait for the current message to be sent.");
		this.sending = true;
		try {
			const accepted = await this.client.prompt(
				this.session.id,
				prompt,
				this.signal,
			);
			if (this.closed) return;
			if (this.failedPrompt?.id === prompt.id) this.failedPrompt = undefined;
			this.display(this.history?.inbox([accepted]) ?? []);
			void this.sync().catch((error: unknown) => {
				if (!this.signal.aborted) report(this.ctx, error);
			});
		} catch (error) {
			if (!this.closed) this.failedPrompt = prompt;
			throw error;
		} finally {
			if (!this.closed) {
				this.sending = false;
				this.hooks.changed();
			}
		}
	}

	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		try {
			await this.client.interrupt(this.session.id, this.signal);
			this.ctx.ui.notify("Stop requested for the shared session.", "info");
			await this.sync();
		} finally {
			if (!this.signal.aborted) this.stopping = false;
		}
	}

	async compact(): Promise<void> {
		await this.client.compact(
			this.session.id,
			`msg_${randomUUID()}`,
			this.signal,
		);
		this.ctx.ui.notify("Compaction requested for the shared session.", "info");
	}

	close(): void {
		this.closed = true;
		this.controller.abort();
		this.interactions?.close();
		this.shared.close();
		this.terminal?.close();
	}

	// Adds a Pi entry for each new message. The entry renders the live message.
	private display(changes: HistoryEntry[]): void {
		for (const entry of [...changes].sort((a, b) => a.created - b.created)) {
			if (this.displayed.has(entry.id)) continue;
			this.displayed.add(entry.id);
			this.pi.appendEntry(HISTORY_ENTRY, {
				sessionId: entry.sessionId,
				id: entry.id,
			});
		}
		if (changes.length) this.hooks.changed();
	}

	private complete(): void {
		if (this.signal.aborted || this.streamFailed || this.ready) return;
		this.ready = true;
		void this.client.markRead(this.session.id, this.signal).catch(() => {});
		this.hooks.changed();
		this.hooks.opened();
	}

	private lose(problem: string): void {
		this.problem = problem;
		this.ctx.ui.notify(problem, "warning");
		this.hooks.changed();
	}
}
