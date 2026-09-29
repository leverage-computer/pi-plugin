import {
  getMarkdownTheme,
  keyHint,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  Image,
  Markdown,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { clean } from "./drawers";
import {
  type Attachment,
  askSchema,
  type RowData,
  type SessionInput,
  type TranscriptDelta,
  type TranscriptEvent,
  type WorkspaceMember,
} from "./workspace/schema";

export const HISTORY_ENTRY = "leverage-history";

// Pi keeps one marker per displayed card. The card itself stays in memory.
export const historyMarkerSchema = z.object({
  sessionId: z.string(),
  id: z.string(),
});

export type HistoryMarker = z.infer<typeof historyMarkerSchema>;

export interface HistoryFile {
  type: "file";
  name: string;
  mime: string;
  data?: string;
  uri?: string;
}

interface TextPart {
  type: "text" | "reasoning";
  text: string;
}

interface ToolPart {
  type: "tool";
  id: string;
  name: string;
  status: string;
  input: string;
  output: string;
  files: HistoryFile[];
}

export type HistoryPart = TextPart | ToolPart | HistoryFile;

export interface HistoryEntry {
  author?: string;
  harness?: string | null;
  status?: string;
  sessionId: string;
  id: string;
  role: "user" | "assistant" | "system";
  parts: HistoryPart[];
  content: string;
  created: number;
  revision: number;
}

// One card in the conversation, before it is published for display.
interface Card {
  key: string;
  order: number;
  created: number;
  role: HistoryEntry["role"];
  parts: HistoryPart[];
  authorId?: string | null;
  inputUuid?: string;
  finalized?: boolean;
}

interface HistoryLimits {
  maxEntries?: number;
  maxCharacters?: number;
}

// Rows without a transcript position sort after every row that has one.
const UNPLACED = 1e15;

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

function fileParts(attachments: readonly Attachment[]): HistoryFile[] {
  return attachments.map((one) => ({
    type: "file",
    name: one.filename || "Attachment",
    mime: one.contentType || "application/octet-stream",
    ...(one.url ? { uri: one.url } : {}),
  }));
}

// A streamed row is one message that grows. Its stream ID names it.
function streamKey(event: TranscriptEvent): string {
  const eventId = event.data.eventId;
  return eventId ? `${event.kind}:${eventId}` : `row:${event.id}`;
}

function toolKey(event: TranscriptEvent): string {
  const id = event.data.toolUseId;
  return id ? `tool:${id}` : `row:${event.id}`;
}

// The text a finished tool reported, or its raw result when it had none.
function toolOutput(data: RowData): string {
  if (data.content) {
    return data.content;
  }
  return data.result === undefined ? "" : JSON.stringify(data.result, null, 2);
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

function partText(part: HistoryPart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "reasoning":
      return `Thinking\n${part.text}`;
    case "file":
      return `[Attachment: ${part.name} (${part.mime})]`;
    case "tool":
      return [
        `${part.name} · ${part.status}`,
        part.input,
        part.output,
        ...part.files.map(partText),
      ]
        .filter(Boolean)
        .join("\n");
  }
}

// Server delivery states, in the words a person expects.
const DELIVERY: Record<string, [string, ThemeColor]> = {
  queued: ["Queued", "warning"],
  releasing: ["Sending…", "muted"],
  sending: ["Sending…", "muted"],
  received: ["Delivered", "muted"],
  consumed: ["Delivered", "muted"],
  rejected: ["Not delivered", "error"],
  withdrawn: ["Withdrawn", "muted"],
  cancelled: ["Cancelled", "muted"],
  unknown: ["Delivery unknown", "warning"],
};

const SUMMARY_KEYS = [
  "command",
  "file_path",
  "path",
  "pattern",
  "query",
  "url",
  "name",
  "description",
];

// Tool arguments and results arrive as JSON text.
const toolArguments = z.record(z.string(), z.unknown());
const summaryText = z.string().trim().min(1);
const toolFailure = z.object({ error: z.string() });

// The argument that says what a tool call does, such as a path or command.
function toolSummary(input: string): string {
  try {
    const value = toolArguments.parse(JSON.parse(input));
    const found = SUMMARY_KEYS.map((key) =>
      summaryText.safeParse(value[key]),
    ).find((one) => one.success)?.data;
    return found?.split("\n")[0] ?? "";
  } catch {
    return "";
  }
}

// Leverage tools report failures as JSON with an error field.
function toolError(output: string): string {
  try {
    const failure = toolFailure.safeParse(JSON.parse(output));
    return failure.success ? failure.data.error : output;
  } catch {
    return output;
  }
}

export function createHistoryComponent(
  read: () => HistoryEntry | undefined,
  expanded: boolean,
  theme: Theme,
): Component {
  let previous: HistoryEntry | undefined;
  let rendered: Container | undefined;
  const files = (
    parent: { addChild(component: Component): void },
    attachments: HistoryFile[],
  ) => {
    for (const file of attachments) {
      parent.addChild(
        new Text(
          theme.fg("muted", clean(`▸ ${file.name} · ${file.mime}`)),
          0,
          0,
        ),
      );
      if (
        file.data &&
        /^image\/(png|jpeg|gif|webp)$/.test(file.mime) &&
        /^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
      ) {
        parent.addChild(
          new Image(
            file.data,
            file.mime,
            { fallbackColor: (text) => text },
            {
              filename: clean(file.name),
              maxWidthCells: 70,
              maxHeightCells: 25,
            },
          ),
        );
      }
    }
  };
  // Pi previews ten lines of tool output until tools are expanded.
  const preview = (value: string, color: ThemeColor): Component => {
    const body = new Text(theme.fg(color, clean(value)), 0, 0);
    return {
      invalidate: () => body.invalidate(),
      render(width) {
        const lines = body.render(width);
        return expanded || lines.length <= 10
          ? lines
          : [
              ...lines.slice(0, 10),
              ...new Text(
                `${theme.fg("muted", `... (${lines.length - 10} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
                0,
                0,
              ).render(width),
            ];
      },
    };
  };
  const tool = (part: ToolPart): Component => {
    const failed = part.status === "error";
    const done = part.status === "completed";
    const card = new Box(1, 1, (text) =>
      theme.bg(
        failed ? "toolErrorBg" : done ? "toolSuccessBg" : "toolPendingBg",
        text,
      ),
    );
    const summary = clean(toolSummary(part.input));
    // Pi titles a shell call as its command and other calls as name and target.
    card.addChild(
      new Text(
        part.name === "bash" && summary
          ? theme.fg("toolTitle", theme.bold(`$ ${summary}`))
          : `${theme.fg("toolTitle", theme.bold(clean(part.name)))}${summary ? ` ${theme.fg("accent", summary)}` : ""}`,
        0,
        0,
      ),
    );
    if (expanded && part.input) {
      card.addChild(new Text(theme.fg("muted", clean(part.input)), 0, 0));
    }
    const output = failed ? toolError(part.output) : part.output;
    if (output) {
      card.addChild(preview(output, failed ? "error" : "toolOutput"));
    }
    files(card, part.files);
    return card;
  };
  // People get Pi's own message card, with a name line for shared sessions.
  const person = (entry: HistoryEntry): Component => {
    const card = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
    const author = clean(entry.author ?? "User");
    const own = author.endsWith(" (you)");
    const [state, tone] = DELIVERY[entry.status ?? ""] ?? [];
    card.addChild(
      new Text(
        [
          theme.bold(
            theme.fg("userMessageText", author.replace(/ \(you\)$/, "")),
          ),
          own ? theme.fg("muted", " (you)") : "",
          entry.created
            ? theme.fg(
                "muted",
                `  ${new Date(entry.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
              )
            : "",
          entry.harness === "codex" || entry.harness === "claude"
            ? theme.fg(
                "muted",
                ` · Sent from ${entry.harness === "codex" ? "Codex" : "Claude"}`,
              )
            : "",
          state && tone ? theme.fg(tone, ` · ${state}`) : "",
        ].join(""),
        0,
        0,
      ),
    );
    for (const part of entry.parts) {
      if (part.type === "file") {
        files(card, [part]);
      } else if (part.type === "text") {
        card.addChild(
          new Markdown(clean(part.text), 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("userMessageText", text),
          }),
        );
      }
    }
    return card;
  };
  return {
    invalidate() {
      rendered?.invalidate();
    },
    render(width) {
      const entry = read();
      if (!entry) {
        return [];
      }
      if (entry !== previous || !rendered) {
        previous = entry;
        rendered = new Container();
        rendered.addChild(new Spacer(1));
        if (entry.role === "user") {
          rendered.addChild(person(entry));
        } else {
          for (const [index, part] of entry.parts.entries()) {
            if (index) {
              rendered.addChild(new Spacer(1));
            }
            if (part.type === "text") {
              rendered.addChild(
                entry.role === "system"
                  ? new Text(
                      theme.italic(theme.fg("dim", clean(part.text))),
                      1,
                      0,
                    )
                  : new Markdown(clean(part.text), 1, 0, getMarkdownTheme()),
              );
            } else if (part.type === "reasoning") {
              rendered.addChild(
                expanded
                  ? new Markdown(clean(part.text), 1, 0, getMarkdownTheme(), {
                      color: (text) => theme.fg("thinkingText", text),
                      italic: true,
                    })
                  : new Text(
                      theme.italic(theme.fg("thinkingText", "Thinking...")),
                      1,
                      0,
                    ),
              );
            } else if (part.type === "file") {
              files(rendered, [part]);
            } else if (part.type === "tool") {
              rendered.addChild(tool(part));
            }
          }
        }
      }
      return rendered.render(width);
    },
  };
}

/**
 * The conversation as Pi shows it. It folds transcript rows, streamed pieces
 * and people's messages into cards, one card per message or tool call.
 */
export class SharedHistory {
  private readonly cards = new Map<string, Card>();
  private readonly published = new Map<string, HistoryEntry>();
  private readonly inputs = new Map<string, SessionInput>();
  private readonly keyByRow = new Map<string, string>();
  private members: readonly WorkspaceMember[] = [];
  private viewerId?: string;
  private readonly maxEntries: number;
  private readonly maxCharacters: number;

  constructor(
    readonly sessionId: string,
    limits: HistoryLimits = {},
  ) {
    this.maxEntries = limits.maxEntries ?? 200;
    this.maxCharacters = limits.maxCharacters ?? 32 * 1024 * 1024;
  }

  /** Names each person's messages. Returns the cards whose names changed. */
  attribute(
    members: readonly WorkspaceMember[],
    viewerId?: string,
  ): HistoryEntry[] {
    this.members = members;
    this.viewerId = viewerId;
    return this.settle(this.republish((card) => card.role === "user"));
  }

  /**
   * Records people's messages. One that has not reached the agent yet gets a
   * card of its own, which its transcript row later takes over.
   */
  messages(inputs: readonly SessionInput[]): HistoryEntry[] {
    const changes: HistoryEntry[] = [];
    for (const input of inputs) {
      if (input.sessionId !== this.sessionId) {
        continue;
      }
      this.inputs.set(input.uuid, input);
      const key = `input:${input.uuid}`;
      const existing = this.cards.get(key);
      if (!existing && !WAITING.has(input.status)) {
        continue;
      }
      const created = Date.parse(input.createdAt) || 0;
      const card: Card = existing ?? {
        key,
        order: UNPLACED + created,
        created,
        role: "user",
        parts: [
          { type: "text", text: input.content },
          ...fileParts(input.attachments ?? []),
        ],
      };
      card.inputUuid = input.uuid;
      card.authorId ??= input.authorId;
      this.cards.set(key, card);
      changes.push(...this.publish(card));
    }
    while (this.inputs.size > 1000) {
      this.inputs.delete(this.inputs.keys().next().value!);
    }
    return this.settle(changes);
  }

  /** Folds transcript rows in. Replaying a row changes nothing. */
  apply(events: readonly TranscriptEvent[]): HistoryEntry[] {
    const changes: HistoryEntry[] = [];
    const ordered = [...events].sort(
      (a, b) => (a.transcriptSeq ?? UNPLACED) - (b.transcriptSeq ?? UNPLACED),
    );
    for (const event of ordered) {
      if (event.sessionId !== this.sessionId) {
        continue;
      }
      const card = this.fold(event);
      if (card) {
        changes.push(...this.publish(card));
      }
    }
    return this.settle(changes);
  }

  /** Grows a streamed message or a running tool's output. */
  delta(delta: TranscriptDelta): HistoryEntry[] {
    const card = this.grow(delta);
    return card ? this.settle(this.publish(card)) : [];
  }

  entries(): HistoryEntry[] {
    return [...this.cards.values()]
      .sort((a, b) => a.order - b.order)
      .flatMap((card) => this.published.get(card.key) ?? []);
  }

  entry(id: string): HistoryEntry | undefined {
    return this.published.get(id);
  }

  private card(key: string, event: TranscriptEvent, role: Card["role"]): Card {
    const created = Date.parse(event.createdAt) || 0;
    const card = this.cards.get(key) ?? {
      key,
      order: event.transcriptSeq ?? UNPLACED + created,
      created,
      role,
      parts: [],
    };
    if (typeof event.transcriptSeq === "number" && card.order >= UNPLACED) {
      card.order = event.transcriptSeq;
    }
    this.cards.set(key, card);
    this.keyByRow.set(event.id, key);
    return card;
  }

  // Each row kind updates one card. Rows the conversation does not show are skipped.
  private fold(event: TranscriptEvent): Card | undefined {
    const data = event.data;
    switch (event.kind) {
      case "user": {
        const input = event.sourceInputUuids?.[0];
        const card = this.card(
          input ? `input:${input}` : `row:${event.id}`,
          event,
          "user",
        );
        card.inputUuid = input;
        if (event.authorId !== undefined) {
          card.authorId = event.authorId;
        }
        const answers = Object.entries(data.answers).map(
          ([question, answer]) => `${question}: ${String(answer)}`,
        );
        card.parts = [
          { type: "text", text: data.content || answers.join("\n") },
          ...fileParts(data.attachments),
        ];
        return card;
      }
      case "text":
      case "reasoning": {
        const card = this.card(streamKey(event), event, "assistant");
        const incoming = data.content;
        const current = card.parts[0];
        const existing = current?.type === event.kind ? current.text : "";
        const finalized = data.finalized;
        // A finished message wins; otherwise the longer one does, so streams never shrink.
        const keep =
          card.finalized && !finalized
            ? existing
            : finalized || incoming.length >= existing.length
              ? incoming
              : existing;
        card.finalized ||= finalized;
        card.parts = keep ? [{ type: event.kind, text: keep }] : [];
        return card;
      }
      case "tool_call": {
        const card = this.card(toolKey(event), event, "assistant");
        const previous = card.parts[0];
        const done =
          previous?.type === "tool" &&
          (previous.status === "completed" || previous.status === "error");
        card.parts = [
          {
            type: "tool",
            id: data.toolUseId || event.id,
            name: data.name || "tool",
            status: done ? previous.status : "running",
            input: JSON.stringify(data.input ?? {}, null, 2),
            output: previous?.type === "tool" ? previous.output : "",
            files: [],
          },
        ];
        return card;
      }
      case "tool_result": {
        const asked = `ask:${data.toolUseId}`;
        if (this.cards.has(asked)) {
          const card = this.card(asked, event, "system");
          const question = card.parts[0];
          if (
            question?.type === "text" &&
            !question.text.endsWith("Answered")
          ) {
            card.parts = [{ type: "text", text: `${question.text}\nAnswered` }];
          }
          return card;
        }
        const card = this.card(toolKey(event), event, "assistant");
        const previous = card.parts[0];
        const failed = data.isError || data.is_error;
        card.parts = [
          {
            type: "tool",
            id: data.toolUseId || event.id,
            name:
              previous?.type === "tool" ? previous.name : data.name || "tool",
            status: failed ? "error" : "completed",
            input: previous?.type === "tool" ? previous.input : "",
            output: toolOutput(data),
            files: [],
          },
        ];
        return card;
      }
      case "ask_user": {
        const key = `ask:${data.toolUseId || event.id}`;
        const card = this.card(key, event, "system");
        if (!card.parts.length) {
          const lines = questionsOf(event).flatMap((one) => [
            one.question,
            ...one.options.map((option, index) => `  ${index + 1}. ${option}`),
          ]);
          card.parts = [
            { type: "text", text: ["Question for you", ...lines].join("\n") },
          ];
        }
        return card;
      }
      case "error": {
        const card = this.card(`row:${event.id}`, event, "assistant");
        const message = data.content || "The turn failed";
        card.parts = [{ type: "text", text: `Error: ${message}` }];
        return card;
      }
      case "interrupted": {
        const card = this.card(`row:${event.id}`, event, "system");
        const stopped =
          data.cause === "user_stop"
            ? `Stopped by ${this.name(event.authorId)}`
            : "Interrupted";
        card.parts = [{ type: "text", text: stopped }];
        return card;
      }
      case "compaction": {
        if (data.tombstone) {
          return undefined;
        }
        const card = this.card(`row:${event.id}`, event, "system");
        card.parts = [{ type: "text", text: "Context compacted" }];
        return card;
      }
      default:
        return undefined;
    }
  }

  private grow(delta: TranscriptDelta): Card | undefined {
    if (delta.kind === "text" || delta.kind === "reasoning") {
      return this.stream(delta, delta.kind);
    }
    // Live output of a running tool, shown until its result arrives.
    const card = delta.toolUseId
      ? this.cards.get(`tool:${delta.toolUseId}`)
      : undefined;
    const tool = card?.parts[0];
    if (!card || tool?.type !== "tool" || tool.status !== "running") {
      return undefined;
    }
    card.parts = [{ ...tool, output: place(tool.output, delta) }];
    return card;
  }

  private stream(
    delta: TranscriptDelta,
    kind: "text" | "reasoning",
  ): Card | undefined {
    // Without a row to stream into, the finished row brings the whole text.
    if (!delta.rowId) {
      return undefined;
    }
    const key =
      this.keyByRow.get(delta.rowId) ??
      `${kind}:${delta.eventId ?? delta.streamId}`;
    const now = Date.now();
    const card: Card = this.cards.get(key) ?? {
      key,
      order: UNPLACED + now,
      created: now,
      role: "assistant",
      parts: [],
    };
    if (card.finalized) {
      return undefined;
    }
    const current = card.parts[0];
    const existing =
      current?.type === "text" || current?.type === "reasoning"
        ? current.text
        : "";
    const next = place(existing, delta);
    this.cards.set(key, card);
    this.keyByRow.set(delta.rowId, key);
    card.parts = [{ type: kind, text: next }];
    return card;
  }

  private name(authorId: string | null | undefined): string {
    if (authorId === null) {
      return "Leverage";
    }
    const name =
      this.members.find((one) => one.id === authorId)?.name ?? "Unknown member";
    return authorId === this.viewerId ? `${name} (you)` : name;
  }

  // The name a person's card shows: the member's name, else the name they sent under.
  private author(card: Card, input: SessionInput | undefined) {
    const authorId = card.authorId ?? input?.authorId;
    if (authorId === undefined) {
      return input?.authorName ?? undefined;
    }
    if (authorId === null || this.members.some((one) => one.id === authorId)) {
      return this.name(authorId);
    }
    const name = input?.authorName ?? "Unknown member";
    return authorId === this.viewerId ? `${name} (you)` : name;
  }

  private republish(which: (card: Card) => boolean): HistoryEntry[] {
    return [...this.cards.values()]
      .filter(which)
      .flatMap((card) => this.publish(card));
  }

  private publish(card: Card): HistoryEntry[] {
    const input = card.inputUuid ? this.inputs.get(card.inputUuid) : undefined;
    const author = card.role === "user" ? this.author(card, input) : undefined;
    const status = card.role === "user" ? input?.status : undefined;
    const parts = card.parts.map((part) =>
      part.type === "tool" ? { ...part, files: [...part.files] } : { ...part },
    );
    // The transcript's copy of a person's message carries a header for the
    // agent. The message as the person wrote it reads better.
    if (input && parts[0]?.type === "text") {
      parts[0] = { type: "text", text: input.content };
    }
    const body = parts.map(partText).filter(Boolean).join("\n\n");
    if (!body) {
      return [];
    }
    const label =
      card.role === "user"
        ? (author ?? "User")
        : card.role === "assistant"
          ? "Assistant"
          : "Session";
    const waiting = status !== undefined && WAITING.has(status);
    const shown = waiting && status !== "received" ? ` · ${status}` : "";
    const content = `${label}${shown}\n${body}`;
    const prior = this.published.get(card.key);
    if (
      prior?.content === content &&
      JSON.stringify(prior.parts) === JSON.stringify(parts) &&
      prior.harness === input?.harness &&
      prior.status === status
    ) {
      return [];
    }
    const entry: HistoryEntry = {
      sessionId: this.sessionId,
      id: card.key,
      role: card.role,
      author,
      harness: input?.harness,
      status,
      parts,
      created: card.created,
      content,
      revision: (prior?.revision ?? 0) + 1,
    };
    this.published.set(card.key, entry);
    return [entry];
  }

  // Keeps the newest cards within the limits and reports only cards still shown.
  private settle(changes: HistoryEntry[]): HistoryEntry[] {
    let characters = 0;
    let kept = 0;
    const newestFirst = [...this.cards.values()].sort(
      (a, b) => b.order - a.order,
    );
    for (const card of newestFirst) {
      characters += this.published.get(card.key)?.content.length ?? 0;
      kept += 1;
      if (kept > this.maxEntries || characters > this.maxCharacters) {
        this.cards.delete(card.key);
        this.published.delete(card.key);
      }
    }
    if (this.keyByRow.size > 4_000) {
      for (const [row, key] of this.keyByRow) {
        if (this.keyByRow.size <= 4_000) {
          break;
        }
        if (!this.cards.has(key)) {
          this.keyByRow.delete(row);
        }
      }
    }
    return changes.filter((entry) => this.published.has(entry.id));
  }
}
