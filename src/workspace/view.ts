import {
  type Draft,
  type MutableReplicatedState,
  replicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
  AssistantMessage,
  JsonObject,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type {
  AgentState,
  ConversationView,
  InboxState,
  LiveState,
  ToolSlot,
} from "@earendil-works/pi-durable";
import { Match } from "effect";
import { z } from "zod";
import { toolTitleText } from "../tools";
import { workspace } from "./api";
import {
  type Attachment,
  askSchema,
  type Invocation,
  type PresenceEntry,
  type RowData,
  type SessionInput,
  type SessionViewer,
  type TranscriptDelta,
  type TranscriptEvent,
  type ViewerState,
  type WorkspaceEvent,
  type WorkspaceMember,
  type WorkspaceSession,
} from "./schema";
import type { SocketState, WorkspaceSocket } from "./socket";

/*
 * The session as Pi Durable would publish it: a conversation view with the
 * active entries and the built-in documents. Leverage does not serve one yet,
 * so this module builds it on the client from the socket's rows and frames.
 * When Leverage serves the view, this file shrinks to `applyImmutable`.
 */

const POLL_MS = 30_000;
const MAX_ENTRIES = 200;
const MAX_CHARACTERS = 32 * 1024 * 1024;
// Rows without a transcript position sort after every row that has one.
const UNPLACED = 1e15;
// The ids of entries, as a storage would assign them.
type EntryRecord = ConversationView["entries"][number];
type EntryId = EntryRecord["id"];
type ConversationId = EntryRecord["conversationId"];
type RunId = NonNullable<LiveState["run"]>["taskId"];
type ItemId = InboxState["items"][number]["id"];

// A 403 or 404 on the session means access is gone rather than the server.
const accessLost = z.object({
  status: z.union([z.literal(403), z.literal(404)]),
});

// Statuses in which the agent is busy with a turn.
const RUNNING = new Set(["active", "preparing", "stopping"]);
// Task statuses that mean a background command or agent has finished.
const SETTLED = new Set(["completed", "failed", "stopped", "killed", "error"]);
// Input statuses that mean the message has not reached the agent yet.
const WAITING = new Set([
  "queued",
  "releasing",
  "sending",
  "received",
  "rejected",
  "unknown",
  "withdrawn",
]);

export interface Skill {
  name: string;
  description: string;
}

/** What Leverage adds to the conversation: the session row and who may act. */
export interface SessionDoc {
  session?: WorkspaceSession;
  version: number;
  canWrite: boolean;
  // Leverage removed this person's access. The view stays empty from then on.
  revoked: boolean;
  connection: SocketState;
  userId?: string;
  members: WorkspaceMember[];
  // The skills the session's folder offers, from its first row.
  skills: Skill[];
  // Who has the session open, and whether they are watching it.
  viewers: Viewer[];
  // Who is typing a message to it right now, by user ID.
  typing: string[];
  // Who is online anywhere in the workspace, by user ID.
  presence: Record<string, PresenceEntry>;
}

/** A person with the session open. */
export interface Viewer {
  userId: string;
  userName: string;
  state: ViewerState;
}

/** What an entry carries besides its message: where it sits and who wrote it. */
export interface EntryData {
  // The row or message that owns the entry. A replayed row changes nothing.
  key: string;
  order: number;
  created: number;
  authorId?: string | null;
  authorName?: string;
  // A person's message: how far it got, and the app it was sent from.
  inputUuid?: string;
  status?: string;
  harness?: string | null;
  attachments?: Attachment[];
  // A sub-agent's work, one line per step.
  steps?: string[];
  // A background command or agent keeps running after its call returns.
  background?: boolean;
  // A note the conversation shows as text, such as a stop or an error.
  text?: string;
}

export interface SessionDocs {
  "pi.agent"?: AgentState;
  "pi.live"?: LiveState;
  "pi.inbox"?: InboxState;
  "leverage.session": SessionDoc;
  "leverage.approvals": { items: Invocation[] };
  // Questions the agent asked that nobody has answered yet.
  "leverage.asks": { items: TranscriptEvent[] };
}

/** One session's view: Pi Durable's shape, with Leverage's documents beside Pi's. */
export type SessionView = Omit<ConversationView, "docs"> & {
  readonly docs: Readonly<SessionDocs>;
};

const SESSION_DOC: SessionDoc = {
  version: -1,
  canWrite: false,
  revoked: false,
  connection: "connecting",
  members: [],
  skills: [],
  viewers: [],
  typing: [],
  presence: {},
};

// A viewer frame without a state means the person is watching.
function viewer(value: SessionViewer): Viewer {
  return {
    userId: value.userId,
    userName: value.userName,
    state: value.state ?? "active",
  };
}

function conversationId(value: number): ConversationId {
  return value as unknown as ConversationId;
}

function entryId(value: number): EntryId {
  return value as unknown as EntryId;
}

/** A JSON copy, so no `undefined` reaches the replicated state. */
function json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function entryData(entry: EntryRecord): EntryData {
  return entry.data as unknown as EntryData;
}

/** The first message of an entry, which is the one Pi renders. */
export function messageOf(entry: EntryRecord) {
  return entry.model?.[0];
}

export function userText(content: UserMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("");
}

/** The plan the agent asks someone to review, if the question is one. */
export function planOf(event: TranscriptEvent): string | undefined {
  return askSchema.parse(event.data.input).plan || undefined;
}

/** The questions the agent asked, with their answer options. */
export function questionsOf(event: TranscriptEvent): Array<{
  question: string;
  options: string[];
  multiSelect: boolean;
}> {
  const { questions } = askSchema.parse(event.data.input);
  return questions
    .filter((one) => one.question)
    .map((one) => ({
      question: one.question,
      options: one.options.map((option) => option.label).filter(Boolean),
      multiSelect: one.multiSelect,
    }));
}

// A streamed row is one message that grows. Its stream ID names it.
function streamKey(event: TranscriptEvent): string {
  const eventId = event.data.eventId;
  return eventId ? `${event.kind}:${eventId}` : `row:${event.id}`;
}

function toolKey(toolUseId: string, rowId: string): string {
  return toolUseId ? `tool:${toolUseId}` : `row:${rowId}`;
}

// The text a finished tool reported, or its raw result when it had none.
function toolOutput(data: RowData): string {
  if (data.content) {
    return data.content;
  }
  return data.result === undefined ? "" : JSON.stringify(data.result, null, 2);
}

function toolArguments(input: unknown): JsonObject {
  return input && typeof input === "object" && !Array.isArray(input)
    ? json(input as JsonObject)
    : {};
}

/**
 * Writes a streamed piece at its offset, so a replayed piece changes nothing.
 * A snapshot from the start is the whole text and always wins. Progress text
 * replaces itself; other streams grow.
 */
function place(existing: string, delta: TranscriptDelta): string {
  const snapshot = delta.snapshot;
  if (snapshot && (snapshot.startOffset ?? 0) === 0) {
    return snapshot.content;
  }
  if (delta.kind === "tool_progress") {
    return delta.delta;
  }
  if (delta.offset > existing.length) {
    return existing;
  }
  return (
    existing.slice(0, delta.offset) +
    delta.delta +
    existing.slice(delta.offset + delta.delta.length)
  );
}

// The plan tool, the question tool and the edit tools by their bare names.
function bareName(name: string): string {
  const last = name.split("__").pop()?.split(".").pop() ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const planInput = z.looseObject({ plan: z.string().catch("") }).catch({
  plan: "",
});
const writeInput = z
  .object({ file_path: z.string().catch(""), content: z.string().catch("") })
  .catch({ file_path: "", content: "" });

/** An assistant message as Leverage's rows describe it. Pi draws it like its own. */
function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  model: string,
  created: number,
  errorMessage?: string,
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "leverage",
    model,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: created,
  };
}

