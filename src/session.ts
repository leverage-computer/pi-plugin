import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text, type TUI } from "@earendil-works/pi-tui";
import { z } from "zod";
import { api, sameSessionId } from "./api";
import { clean, drawerContext, report } from "./drawers";
import { type ModelChoice, PendingInteractions } from "./interactions";
import { createEntryComponent, entryText, type Shown } from "./render";
import { workspace } from "./workspace/api";
import type {
  SessionInput,
  WorkspaceMember,
  WorkspaceSession,
} from "./workspace/schema";
import {
  EntryFold,
  entryData,
  messageOf,
  type SessionDoc,
  SessionReplica,
  type SessionView as View,
} from "./workspace/view";

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
export const HISTORY_ENTRY = "leverage-history";

// The custom Pi entry that ties a local view to one Leverage session.
export const sessionLinkSchema = z.object({
  version: z.literal(1),
  host: z.string(),
  workspace: z.string(),
  sessionId: z.string(),
});

export type SessionLink = z.infer<typeof sessionLinkSchema>;

// Pi keeps one marker per displayed entry. The entry itself lives in the view.
export const historyMarkerSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
});

export type HistoryMarker = z.infer<typeof historyMarkerSchema>;

// Images Pi can draw, and the most it reads for one.
const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// A transcript position past any real one, so the first page is the newest.
const NEWEST = 2 ** 31 - 1;

/** A terminal for components drawn outside Pi's screen, such as a printed transcript. */
export const NO_TERMINAL = { requestRender() {} } as unknown as TUI;

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

// Tool results show inside their call's card, so they get no marker of their own.
function marked(entry: View["entries"][number]): boolean {
  return entry.kind !== "pi.tool-result";
}

// The result entries of a view, by the call each one answers.
function resultsOf(entries: View["entries"]) {
  return new Map(
    entries.flatMap((entry) => {
      const message = messageOf(entry);
      return message?.role === "toolResult"
        ? [[message.toolCallId, entry] as const]
        : [];
    }),
  );
}

function callOf(entry: View["entries"][number]) {
  const message = messageOf(entry);
  return message?.role === "assistant"
    ? message.content.find((block) => block.type === "toolCall")
    : undefined;
}

