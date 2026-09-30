import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { z } from "zod";
import { api, sameSessionId } from "./api";
import { clean, drawerContext, report } from "./drawers";
import {
  createHistoryComponent,
  HISTORY_ENTRY,
  type HistoryEntry,
  type HistoryMarker,
  historyMarkerSchema,
  SharedHistory,
} from "./history";
import { type ModelChoice, PendingInteractions } from "./interactions";
import { workspace } from "./workspace/api";
import type {
  SessionInput,
  WorkspaceMember,
  WorkspaceSession,
} from "./workspace/schema";
import { SharedSession } from "./workspace/state";

/** A file pasted into the composer, as base64. */
export type PromptFile = {
  filename: string;
  contentType: string;
  data: string;
};

export type Prompt = {
  // The message's identity. A retry reuses it, so Leverage stores it once.
  id: string;
  text: string;
  files?: PromptFile[];
  // `send` steers the running turn. `queue` waits for a turn of its own.
  delivery: "send" | "queue";
};

export interface ViewHooks {
  // The status lines and footer need a redraw.
  changed(): void;
  // The first read is complete, so Pi shows the conversation from the top.
  opened(): void;
  // The server removed access, so the connection must start again.
  revoked(): void;
}

export const LINK_ENTRY = "leverage-session";
// Marks a Pi view that /leverage new opened, before its first prompt creates a session.
export const DRAFT_ENTRY = "leverage-draft";

// The custom Pi entry that ties a local view to one Leverage session.
export const sessionLinkSchema = z.object({
  version: z.literal(1),
  host: z.string(),
  workspace: z.string(),
  sessionId: z.string(),
});

export type SessionLink = z.infer<typeof sessionLinkSchema>;

// Images Pi can draw, and the most it reads for one.
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// A transcript position past any real one, so the first page is the newest.
const NEWEST = 2 ** 31 - 1;

/** The newest valid link in a Pi branch, if any. */
export function sessionLink(
  entries: readonly SessionEntry[],
): SessionLink | undefined {
  return entries
    .toReversed()
    .flatMap((entry) =>
      entry.type === "custom" && entry.customType === LINK_ENTRY
        ? [sessionLinkSchema.safeParse(entry.data)]
        : [],
    )
    .find((result) => result.success)?.data;
}

export function sameSession(one: SessionLink, other: SessionLink): boolean {
  return (
    one.host === other.host &&
    one.workspace === other.workspace &&
    sameSessionId(one.sessionId, other.sessionId)
  );
}

/** Where a session works: its channel folder, or the workspace itself. */
export async function placeOf(
  session: WorkspaceSession,
  signal?: AbortSignal,
): Promise<string> {
  const root = `/${api.connection.workspace}`;
  if (!session.channelId) {
    return root;
  }
  const channels = await workspace.channels(signal).catch(() => []);
  const channel = channels.find((one) => one.id === session.channelId);
  return channel?.name ? `${root}/${channel.name}` : root;
}

export async function viewRemoteHistory(
  ctx: ExtensionContext,
  session: WorkspaceSession,
  signal: AbortSignal,
  attribution?: {
    messages: SessionInput[];
    members: WorkspaceMember[];
    viewerId?: string;
  },
): Promise<void> {
  const befores: number[] = [NEWEST];
  let pageNumber = 0;
  while (!signal.aborted) {
    const page = await workspace.history(
      session.id,
      befores[pageNumber],
      signal,
      50,
    );
    if (signal.aborted) {
      return;
    }
    const projection = new SharedHistory(session.id);
    if (attribution) {
      projection.attribute(attribution.members, attribution.viewerId);
      projection.messages(
        attribution.messages.filter((one) => one.status === "consumed"),
      );
    }
    projection.apply(page.events);
    const content =
      projection
        .entries()
        .map((entry) => entry.content)
        .join("\n\n") || "This session has no messages yet.";
    if (ctx.mode !== "tui") {
      ctx.ui.notify(clean(content), "info");
      return;
    }
    const action = await ctx.ui.custom<"older" | "newer" | "close">(
      (tui, theme, _keys, done) => {
        let offset = 0;
        let maximum = 0;
        let height = 20;
        const abort = () => done("close");
        signal.addEventListener("abort", abort, { once: true });
        const text = new Container();
        for (const entry of projection.entries()) {
          text.addChild(createHistoryComponent(() => entry, true, theme));
        }
        if (!projection.entries().length) {
          text.addChild(new Text(content, 0, 0));
        }
        return {
          render(width) {
            const lines = text.render(width);
            height = Math.max(5, (process.stdout.rows || 24) - 5);
            maximum = Math.max(0, lines.length - height);
            offset = Math.min(offset, maximum);
            return [
              ...new Text(
                theme.fg(
                  "accent",
                  clean(
                    `${session.title || "Leverage history"} · Page ${pageNumber + 1}`,
                  ),
                ),
                0,
                0,
              ).render(width),
              ...lines.slice(offset, offset + height),
              ...new Text(
                theme.fg(
                  "dim",
                  `↑/↓ scroll · ${page.hasOlderEvents ? "n older · " : ""}${pageNumber ? "p newer · " : ""}Esc close`,
                ),
                0,
                0,
              ).render(width),
            ];
          },
          invalidate() {
            text.invalidate();
          },
          handleInput(data) {
            if (matchesKey(data, "escape")) {
              return done("close");
            }
            if (matchesKey(data, "enter")) {
              return done("close");
            }
            if (data === "n" && page.hasOlderEvents) {
              return done("older");
            }
            if (data === "p" && pageNumber) {
              return done("newer");
            }
            if (matchesKey(data, "up")) {
              offset = Math.max(0, offset - 1);
            }
            if (matchesKey(data, "down")) {
              offset = Math.min(maximum, offset + 1);
            }
            if (matchesKey(data, "pageUp")) {
              offset = Math.max(0, offset - height);
            }
            if (matchesKey(data, "pageDown")) {
              offset = Math.min(maximum, offset + height);
            }
            tui.requestRender();
          },
          dispose() {
            signal.removeEventListener("abort", abort);
          },
        };
      },
    );
    if (action === "close") {
      return;
    }
    if (signal.aborted) {
      return;
    }
    if (action === "older" && page.oldestTranscriptSeq !== null) {
      befores[++pageNumber] = page.oldestTranscriptSeq;
    } else if (action === "newer") {
      pageNumber -= 1;
    }
  }
}