/**
 * Folds Leverage's rows, streamed pieces and people's messages into the
 * entries of a conversation view. The fold is the same for the live session
 * and for a page of its history.
 */
export class EntryFold {
  private entries: EntryRecord[] = [];
  private readonly inputs = new Map<string, SessionInput>();
  private readonly keyByRow = new Map<string, string>();
  // The Task call that started each sub-agent, by task ID.
  private readonly agentCalls = new Map<string, string>();
  // Background work still running, by the tool call that started it.
  private readonly running = new Set<string>();
  // The compaction entry waiting for its finished row.
  private compacting?: string;
  // The earliest transcript position loaded. Older messages belong to a
  // history page the conversation does not show.
  private oldestSeq?: number;
  private nextId = 1;
  private model = "leverage";
  // Grows with every change to the entries, so a view publishes only real ones.
  revision = 0;

  constructor(
    readonly sessionId: string,
    private readonly conversation: ConversationId = conversationId(0),
    private readonly limits: {
      maxEntries?: number;
      maxCharacters?: number;
    } = {},
  ) {}

  current(): readonly EntryRecord[] {
    return this.entries;
  }

  /** The model the session answers with, named on each assistant entry. */
  setModel(model: string | null | undefined): void {
    this.model = model || "leverage";
  }

  private find(key: string): EntryRecord | undefined {
    return this.entries.find((entry) => entryData(entry).key === key);
  }

  /**
   * Puts an entry at its place. A replaced entry keeps its ID, and one that
   * reads the same as before changes nothing.
   */
  private put(entry: EntryRecord): void {
    const key = entryData(entry).key;
    const index = this.entries.findIndex((one) => entryData(one).key === key);
    if (index >= 0) {
      const next = { ...entry, id: this.entries[index]!.id };
      if (JSON.stringify(next) === JSON.stringify(this.entries[index])) {
        return;
      }
      this.entries[index] = next;
      this.revision++;
      return;
    }
    this.entries.push(entry);
    this.entries.sort((a, b) => entryData(a).order - entryData(b).order);
    this.revision++;
  }

