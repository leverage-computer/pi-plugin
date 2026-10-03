import {
  getMarkdownTheme,
  keyHint,
  renderDiff,
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
import { type ToolCard, toolCard, toolLabel } from "./tools";
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
  // A sub-agent's work, one line per step.
  steps?: string[];
  // A background command or agent keeps running after its call returns.
  background?: boolean;
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
  // A sub-agent's steps by transcript row, so a replayed row changes nothing.
  steps?: Map<string, string>;
}

interface HistoryLimits {
  maxEntries?: number;
  maxCharacters?: number;
}

// Task statuses that mean a background command or agent has finished.
const SETTLED = new Set(["completed", "failed", "stopped", "killed", "error"]);

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

// A person's message as they wrote it, with its attachments.
function messageParts(input: SessionInput): HistoryPart[] {
  return [
    { type: "text", text: input.content },
    ...fileParts(input.attachments ?? []),
  ];
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
        `${part.name} · ${part.status}${part.background ? " in the background" : ""}`,
        part.input,
        ...(part.steps ?? []).map((step) => `↳ ${step}`),
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

// Apps a person can send a message from. Leverage's own clients get no label.
const SENT_FROM = new Map([
  ["codex", "Codex"],
  ["claude", "Claude"],
  ["opencode", "OpenCode"],
  ["pi", "Pi"],
]);

// Tool results arrive as JSON text.
const toolFailure = z.object({ error: z.string() });
const planInput = z.looseObject({ plan: z.string().catch("") }).catch({
  plan: "",
});
const writeInput = z
  .object({ file_path: z.string().catch(""), content: z.string().catch("") })
  .catch({ file_path: "", content: "" });

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
  const preview = (value: string, color: ThemeColor | undefined): Component => {
    const body = new Text(color ? theme.fg(color, clean(value)) : value, 0, 0);
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
  // A shell call reads as its command. Other calls read as a name and a target.
  const toolTitle = (card: ToolCard, name: string): string => {
    const title = (label: string, subject: string) =>
      `${theme.fg("toolTitle", theme.bold(clean(label)))}${subject ? ` ${theme.fg("accent", clean(subject))}` : ""}`;
    const background = (on: boolean) =>
      on ? theme.fg("muted", " · background") : "";
    switch (card.kind) {
      case "shell":
        return `${theme.fg("toolTitle", theme.bold(clean(`$ ${card.command.split("\n")[0] ?? ""}`)))}${background(card.background)}`;
      case "diff":
        return title(card.title, card.subject);
      case "todo": {
        const done = card.items.filter((item) => item.status === "completed");
        return title("Todos", `${done.length}/${card.items.length} done`);
      }
      case "plan":
        return title("Plan", "");
      case "task":
        return `${title("Task", card.subject)}${background(card.background)}`;
      case "activity":
        return title(card.title || name, card.subject);
    }
  };

  // What a card shows before the tool's own output.
  const toolBody = (card: ToolCard, part: ToolPart): Component | undefined => {
    switch (card.kind) {
      case "diff":
        return card.diff
          ? preview(renderDiff(clean(card.diff)), undefined)
          : undefined;
      case "todo":
        return new Text(
          card.items
            .map((item) => {
              switch (item.status) {
                case "completed":
                  return theme.fg("dim", clean(`✓ ${item.text}`));
                case "in_progress":
                  return `${theme.fg("accent", "▸")} ${clean(item.text)}`;
                case "pending":
                  return `☐ ${clean(item.text)}`;
              }
            })
            .join("\n"),
          0,
          0,
        );
      case "plan":
        return card.plan
          ? new Markdown(clean(card.plan), 0, 0, getMarkdownTheme())
          : undefined;
      // A sub-agent's latest steps, or all of them when expanded.
      case "task": {
        const steps = part.steps ?? [];
        if (!steps.length) {
          return undefined;
        }
        const shown = expanded ? steps : steps.slice(-4);
        const hidden = steps.length - shown.length;
        return new Text(
          [
            ...(hidden ? [theme.fg("muted", `… ${hidden} earlier steps`)] : []),
            ...shown.map((step) => theme.fg("muted", clean(`↳ ${step}`))),
          ].join("\n"),
          0,
          0,
        );
      }
      case "shell":
      case "activity":
        return undefined;
    }
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
    const shape = toolCard(part.name, part.input);
    const still =
      part.background && part.status === "running"
        ? theme.fg("warning", " · running in the background")
        : "";
    card.addChild(new Text(`${toolTitle(shape, part.name)}${still}`, 0, 0));
    const body = toolBody(shape, part);
    if (body) {
      card.addChild(body);
    }
    // Expanded, a call shows its full arguments unless its body already does.
    const described =
      shape.kind === "diff" || shape.kind === "todo" || shape.kind === "plan";
    if (expanded && part.input && !described) {
      card.addChild(new Text(theme.fg("muted", clean(part.input)), 0, 0));
    }
    // An edit or a checklist says it all. Its output matters only on failure.
    const quiet = !failed && (shape.kind === "diff" || shape.kind === "todo");
    const output = failed ? toolError(part.output) : part.output;
    if (output && !quiet) {
      // Read results number each line. The card shows the file as it is.
      const shown =
        shape.kind === "activity" && shape.trimLines
          ? output.replace(/^\s*\d+[→|:\t]\s?/gm, "")
          : output;
      card.addChild(preview(shown, failed ? "error" : "toolOutput"));
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
    const app = SENT_FROM.get(entry.harness ?? "");
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
          app ? theme.fg("muted", ` · Sent from ${app}`) : "",
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
    // A theme change invalidates every component. Rebuilding the cards repaints their colors.
    invalidate() {
      rendered = undefined;
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
  // The Task call that started each sub-agent, by task ID.
  private readonly agentCalls = new Map<string, string>();
  // Background work still running, by the tool call that started it.
  private readonly running = new Set<string>();
  // The compaction card waiting for its finished row.
  private compacting?: string;
  // The earliest transcript position loaded. Older messages belong to a
  // history page the conversation does not show.
  private oldestSeq?: number;
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
      if (!existing && !this.shows(input)) {
        continue;
      }
      const created = Date.parse(input.createdAt) || 0;
      const seq = input.consumedTranscriptSeq;
      const card: Card = existing ?? {
        key,
        order: UNPLACED + created,
        created,
        role: "user",
        parts: [],
      };
      // A message the agent took in sits right after where it did.
      if (typeof seq === "number" && card.order >= UNPLACED) {
        card.order = seq + 0.5;
      }
      if (!card.parts.length) {
        card.parts = messageParts(input);
      }
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

  // Whether a message gets a card of its own before any row names it.
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
  apply(events: readonly TranscriptEvent[]): HistoryEntry[] {
    const changes: HistoryEntry[] = [];
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
      for (const card of this.fold(event)) {
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

  /** Fills in a file's bytes once they arrive. Returns the cards that show it. */
  fill(uri: string, data: string): HistoryEntry[] {
    const changes: HistoryEntry[] = [];
    for (const card of this.cards.values()) {
      const shows = (part: HistoryPart) =>
        part.type === "file" && part.uri === uri;
      if (!card.parts.some(shows)) {
        continue;
      }
      card.parts = card.parts.map((part) =>
        part.type === "file" && part.uri === uri ? { ...part, data } : part,
      );
      changes.push(...this.publish(card));
    }
    return changes;
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

  // A plan without text is the one the agent just wrote to a plan file.
  private planText(input: unknown): string {
    const plan = planInput.parse(input).plan;
    if (plan) {
      return plan;
    }
    const written = [...this.cards.values()]
      .sort((a, b) => b.order - a.order)
      .flatMap((card) => card.parts)
      .find((part) => {
        if (part.type !== "tool" || part.name !== "Write") {
          return false;
        }
        const path = writeInput.parse(JSON.parse(part.input)).file_path;
        return path.includes("/plans/") || path.endsWith(".md");
      });
    return written?.type === "tool"
      ? writeInput.parse(JSON.parse(written.input)).content
      : "";
  }

  // A sub-agent's row adds a step to the Task card that started it.
  private step(parent: string, event: TranscriptEvent): Card | undefined {
    const card = this.cards.get(`tool:${parent}`);
    const tool = card?.parts[0];
    if (!card || tool?.type !== "tool") {
      return undefined;
    }
    const data = event.data;
    const line =
      event.kind === "tool_call"
        ? toolLabel(data.name, JSON.stringify(data.input ?? {}))
        : event.kind === "text" && data.finalized
          ? (data.content.trim().split("\n")[0] ?? "")
          : event.kind === "error"
            ? `Error: ${data.content || "the step failed"}`
            : "";
    if (!line) {
      return undefined;
    }
    card.steps ??= new Map();
    card.steps.set(event.id, line);
    card.parts = [{ ...tool, steps: [...card.steps.values()] }];
    return card;
  }

  // Each row kind updates one card. Rows the conversation does not show are skipped.
  private fold(event: TranscriptEvent): Card[] {
    const data = event.data;
    // A sub-agent works inside its Task card, as it does in the web app.
    const parent =
      data.parentToolUseId || this.agentCalls.get(data.delegatedTaskId);
    if (parent && event.kind !== "task") {
      const card = this.step(parent, event);
      return card ? [card] : [];
    }
    if (data.delegatedTaskId && event.kind !== "task") {
      return [];
    }
    switch (event.kind) {
      // Messages that reached the agent together share one row. Each keeps
      // its own card, and a later message fills in the text.
      case "user": {
        const uuids = event.sourceInputUuids?.length
          ? event.sourceInputUuids
          : [undefined];
        const answers = Object.entries(data.answers).map(
          ([question, answer]) => `${question}: ${String(answer)}`,
        );
        return uuids.map((uuid, index) => {
          const input = uuid ? this.inputs.get(uuid) : undefined;
          const card = this.card(
            uuid ? `input:${uuid}` : `row:${event.id}`,
            event,
            "user",
          );
          card.inputUuid = uuid;
          if (event.authorId !== undefined) {
            card.authorId = event.authorId;
          }
          if (index === 0) {
            card.parts = [
              { type: "text", text: data.content || answers.join("\n") },
              ...fileParts(data.attachments),
            ];
          } else if (input) {
            card.parts = messageParts(input);
          }
          return card;
        });
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
        return [card];
      }
      case "tool_call": {
        const card = this.card(toolKey(event), event, "assistant");
        const previous = card.parts[0];
        const input =
          data.name === "ExitPlanMode"
            ? {
                ...planInput.parse(data.input),
                plan: this.planText(data.input),
              }
            : data.input;
        const done =
          previous?.type === "tool" &&
          (previous.status === "completed" || previous.status === "error");
        card.parts = [
          {
            type: "tool",
            id: data.toolUseId || event.id,
            name: data.name || "tool",
            status: done ? previous.status : "running",
            input: JSON.stringify(input ?? {}, null, 2),
            output: previous?.type === "tool" ? previous.output : "",
            files: [],
            ...(previous?.type === "tool" && previous.steps
              ? { steps: previous.steps }
              : {}),
            ...(previous?.type === "tool" && previous.background
              ? { background: true }
              : {}),
          },
        ];
        return [card];
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
          return [card];
        }
        const card = this.card(toolKey(event), event, "assistant");
        const previous = card.parts[0];
        const failed = data.isError || data.is_error;
        // A background command returns at once and keeps running.
        const background = this.running.has(data.toolUseId);
        card.parts = [
          {
            type: "tool",
            id: data.toolUseId || event.id,
            name:
              previous?.type === "tool" ? previous.name : data.name || "tool",
            status: failed ? "error" : background ? "running" : "completed",
            input: previous?.type === "tool" ? previous.input : "",
            output: toolOutput(data),
            files: [],
            ...(previous?.type === "tool" && previous.steps
              ? { steps: previous.steps }
              : {}),
            ...(background ? { background } : {}),
          },
        ];
        return [card];
      }
      // Background commands and sub-agents report as tasks until they settle.
      case "task": {
        if (data.taskId && data.toolUseId) {
          this.agentCalls.set(data.taskId, data.toolUseId);
        }
        if (!data.toolUseId) {
          return [];
        }
        const settled = data.phase === "settled" || SETTLED.has(data.status);
        if (settled) {
          this.running.delete(data.toolUseId);
        } else if (data.backgrounded) {
          this.running.add(data.toolUseId);
        }
        const card = this.cards.get(`tool:${data.toolUseId}`);
        const tool = card?.parts[0];
        if (!card || tool?.type !== "tool") {
          return [];
        }
        if (!settled && !data.backgrounded) {
          return [];
        }
        const failed = data.status === "failed" || data.status === "error";
        card.parts = [
          {
            ...tool,
            status: settled ? (failed ? "error" : "completed") : "running",
            background: true,
          },
        ];
        return [card];
      }
      case "ask_user": {
        const key = `ask:${data.toolUseId || event.id}`;
        const card = this.card(key, event, "system");
        if (!card.parts.length && planOf(event)) {
          card.parts = [{ type: "text", text: "Plan ready for your review" }];
        }
        if (!card.parts.length) {
          const lines = questionsOf(event).flatMap((one) => [
            one.question,
            ...one.options.map((option, index) => `  ${index + 1}. ${option}`),
          ]);
          card.parts = [
            { type: "text", text: ["Question for you", ...lines].join("\n") },
          ];
        }
        return [card];
      }
      case "error": {
        const card = this.card(`row:${event.id}`, event, "assistant");
        const message = data.content || "The turn failed";
        card.parts = [{ type: "text", text: `Error: ${message}` }];
        return [card];
      }
      case "interrupted": {
        const card = this.card(`row:${event.id}`, event, "system");
        const stopped =
          data.cause === "user_stop"
            ? `Stopped by ${this.name(event.authorId)}`
            : "Interrupted";
        card.parts = [{ type: "text", text: stopped }];
        return [card];
      }
      // A compaction writes a started row, then a finished one that replaces it.
      // Tombstones are storage markers, not compactions.
      case "compaction": {
        if (data.tombstone) {
          return [];
        }
        const started = data.phase === "started";
        const key =
          this.keyByRow.get(event.id) ??
          (started ? undefined : this.compacting) ??
          `row:${event.id}`;
        const card = this.card(key, event, "system");
        card.finalized ||= !started;
        this.compacting = card.finalized ? undefined : key;
        card.parts = [
          {
            type: "text",
            text: card.finalized ? "Context compacted" : "Compacting context…",
          },
        ];
        return [card];
      }
      default:
        return [];
    }
  }

  private grow(delta: TranscriptDelta): Card | undefined {
    // A sub-agent's finished rows show as steps of its Task card.
    if (delta.parentToolUseId || delta.delegatedTaskId) {
      return undefined;
    }
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
    if (current?.type === "tool") {
      return undefined;
    }
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