/** One Leverage session that this Pi view shows. */
export class SessionView {
  readonly shared: SharedSession;
  interactions?: PendingInteractions;
  ready = false;
  // Why the view cannot take input, after a lost connection or access.
  problem?: string;
  failedPrompt?: Prompt;
  // The session's folder, for the footer.
  place = "";
  // A model picked for the next message. Leverage switches when it is sent.
  nextModel?: ModelChoice;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly displayed = new Set<string>();
  // Attached images already asked for, by address.
  private readonly images = new Set<string>();
  private closed = false;
  private sending = false;
  private stopping = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly ctx: ExtensionContext,
    public session: WorkspaceSession,
    lifetime: AbortSignal,
    private readonly hooks: ViewHooks,
  ) {
    this.signal = AbortSignal.any([lifetime, this.controller.signal]);
    this.shared = new SharedSession(session.id, {
      changed: (entries) => this.update(entries),
      failed: (error) => {
        if (!this.signal.aborted) {
          report(ctx, error);
        }
      },
      denied: () => {
        if (this.closed) {
          return;
        }
        this.ready = false;
        this.interactions?.close();
        this.hooks.revoked();
        this.lose(
          "Session access was removed. Use /leverage sessions to open another session.",
        );
      },
    });
  }

  /** The conversation, until access to it is removed. */
  get history(): SharedHistory | undefined {
    return this.shared.revoked ? undefined : this.shared.history;
  }

  get writable(): boolean {
    return this.shared.canWrite && !this.shared.revoked;
  }

  get running(): boolean {
    return this.shared.running;
  }

  /** The connection state the footer shows. */
  get stream(): string {
    if (this.problem) {
      return "disconnected";
    }
    return this.shared.connection;
  }

  get model(): string {
    const { model, reasoningEffort } = this.session;
    const current = `${model ?? this.session.providerFamily}${reasoningEffort ? ` • ${reasoningEffort}` : ""}`;
    const next = this.nextModel
      ? ` → ${this.nextModel.model}${this.nextModel.reasoningEffort ? ` • ${this.nextModel.reasoningEffort}` : ""}`
      : "";
    return `${current}${next}`;
  }

  // How full the model's context is, the way Pi's own footer says it.
  get usage(): string {
    const { contextUsedTokens: used, contextWindowTokens: window } =
      this.session;
    if (!used || !window) {
      return "";
    }
    const size =
      window >= 1000 ? `${Math.round(window / 1000)}k` : String(window);
    return `${((used / window) * 100).toFixed(1)}%/${size}`;
  }

  /** Reads the session, then follows it live until the view closes. */
  async open(link: SessionLink): Promise<void> {
    const { ctx, session, signal } = this;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") {
        continue;
      }
      if (entry.customType !== HISTORY_ENTRY) {
        continue;
      }
      const marker = historyMarkerSchema.safeParse(entry.data);
      if (marker.success && marker.data.sessionId === session.id) {
        this.displayed.add(marker.data.id);
      }
    }
    this.interactions = new PendingInteractions(
      ctx.mode === "tui" ? drawerContext(ctx) : ctx,
      this.shared,
      signal,
      () => this.writable,
      (choice) => {
        this.nextModel = choice;
        this.hooks.changed();
      },
    );
    if (!sessionLink(ctx.sessionManager.getBranch())) {
      this.pi.appendEntry(LINK_ENTRY, link);
    }
    this.pi.setSessionName(session.title || "Leverage session");
    this.hooks.changed();
    await this.shared.start(signal);
    this.complete();
  }

  /** Reads the session again. */
  sync(): Promise<void> {
    return this.shared.refresh();
  }

  async send(prompt: Prompt): Promise<void> {
    if (this.sending) {
      throw new Error("Wait for the current message to be sent.");
    }
    this.sending = true;
    try {
      const attachmentIds = await Promise.all(
        (prompt.files ?? []).map((file) =>
          workspace.upload(
            {
              filename: file.filename,
              contentType: file.contentType,
              bytes: Buffer.from(file.data, "base64"),
            },
            this.signal,
          ),
        ),
      );
      const next = this.nextModel;
      const input = await workspace.send(
        this.session.id,
        {
          clientRequestId: prompt.id,
          content: prompt.text,
          delivery: prompt.delivery,
          ...(attachmentIds.length ? { attachmentIds } : {}),
          ...(next ? { model: next.model } : {}),
          ...(next?.reasoningEffort
            ? { reasoningEffort: next.reasoningEffort }
            : {}),
        },
        this.signal,
      );
      if (this.closed) {
        return;
      }
      if (this.failedPrompt?.id === prompt.id) {
        this.failedPrompt = undefined;
      }
      if (this.nextModel === next) {
        this.nextModel = undefined;
      }
      this.shared.remember(input);
    } catch (error) {
      if (!this.closed) {
        this.failedPrompt = prompt;
      }
      throw error;
    } finally {
      if (!this.closed) {
        this.sending = false;
        this.hooks.changed();
      }
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    try {
      await workspace.stop(
        this.session.id,
        this.session.turnId ?? undefined,
        this.signal,
      );
      this.ctx.ui.notify("Stop requested for the shared session.", "info");
    } finally {
      if (!this.signal.aborted) {
        this.stopping = false;
      }
    }
  }

  async compact(): Promise<void> {
    await workspace.compact(this.session.id, this.signal);
    this.ctx.ui.notify("Compaction requested for the shared session.", "info");
  }

  close(): void {
    this.closed = true;
    this.controller.abort();
    this.interactions?.close();
    this.shared.close();
  }

  private update(entries: HistoryEntry[]): void {
    if (this.signal.aborted) {
      return;
    }
    const session = this.shared.session;
    if (session) {
      if (session.title && session.title !== this.session.title) {
        this.pi.setSessionName(session.title);
      }
      this.session = session;
    }
    this.display(entries);
    this.fetchImages(entries);
    this.interactions?.sync();
    this.complete();
    this.hooks.changed();
  }

  // The first successful read opens the view, even one after a failed start.
  private complete(): void {
    if (this.ready || this.closed || this.problem) {
      return;
    }
    if (!this.interactions || !this.shared.session) {
      return;
    }
    this.ready = true;
    void placeOf(this.session, this.signal).then((place) => {
      this.place = place;
      this.hooks.changed();
    });
    void workspace.markRead(this.session.id, this.signal);
    this.hooks.changed();
    this.hooks.opened();
  }

  // An attached image comes from Leverage once, then shows in its card.
  private fetchImages(entries: HistoryEntry[]): void {
    for (const entry of entries) {
      for (const part of entry.parts) {
        if (part.type !== "file" || part.data || !part.uri) {
          continue;
        }
        if (!IMAGE_TYPE.test(part.mime) || !part.uri.startsWith("/api/")) {
          continue;
        }
        if (this.images.has(part.uri)) {
          continue;
        }
        const uri = part.uri;
        this.images.add(uri);
        void api
          .bytes(`${uri}?display=1`, this.signal, MAX_IMAGE_BYTES)
          .then(({ data }) =>
            this.update(
              this.shared.history.fill(
                uri,
                Buffer.from(data).toString("base64"),
              ),
            ),
          )
          .catch(() => {
            // The card keeps its file name when the image cannot be read.
          });
      }
    }
  }

  // Adds a Pi entry for each new card. The entry renders the live card.
  private display(changes: HistoryEntry[]): void {
    const ordered = [...changes].sort((a, b) => a.created - b.created);
    for (const entry of ordered) {
      if (this.displayed.has(entry.id)) {
        continue;
      }
      this.displayed.add(entry.id);
      this.pi.appendEntry<HistoryMarker>(HISTORY_ENTRY, {
        sessionId: entry.sessionId,
        id: entry.id,
      });
    }
  }

  private lose(problem: string): void {
    this.problem = problem;
    this.ctx.ui.notify(problem, "warning");
    this.hooks.changed();
  }
}