  private make(
    kind: string,
    data: EntryData,
    model?: EntryRecord["model"],
  ): EntryRecord {
    const existing = this.find(data.key);
    return {
      id: existing?.id ?? entryId(this.nextId++),
      conversationId: this.conversation,
      kind,
      ...(model ? { model } : {}),
      data: json(data) as unknown as EntryRecord["data"],
    };
  }

  // Where a row's entry sits, kept from an earlier row of the same entry.
  private placement(key: string, event: TranscriptEvent): EntryData {
    const existing = this.find(key);
    const created = Date.parse(event.createdAt) || 0;
    const data: EntryData = existing
      ? { ...entryData(existing) }
      : { key, order: event.transcriptSeq ?? UNPLACED + created, created };
    if (typeof event.transcriptSeq === "number" && data.order >= UNPLACED) {
      data.order = event.transcriptSeq;
    }
    return data;
  }

  /**
   * Records people's messages. One that has not reached the agent yet gets an
   * entry of its own, which its transcript row later takes over.
   */
  messages(inputs: readonly SessionInput[]): void {
    for (const input of inputs) {
      if (input.sessionId !== this.sessionId) {
        continue;
      }
      this.inputs.set(input.uuid, input);
      const key = `input:${input.uuid}`;
      const existing = this.find(key);
      if (!existing && !this.shows(input)) {
        continue;
      }
      const created = Date.parse(input.createdAt) || 0;
      const seq = input.consumedTranscriptSeq;
      const data: EntryData = existing
        ? { ...entryData(existing) }
        : { key, order: UNPLACED + created, created };
      // A message the agent took in sits right after where it did.
      if (typeof seq === "number" && data.order >= UNPLACED) {
        data.order = seq + 0.5;
      }
      this.put(this.person(data, input, existing));
    }
    while (this.inputs.size > 1000) {
      this.inputs.delete(this.inputs.keys().next().value!);
    }
    this.settle();
  }

  // A person's entry: their message as they wrote it, with its delivery state.
  private person(
    data: EntryData,
    input: SessionInput | undefined,
    existing?: EntryRecord,
  ): EntryRecord {
    const message = existing ? messageOf(existing) : undefined;
    const text = input
      ? input.content
      : message?.role === "user"
        ? userText(message.content)
        : "";
    const attachments = input?.attachments ?? data.attachments ?? [];
    const user: UserMessage = {
      role: "user",
      content: text,
      timestamp: data.created,
    };
    return this.make(
      "pi.user",
      {
        ...data,
        ...(input ? { inputUuid: input.uuid } : {}),
        ...(data.authorId !== undefined
          ? { authorId: data.authorId }
          : input?.authorId !== undefined
            ? { authorId: input.authorId }
            : {}),
        ...(input?.authorName ? { authorName: input.authorName } : {}),
        ...(input?.status ? { status: input.status } : {}),
        ...(input?.harness !== undefined ? { harness: input.harness } : {}),
        ...(attachments.length ? { attachments } : {}),
      },
      [user],
    );
  }

  // Whether a message gets an entry of its own before any row names it.
  private shows(input: SessionInput): boolean {
    if (input.kind === "compact") {
      return false;
    }
    if (input.status === "withdrawn") {
      return false;
    }
    if (input.status !== "consumed") {
      return true;
    }
    // A message taken in before the loaded rows belongs to an older page.
    const seq = input.consumedTranscriptSeq;
    if (this.oldestSeq === undefined) {
      return typeof seq === "number";
    }
    return typeof seq === "number" && seq >= this.oldestSeq;
  }

  /** Folds transcript rows in. Replaying a row changes nothing. */
  apply(events: readonly TranscriptEvent[], live?: Draft<LiveState>): void {
    const ordered = [...events].sort(
      (a, b) => (a.transcriptSeq ?? UNPLACED) - (b.transcriptSeq ?? UNPLACED),
    );
    for (const event of ordered) {
      if (event.sessionId !== this.sessionId) {
        continue;
      }
      if (typeof event.transcriptSeq === "number") {
        this.oldestSeq = Math.min(
          this.oldestSeq ?? event.transcriptSeq,
          event.transcriptSeq,
        );
      }
      this.fold(event, live);
    }
    this.settle();
  }

  /** Grows a streamed message or a running tool's output. */
  delta(delta: TranscriptDelta, live?: Draft<LiveState>): boolean {
    // A sub-agent's finished rows show as steps of its Task card.
    if (delta.parentToolUseId || delta.delegatedTaskId) {
      return false;
    }
    if (delta.kind === "text" || delta.kind === "reasoning") {
      return this.stream(delta, delta.kind);
    }
    // Live output of a running tool, shown until its result arrives.
    const slot = live?.tools?.find((one) => one.callId === delta.toolUseId);
    if (!slot || slot.status !== "running") {
      return false;
    }
    slot.output = place(slot.output ?? "", delta);
    return true;
  }