export async function viewRemoteHistory(
  ctx: ExtensionContext,
  session: WorkspaceSession,
  signal: AbortSignal,
  attribution?: {
    messages: SessionInput[];
    members: readonly WorkspaceMember[];
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
    // One page of history is a view of its own, folded the same way.
    const fold = new EntryFold(session.id);
    const members = attribution?.members ?? [];
    const viewerId = attribution?.viewerId;
    if (attribution) {
      fold.messages(
        attribution.messages.filter((one) => one.status === "consumed"),
      );
    }
    fold.apply(page.events);
    const entries = fold.current().filter(marked);
    const results = resultsOf(fold.current());
    const shown = (entry: View["entries"][number]): Shown => {
      const call = callOf(entry);
      const result = call ? results.get(call.id) : undefined;
      return {
        entry,
        ...(result ? { result } : {}),
        members,
        ...(viewerId ? { viewerId } : {}),
        images: new Map(),
      };
    };
    const content =
      entries
        .map((entry) => entryText(entry, members, viewerId))
        .filter(Boolean)
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
        for (const entry of entries) {
          const one = shown(entry);
          text.addChild(
            createEntryComponent(() => one, true, theme, tui, process.cwd()),
          );
        }
        if (!entries.length) {
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

/**
 * One Leverage session that this Pi view shows. It attaches to the replica
 * and renders each revision: a Pi marker per new entry, the live cards, and
 * the lines around the composer.
 */
export class SessionView {
  readonly replica: SessionReplica;
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
  // Attached images read from Leverage, by address. A new map per image, so
  // a card sees the change.
  private images: ReadonlyMap<string, string> = new Map();
  private readonly fetching = new Set<string>();
  // The entries of the revision last rendered, by key and by the call they answer.
  private byKey = new Map<string, View["entries"][number]>();
  private results = new Map<string, View["entries"][number]>();
  private readonly shown = new Map<string, Shown>();
  private rendered?: View["entries"];
  private readonly unsubscribe: () => void;
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
    this.replica = new SessionReplica(session.id, (error) => {
      if (!this.signal.aborted) {
        report(ctx, error);
      }
    });
    this.unsubscribe = this.replica.state.subscribe((value) =>
      this.render(value),
    );
  }

  /** The view as this client last saw it. */
  get view(): View {
    return this.replica.value;
  }

  /** Leverage's session document: the row, access, members and skills. */
  get doc(): SessionDoc {
    return this.replica.doc;
  }

  /**
   * One marked entry as Pi should draw it now, with its result and live
   * output. The same object comes back while nothing about it changed, so a
   * card can tell a redraw from a change.
   */
  show(id: string): Shown | undefined {
    const entry = this.byKey.get(id);
    if (!entry) {
      return undefined;
    }
    const call = callOf(entry);
    const doc = this.doc;
    const result = call ? this.results.get(call.id) : undefined;
    const slot = call
      ? this.view.docs["pi.live"]?.tools?.find((one) => one.callId === call.id)
      : undefined;
    const last = this.shown.get(id);
    if (
      last &&
      last.entry === entry &&
      last.result === result &&
      last.slot === slot &&
      last.members === doc.members &&
      last.viewerId === doc.userId &&
      last.images === this.images
    ) {
      return last;
    }
    const next: Shown = {
      entry,
      ...(result ? { result } : {}),
      ...(slot ? { slot } : {}),
      members: doc.members,
      ...(doc.userId ? { viewerId: doc.userId } : {}),
      images: this.images,
    };
    this.shown.set(id, next);
    return next;
  }

  get writable(): boolean {
    const { canWrite, revoked } = this.doc;
    return canWrite && !revoked;
  }

  get running(): boolean {
    return this.view.docs["pi.live"]?.run !== undefined;
  }

  /** The connection state the footer shows. */
  get stream(): string {
    if (this.problem) {
      return "disconnected";
    }
    return this.doc.connection;
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
      this.replica,
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
    await this.replica.start(signal);
    this.complete();
  }

  /** Reads the session again. */
  sync(): Promise<void> {
    return this.replica.refresh();
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
      this.replica.remember(input);
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
    this.unsubscribe();
    this.interactions?.close();
    this.replica.close();
  }

  /**
   * Shows one revision of the view. Every Pi-side effect comes from the
   * value alone, so a revision rendered twice changes nothing the second time.
   */
  private render(view: View): void {
    if (this.signal.aborted) {
      return;
    }
    const doc = view.docs["leverage.session"];
    if (doc.revoked) {
      this.revoked();
      return;
    }
    if (doc.session) {
      if (doc.session.title && doc.session.title !== this.session.title) {
        this.pi.setSessionName(doc.session.title);
      }
      this.session = doc.session;
    }
    if (view.entries !== this.rendered) {
      this.rendered = view.entries;
      this.byKey = new Map(
        view.entries.map((entry) => [entryData(entry).key, entry]),
      );
      this.results = resultsOf(view.entries);
      this.display(view.entries);
      this.fetchImages(view.entries);
    }
    this.interactions?.sync();
    this.complete();
    this.hooks.changed();
  }

  // Access is gone. The view stops taking input and the cards leave with it.
  private revoked(): void {
    if (this.closed || this.problem) {
      return;
    }
    this.ready = false;
    this.byKey = new Map();
    this.results = new Map();
    this.shown.clear();
    this.rendered = undefined;
    this.interactions?.close();
    this.hooks.revoked();
    this.lose(
      "Session access was removed. Use /leverage sessions to open another session.",
    );
  }

  // The first successful read opens the view, even one after a failed start.
  private complete(): void {
    if (this.ready || this.closed || this.problem) {
      return;
    }
    if (!this.interactions || !this.doc.session) {
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
  private fetchImages(entries: View["entries"]): void {
    for (const entry of entries) {
      for (const file of entryData(entry).attachments ?? []) {
        const uri = file.url;
        if (!uri || !IMAGE_TYPE.test(file.contentType)) {
          continue;
        }
        if (!uri.startsWith("/api/") || this.fetching.has(uri)) {
          continue;
        }
        this.fetching.add(uri);
        void api
          .bytes(`${uri}?display=1`, this.signal, MAX_IMAGE_BYTES)
          .then(({ data }) => {
            if (this.signal.aborted) {
              return;
            }
            this.images = new Map(this.images).set(
              uri,
              Buffer.from(data).toString("base64"),
            );
            this.hooks.changed();
          })
          .catch(() => {
            // The card keeps its file name when the image cannot be read.
          });
      }
    }
  }

  // Adds a Pi entry for each entry not shown yet. The Pi entry renders the live card.
  private display(entries: View["entries"]): void {
    for (const entry of entries) {
      if (!marked(entry)) {
        continue;
      }
      const { key } = entryData(entry);
      if (this.displayed.has(key)) {
        continue;
      }
      this.displayed.add(key);
      this.pi.appendEntry<HistoryMarker>(HISTORY_ENTRY, {
        sessionId: this.session.id,
        id: key,
      });
    }
  }

  private lose(problem: string): void {
    this.problem = problem;
    this.ctx.ui.notify(problem, "warning");
    this.hooks.changed();
  }
}