  // Each row kind updates one entry. Rows the conversation does not show are skipped.
  private fold(event: TranscriptEvent, live?: Draft<LiveState>): void {
    const data = event.data;
    // A sub-agent works inside its Task card, as it does in the web app.
    const parent =
      data.parentToolUseId || this.agentCalls.get(data.delegatedTaskId);
    if (parent && event.kind !== "task") {
      this.step(parent, event);
      return;
    }
    if (data.delegatedTaskId && event.kind !== "task") {
      return;
    }
    const created = Date.parse(event.createdAt) || 0;
    switch (event.kind) {
      // Messages that reached the agent together share one row. Each keeps
      // its own entry, and a later message fills in the text.
      case "user": {
        const uuids = event.sourceInputUuids?.length
          ? event.sourceInputUuids
          : [undefined];
        const answers = Object.entries(data.answers).map(
          ([question, answer]) => `${question}: ${String(answer)}`,
        );
        uuids.forEach((uuid, index) => {
          const key = uuid ? `input:${uuid}` : `row:${event.id}`;
          const input = uuid ? this.inputs.get(uuid) : undefined;
          const placed = this.placement(key, event);
          if (event.authorId !== undefined) {
            placed.authorId = event.authorId;
          }
          const existing = this.find(key);
          if (index === 0 && !input) {
            const user: UserMessage = {
              role: "user",
              content: data.content || answers.join("\n"),
              timestamp: created,
            };
            this.put(
              this.make(
                "pi.user",
                {
                  ...placed,
                  ...(data.attachments.length
                    ? { attachments: data.attachments }
                    : {}),
                },
                [user],
              ),
            );
            return;
          }
          this.put(this.person(placed, input, existing));
        });
        return;
      }
      case "text":
      case "reasoning": {
        const key = streamKey(event);
        const placed = this.placement(key, event);
        this.keyByRow.set(event.id, key);
        const existing = this.find(key);
        const message = existing ? messageOf(existing) : undefined;
        const current =
          message?.role === "assistant" ? message.content[0] : undefined;
        const existingText =
          current?.type === "text"
            ? current.text
            : current?.type === "thinking"
              ? current.thinking
              : "";
        const finalized = data.finalized;
        const wasFinal =
          message?.role === "assistant" && message.stopReason !== "pending";
        // A finished message wins; otherwise the longer one does, so streams never shrink.
        const keep =
          wasFinal && !finalized
            ? existingText
            : finalized || data.content.length >= existingText.length
              ? data.content
              : existingText;
        this.put(this.text(placed, event.kind, keep, wasFinal || finalized));
        return;
      }
      case "tool_call": {
        const callId = data.toolUseId || event.id;
        const key = toolKey(data.toolUseId, event.id);
        const placed = this.placement(key, event);
        const name = data.name || "tool";
        const input =
          bareName(name) === "exitplanmode"
            ? { ...toolArguments(data.input), plan: this.planText(data.input) }
            : toolArguments(data.input);
        this.put(
          this.make("pi.assistant", placed, [
            assistant(
              [{ type: "toolCall", id: callId, name, arguments: input }],
              "toolUse",
              this.model,
              placed.created,
            ),
          ]),
        );
        if (live && !this.find(`result:${callId}`)) {
          this.slot(live, callId, name).status = "running";
        }
        return;
      }
      case "tool_result": {
        const callId = data.toolUseId || event.id;
        const call = this.find(toolKey(data.toolUseId, event.id));
        const callMessage = call ? messageOf(call) : undefined;
        const named =
          callMessage?.role === "assistant" &&
          callMessage.content[0]?.type === "toolCall"
            ? callMessage.content[0].name
            : data.name || "tool";
        const failed = data.isError || data.is_error;
        // A background command returns at once and keeps running.
        const background = this.running.has(data.toolUseId);
        const placed = this.placement(`result:${callId}`, event);
        const result: ToolResultMessage = {
          role: "toolResult",
          toolCallId: callId,
          toolName: named,
          content: [{ type: "text", text: toolOutput(data) }],
          isError: failed,
          timestamp: placed.created,
        };
        this.put(
          this.make(
            "pi.tool-result",
            { ...placed, ...(background ? { background: true } : {}) },
            [result],
          ),
        );
        if (live) {
          this.finish(live, callId, background);
        }
        return;
      }
      // Background commands and sub-agents report as tasks until they settle.
      case "task": {
        if (data.taskId && data.toolUseId) {
          this.agentCalls.set(data.taskId, data.toolUseId);
        }
        if (!data.toolUseId) {
          return;
        }
        const settled = data.phase === "settled" || SETTLED.has(data.status);
        if (settled) {
          this.running.delete(data.toolUseId);
        } else if (data.backgrounded) {
          this.running.add(data.toolUseId);
        }
        const call = this.find(`tool:${data.toolUseId}`);
        if (!call) {
          return;
        }
        if (!settled && !data.backgrounded) {
          return;
        }
        const failed = data.status === "failed" || data.status === "error";
        const result = this.find(`result:${data.toolUseId}`);
        if (result) {
          const message = messageOf(result);
          if (message?.role === "toolResult") {
            this.put(
              this.make(
                "pi.tool-result",
                { ...entryData(result), background: true },
                [
                  {
                    ...message,
                    isError: settled ? failed : message.isError,
                  } as ToolResultMessage,
                ],
              ),
            );
          }
        }
        if (live) {
          if (settled) {
            this.finish(live, data.toolUseId, false);
          } else {
            const slot = this.slot(
              live,
              data.toolUseId,
              this.callName(call) ?? "tool",
            );
            slot.status = "running";
            slot.details = { background: true };
          }
        }
        return;
      }
      // The agent asks through a tool call. Its result is the answer.
      case "ask_user": {
        const callId = data.toolUseId || event.id;
        const key = `tool:${callId}`;
        const placed = this.placement(key, event);
        const name = planOf(event) ? "ExitPlanMode" : "AskUserQuestion";
        this.put(
          this.make("pi.assistant", placed, [
            assistant(
              [
                {
                  type: "toolCall",
                  id: callId,
                  name,
                  arguments: toolArguments(data.input),
                },
              ],
              "toolUse",
              this.model,
              placed.created,
            ),
          ]),
        );
        return;
      }
      case "error": {
        const placed = this.placement(`row:${event.id}`, event);
        this.put(
          this.make("pi.assistant", placed, [
            assistant(
              [],
              "error",
              this.model,
              placed.created,
              data.content || "The turn failed",
            ),
          ]),
        );
        return;
      }
      case "interrupted": {
        const placed = this.placement(`row:${event.id}`, event);
        const stopped =
          data.cause === "user_stop"
            ? { authorId: event.authorId ?? null, text: "Stopped by" }
            : { text: "Interrupted" };
        this.put(this.make("leverage.notice", { ...placed, ...stopped }));
        return;
      }
      // A compaction writes a started row, then a finished one that replaces it.
      // Tombstones are storage markers, not compactions.
      case "compaction": {
        if (data.tombstone) {
          return;
        }
        const started = data.phase === "started";
        const key =
          this.keyByRow.get(event.id) ??
          (started ? undefined : this.compacting) ??
          `row:${event.id}`;
        const placed = this.placement(key, event);
        this.keyByRow.set(event.id, key);
        const finished = !started || this.find(key)?.kind === "pi.compaction";
        this.compacting = finished ? undefined : key;
        this.put(
          finished
            ? this.make("pi.compaction", placed)
            : this.make("leverage.notice", {
                ...placed,
                text: "Compacting context…",
              }),
        );
        return;
      }
      default:
        return;
    }
  }

  private callName(call: EntryRecord): string | undefined {
    const message = messageOf(call);
    return message?.role === "assistant" &&
      message.content[0]?.type === "toolCall"
      ? message.content[0].name
      : undefined;
  }

  // The live slot of a tool call, created when the call starts running.
  private slot(
    live: Draft<LiveState>,
    callId: string,
    name: string,
  ): Draft<ToolSlot> {
    live.tools ??= [];
    const existing = live.tools.find((one) => one.callId === callId);
    if (existing) {
      return existing;
    }
    live.tools.push({ callId, name, status: "pending" });
    return live.tools[live.tools.length - 1]!;
  }

  // A finished call leaves the live slots, unless it keeps running in the background.
  private finish(
    live: Draft<LiveState>,
    callId: string,
    background: boolean,
  ): void {
    if (!live.tools) {
      return;
    }
    const index = live.tools.findIndex((one) => one.callId === callId);
    if (index < 0) {
      return;
    }
    if (background) {
      live.tools[index]!.status = "running";
      live.tools[index]!.details = { background: true };
      return;
    }
    live.tools.splice(index, 1);
  }

  private text(
    placed: EntryData,
    kind: "text" | "reasoning",
    text: string,
    finalized: boolean,
  ): EntryRecord {
    const content: AssistantMessage["content"] = text
      ? [
          kind === "text"
            ? { type: "text", text }
            : { type: "thinking", thinking: text },
        ]
      : [];
    return this.make("pi.assistant", placed, [
      assistant(
        content,
        finalized ? "stop" : "pending",
        this.model,
        placed.created,
      ),
    ]);
  }

  private stream(delta: TranscriptDelta, kind: "text" | "reasoning"): boolean {
    // Without a row to stream into, the finished row brings the whole text.
    if (!delta.rowId) {
      return false;
    }
    const key =
      this.keyByRow.get(delta.rowId) ??
      `${kind}:${delta.eventId ?? delta.streamId}`;
    const now = Date.now();
    const existing = this.find(key);
    const message = existing ? messageOf(existing) : undefined;
    if (message && message.role !== "assistant") {
      return false;
    }
    if (message?.role === "assistant" && message.stopReason !== "pending") {
      return false;
    }
    const current = message?.content[0];
    if (current?.type === "toolCall") {
      return false;
    }
    const existingText =
      current?.type === "text"
        ? current.text
        : current?.type === "thinking"
          ? current.thinking
          : "";
    const placed: EntryData = existing
      ? { ...entryData(existing) }
      : { key, order: UNPLACED + now, created: now };
    this.keyByRow.set(delta.rowId, key);
    this.put(this.text(placed, kind, place(existingText, delta), false));
    return true;
  }

  // A plan without text is the one the agent just wrote to a plan file.
  private planText(input: unknown): string {
    const plan = planInput.parse(input).plan;
    if (plan) {
      return plan;
    }
    for (const entry of [...this.entries].reverse()) {
      const message = messageOf(entry);
      const call =
        message?.role === "assistant" ? message.content[0] : undefined;
      if (call?.type !== "toolCall" || bareName(call.name) !== "write") {
        continue;
      }
      const written = writeInput.parse(call.arguments);
      if (
        written.file_path.includes("/plans/") ||
        written.file_path.endsWith(".md")
      ) {
        return written.content;
      }
    }
    return "";
  }

  // A sub-agent's row adds a step to the Task call that started it.
  private step(parent: string, event: TranscriptEvent): void {
    const call = this.find(`tool:${parent}`);
    if (!call) {
      return;
    }
    const data = event.data;
    const line =
      event.kind === "tool_call"
        ? toolTitleText(data.name || "tool", data.input)
        : event.kind === "text" && data.finalized
          ? (data.content.trim().split("\n")[0] ?? "")
          : event.kind === "error"
            ? `Error: ${data.content || "the step failed"}`
            : "";
    if (!line) {
      return;
    }
    const current = entryData(call);
    const steps = [...(current.steps ?? [])];
    const index = steps.findIndex((one) => one.startsWith(`${event.id}\u0000`));
    const stored = `${event.id}\u0000${line}`;
    if (index >= 0) {
      steps[index] = stored;
    } else {
      steps.push(stored);
    }
    this.put(this.make(call.kind, { ...current, steps }, call.model));
  }

  // Keeps the newest entries within the limits.
  private settle(): void {
    const maxEntries = this.limits.maxEntries ?? MAX_ENTRIES;
    const maxCharacters = this.limits.maxCharacters ?? MAX_CHARACTERS;
    let characters = 0;
    let kept = 0;
    const keep = new Set<string>();
    for (const entry of [...this.entries].reverse()) {
      characters += JSON.stringify(entry.model ?? entry.data).length;
      kept += 1;
      if (kept <= maxEntries && characters <= maxCharacters) {
        keep.add(entryData(entry).key);
      }
    }
    if (keep.size !== this.entries.length) {
      this.entries = this.entries.filter((entry) =>
        keep.has(entryData(entry).key),
      );
      this.revision++;
    }
    if (this.keyByRow.size > 4_000) {
      const live = new Set(this.entries.map((entry) => entryData(entry).key));
      for (const [row, key] of this.keyByRow) {
        if (this.keyByRow.size <= 4_000) {
          break;
        }
        if (!live.has(key)) {
          this.keyByRow.delete(row);
        }
      }
    }
  }
}

/** The steps of a sub-agent's call, without the row IDs that keep them unique. */
export function stepsOf(data: EntryData): string[] {
  return (data.steps ?? []).map((step) => step.split("\u0000")[1] ?? step);
}

/** Whether a person's message is still on its way to the agent. */
export function waiting(status: string | undefined): boolean {
  return status !== undefined && WAITING.has(status);
}

/**
 * One shared Leverage session as a replicated conversation view. The
 * workspace socket keeps it live, and a fresh read repairs anything a
 * dropped connection missed. Every change is one Chord commit on the view,
 * so a renderer attaches, reads the value, and follows the updates.
 */
export class SessionReplica {
  readonly state: MutableReplicatedState<SessionView>;
  private readonly fold: EntryFold;
  private readonly inputs = new Map<string, SessionInput>();
  private readonly approvals = new Map<string, Invocation>();
  // Counts live approval frames, so a read that overlaps one keeps them.
  private approvalFrames = 0;
  private readonly asks = new Map<string, TranscriptEvent>();
  private socket?: WorkspaceSocket;
  private readonly lifetime = new AbortController();
  private disposals: Array<() => void> = [];
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  // The fold revision the view shows.
  private published = 0;

  constructor(
    readonly id: string,
    private readonly failed: (error: unknown) => void,
  ) {
    this.fold = new EntryFold(id);
    this.state = replicatedState<SessionView>({
      conversation: { id: conversationId(0) },
      entries: [],
      docs: {
        "pi.live": {},
        "pi.inbox": { items: [] },
        "leverage.session": SESSION_DOC,
        "leverage.approvals": { items: [] },
        "leverage.asks": { items: [] },
      },
    });
  }

  get value(): SessionView {
    return this.state.value;
  }

  get doc(): SessionDoc {
    return this.state.value.docs["leverage.session"];
  }

  get closed(): boolean {
    return this.lifetime.signal.aborted;
  }

  /** A person's message as this client last saw it. */
  input(uuid: string): SessionInput | undefined {
    return this.inputs.get(uuid);
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.addEventListener("abort", () => this.close(), { once: true });
    if (signal.aborted) {
      this.close();
      return;
    }
    this.socket = await workspace.socket(this.lifetime.signal);
    // The socket may be live already, so its state is read once, not only on change.
    const connection = this.socket.connection;
    this.commit((draft) => {
      draft.docs["leverage.session"].connection = connection;
    });
    // A reconnect reads again. A read already running reports its own failure.
    const repair = () => {
      if (!this.refreshing) {
        void this.refresh().catch(this.failed);
      }
    };
    const poll = setInterval(repair, POLL_MS);
    this.disposals.push(
      () => clearInterval(poll),
      this.socket.onEvent((event) => this.apply(event)),
      this.socket.onState((state) => {
        if (state === "live") {
          repair();
        }
        this.commit((draft) => {
          draft.docs["leverage.session"].connection = state;
        });
      }),
    );
    await Promise.all([this.socket.connect(), this.refresh()]);
  }

  /** Reads the session again. Calls during a read share it and read once more after. */
  refresh(): Promise<void> {
    if (this.closed || this.doc.revoked) {
      return Promise.resolve();
    }
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          await this.read();
        } catch (error) {
          if (this.closed) {
            return;
          }
          if (accessLost.safeParse(error).success) {
            this.revoke();
            return;
          }
          throw error;
        }
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Records a message this client sent, before the socket echoes it. */
  remember(input: SessionInput): void {
    this.commit((draft) => this.messages(draft, [input]));
  }

  apply(event: WorkspaceEvent): void {
    if (this.doc.revoked || this.closed) {
      return;
    }
    const mine = (sessionId: string) => sessionId === this.id;
    const newer = (version: number) => version >= this.doc.version;
    Match.value(event).pipe(
      Match.when({ type: "session.event", sessionId: mine }, ({ event }) =>
        this.commit((draft) => this.transcript(draft, [event])),
      ),
      Match.when(
        { type: "session.event.delta", sessionId: mine },
        ({ delta }) =>
          this.commit((draft) => {
            if (this.fold.delta(delta, draft.docs["pi.live"])) {
              this.entries(draft);
            }
          }),
      ),
      Match.when(
        { type: "session.updated", sessionId: mine, version: newer },
        (update) =>
          this.commit((draft) => {
            const doc = draft.docs["leverage.session"];
            doc.version = update.version;
            if (doc.session) {
              this.session(draft, {
                ...doc.session,
                ...(update.title !== undefined ? { title: update.title } : {}),
                status: update.status,
                awaitingReason: update.awaitingReason,
                model: update.model,
                reasoningEffort: update.reasoningEffort,
                queuedCount: update.queuedCount,
                turnId: update.turnId,
                archivedAt: update.archivedAt,
                contextUsedTokens: update.contextUsedTokens,
                contextWindowTokens: update.contextWindowTokens,
              });
            }
          }),
      ),
      // A message update older than one already applied is stale.
      Match.when(
        { type: "session.messages.updated", sessionId: mine, version: newer },
        ({ messages, version }) =>
          this.commit((draft) => {
            draft.docs["leverage.session"].version = version;
            this.messages(draft, messages);
          }),
      ),
      Match.when(
        { type: "session.approval.pending", sessionId: mine },
        ({ invocation }) => {
          this.approvalFrames++;
          this.approvals.set(invocation.id, invocation);
          this.commit((draft) => this.pending(draft));
        },
      ),
      Match.when(
        { type: "session.approval.updated", sessionId: mine },
        ({ invocation }) => {
          this.approvalFrames++;
          if (invocation.state === "pending_approval") {
            this.approvals.set(invocation.id, invocation);
          } else {
            this.approvals.delete(invocation.id);
          }
          this.commit((draft) => this.pending(draft));
        },
      ),
      // The socket keeps who is around. The document copies it on each change.
      Match.when({ type: "session.presence.snapshot", sessionId: mine }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "session.presence.update", sessionId: mine }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "session.typing.snapshot", sessionId: mine }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "session.typing.update", sessionId: mine }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "presence.snapshot" }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "presence.update" }, () =>
        this.commit((draft) => this.people(draft)),
      ),
      Match.when({ type: "session.access_revoked", sessionId: mine }, () =>
        this.revoke(),
      ),
      Match.when({ type: "session.list.changed", sessionId: mine }, () => {
        void this.refresh().catch(this.failed);
      }),
      Match.orElse(() => undefined),
    );
  }

  close(): void {
    this.lifetime.abort();
    for (const dispose of this.disposals.splice(0)) {
      dispose();
    }
    this.socket?.unsubscribe(this.id);
  }

  /** One atomic change of the view, published to every subscriber. */
  private commit(mutate: (draft: Draft<SessionView>) => void): void {
    this.state.change(BACKGROUND_CONTEXT, mutate);
  }

  // The fold's entries become the view's when they changed. The draft clones
  // what it is given, so an unchanged fold keeps the view's array.
  private entries(draft: Draft<SessionView>): void {
    if (this.fold.revision === this.published) {
      return;
    }
    this.published = this.fold.revision;
    draft.entries =
      this.fold.current() as unknown as Draft<SessionView>["entries"];
  }

  private async read(): Promise<void> {
    const approvalFrames = this.approvalFrames;
    const [snapshot, members] = await Promise.all([
      workspace.bootstrap(this.id, this.lifetime.signal),
      workspace.members(this.lifetime.signal),
    ]);
    if (this.closed || this.doc.revoked) {
      return;
    }
    // A read that started before a newer live update must not undo it.
    const current = snapshot.version >= this.doc.version;
    // Approvals carry no version. A live frame during the read is newer.
    if (approvalFrames === this.approvalFrames) {
      this.approvals.clear();
      for (const invocation of snapshot.toolApprovals) {
        if (invocation.state === "pending_approval") {
          this.approvals.set(invocation.id, invocation);
        }
      }
    }
    this.socket?.subscribe(this.id, snapshot.lastCursorIncluded);
    this.commit((draft) => {
      const doc = draft.docs["leverage.session"];
      doc.canWrite = snapshot.viewerCanWrite;
      doc.members = json(members);
      if (this.socket?.userId) {
        doc.userId = this.socket.userId;
      }
      this.people(draft);
      if (current) {
        doc.version = snapshot.version;
        this.session(draft, snapshot.session);
      }
      // Rows first: they tell which messages belong to the loaded page.
      this.transcript(draft, snapshot.events);
      if (current) {
        this.messages(draft, snapshot.messages);
      }
      this.pending(draft);
    });
  }

  // The session row, and the Pi documents that follow from it.
  private session(draft: Draft<SessionView>, session: WorkspaceSession): void {
    draft.docs["leverage.session"].session = json(session);
    this.fold.setModel(session.model);
    draft.docs["pi.agent"] = {
      model: {
        provider: session.providerFamily,
        modelId: session.model ?? session.providerFamily,
      },
    };
    const live = (draft.docs["pi.live"] ??= {});
    if (RUNNING.has(session.status)) {
      live.run = {
        taskId: (session.turnId ?? session.status) as unknown as RunId,
        inputs: [],
      };
    } else {
      // A draft records an assignment of undefined as a delete; `delete` would
      // change the value behind the draft's back.
      live.run = undefined;
    }
  }

  private messages(
    draft: Draft<SessionView>,
    inputs: readonly SessionInput[],
  ): void {
    for (const input of inputs) {
      this.inputs.set(input.uuid, input);
    }
    while (this.inputs.size > 1000) {
      this.inputs.delete(this.inputs.keys().next().value!);
    }
    this.fold.messages(inputs);
    this.entries(draft);
    const queued = [...this.inputs.values()]
      .filter((input) => input.status === "queued")
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
    draft.docs["pi.inbox"] = {
      items: queued.map((input) => ({
        id: input.uuid as unknown as ItemId,
        mode: "followUp",
        content: input.content,
      })),
    };
  }

  // Questions stay open until the agent records the tool result that answers them.
  private transcript(
    draft: Draft<SessionView>,
    events: readonly TranscriptEvent[],
  ): void {
    for (const event of events) {
      if (event.kind === "session_init") {
        draft.docs["leverage.session"].skills =
          event.data.directorySkills.flatMap((one) => (one ? [one] : []));
      }
      const toolUseId = event.data.toolUseId;
      if (event.kind === "ask_user" && toolUseId) {
        this.asks.set(toolUseId, json(event));
      }
      if (event.kind === "tool_result") {
        this.asks.delete(toolUseId);
      }
    }
    const live = (draft.docs["pi.live"] ??= {});
    this.fold.apply(events, live);
    this.entries(draft);
    this.pending(draft);
  }

  // Who has the session open, who is typing, and who is online, from the socket.
  private people(draft: Draft<SessionView>): void {
    const doc = draft.docs["leverage.session"];
    doc.viewers = [...(this.socket?.viewers.get(this.id)?.values() ?? [])].map(
      (one) => viewer(one),
    );
    doc.typing = [...(this.socket?.typing.get(this.id) ?? [])];
    doc.presence = json(Object.fromEntries(this.socket?.presence ?? []));
  }

  // What waits for a person: approvals and questions.
  private pending(draft: Draft<SessionView>): void {
    draft.docs["leverage.approvals"] = {
      items: json([...this.approvals.values()]),
    };
    draft.docs["leverage.asks"] = { items: [...this.asks.values()] };
  }

  private revoke(): void {
    this.inputs.clear();
    this.approvals.clear();
    this.asks.clear();
    this.commit((draft) => {
      draft.entries = [];
      this.published = -1;
      draft.docs["pi.inbox"] = { items: [] };
      draft.docs["pi.live"] = {};
      this.pending(draft);
      const doc = draft.docs["leverage.session"];
      doc.revoked = true;
      doc.canWrite = false;
      doc.viewers = [];
      doc.typing = [];
    });
    this.close();
  }
}
