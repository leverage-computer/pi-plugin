import {
  AssistantMessageComponent,
  generateDiffString,
  getMarkdownTheme,
  keyHint,
  renderDiff,
  type Theme,
  type ThemeColor,
  ToolExecutionComponent,
  type ToolRenderResultOptions,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import type { ToolSlot } from "@earendil-works/pi-durable";
import {
  type Component,
  Container,
  Image,
  Markdown,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { z } from "zod";
import { clean } from "./drawers";
import { toolCard, toolTitleText } from "./tools";
import type { Attachment, WorkspaceMember } from "./workspace/schema";
import {
  type EntryData,
  entryData,
  messageOf,
  type SessionView,
  stepsOf,
  userText,
  waiting,
} from "./workspace/view";

/*
 * Pi draws the conversation. Entries are rendered with the components Pi's
 * own transcript uses, so a Leverage session reads like a local one. Only the
 * tool cards are Leverage's: they know the tools Claude and Codex run.
 */

type EntryRecord = SessionView["entries"][number];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type ToolDefinition = ConstructorParameters<typeof ToolExecutionComponent>[4];

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

// Tool results arrive as JSON text.
const toolFailure = z.object({ error: z.string() });

// What Pi hands a tool renderer. The state is the card's own, kept across renders.
interface RenderContext {
  args: unknown;
  toolCallId: string;
  invalidate: () => void;
  lastComponent: Component | undefined;
  state: Record<string, unknown>;
  cwd: string;
}

/** Pi's renderer pair for one tool: the call, then the result. */
interface ToolRenderers {
  renderCall(args: unknown, theme: Theme, context: RenderContext): Component;
  renderResult(
    result: Pick<ToolResult, "content" | "details">,
    options: ToolRenderResultOptions,
    theme: Theme,
    context: RenderContext,
  ): Component;
}

/** One entry as Pi shows it, with what the view knows about its tool call. */
export interface Shown {
  entry: EntryRecord;
  // The result of a tool call, once the agent recorded it.
  result?: EntryRecord;
  // The call's live output while it runs.
  slot?: ToolSlot;
  members: readonly WorkspaceMember[];
  viewerId?: string;
  // Attached images already read from Leverage, by address.
  images: ReadonlyMap<string, string>;
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

const IMAGE_TYPE = /^image\/(png|jpeg|gif|webp)$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The name a person's entry shows: the member's name, else the name they sent under. */
export function authorOf(
  data: EntryData,
  members: readonly WorkspaceMember[],
  viewerId?: string,
): string | undefined {
  const { authorId } = data;
  if (authorId === undefined) {
    return data.authorName;
  }
  const you = (name: string) =>
    authorId === viewerId ? `${name} (you)` : name;
  if (authorId === null) {
    return "Leverage";
  }
  const member = members.find((one) => one.id === authorId);
  return you(member?.name ?? data.authorName ?? "Unknown member");
}

/** The text of an entry, for a plain-text transcript. */
export function entryText(
  entry: EntryRecord,
  members: readonly WorkspaceMember[],
  viewerId?: string,
): string {
  const data = entryData(entry);
  const message = messageOf(entry);
  switch (entry.kind) {
    case "pi.user": {
      const author = authorOf(data, members, viewerId) ?? "User";
      const shown =
        waiting(data.status) && data.status !== "received"
          ? ` · ${data.status}`
          : "";
      const body = message?.role === "user" ? userText(message.content) : "";
      const files = (data.attachments ?? []).map(
        (one) => `[Attachment: ${one.filename} (${one.contentType})]`,
      );
      return [`${author}${shown}`, body, ...files].filter(Boolean).join("\n");
    }
    case "pi.assistant": {
      if (message?.role !== "assistant") {
        return "";
      }
      const lines = message.content.map((block) => {
        switch (block.type) {
          case "text":
            return block.text;
          case "thinking":
            return `Thinking\n${block.thinking}`;
          case "toolCall":
            return [
              toolTitleText(block.name, block.arguments),
              ...stepsOf(data).map((step) => `↳ ${step}`),
            ].join("\n");
        }
      });
      if (message.stopReason === "error") {
        lines.push(`Error: ${message.errorMessage ?? "The turn failed"}`);
      }
      return ["Assistant", ...lines].filter(Boolean).join("\n");
    }
    case "pi.tool-result":
      return message?.role === "toolResult"
        ? message.content
            .flatMap((block) => (block.type === "text" ? [block.text] : []))
            .join("\n")
        : "";
    case "pi.compaction":
      return "Session\nContext compacted";
    case "leverage.notice":
      return `Session\n${noticeText(data, members, viewerId)}`;
    default:
      return "";
  }
}

function noticeText(
  data: EntryData,
  members: readonly WorkspaceMember[],
  viewerId?: string,
): string {
  if (data.text === "Stopped by") {
    return `Stopped by ${authorOf(data, members, viewerId) ?? "Unknown member"}`;
  }
  return data.text ?? "";
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

function resultText(result: Pick<ToolResult, "content">): string {
  return result.content
    .flatMap((block) =>
      block.type === "text" && block.text ? [block.text] : [],
    )
    .join("\n");
}

// Pi previews ten lines of tool output until tools are expanded.
function preview(
  theme: Theme,
  value: string,
  color: ThemeColor | undefined,
  expanded: boolean,
): Component {
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
}

/**
 * Pi's tool card renderers for one Leverage tool. The call shows what the
 * web app shows for its kind; the result shows the tool's output.
 */
export function toolRenderers(name: string, expanded: boolean): ToolRenderers {
  const title = (theme: Theme, label: string, subject: string) =>
    `${theme.fg("toolTitle", theme.bold(clean(label)))}${subject ? ` ${theme.fg("accent", clean(subject))}` : ""}`;
  const background = (theme: Theme, on: boolean) =>
    on ? theme.fg("muted", " · background") : "";
  return {
    renderCall(args, theme) {
      const card = toolCard(name, args);
      const box = new Container();
      switch (card.kind) {
        case "shell":
          box.addChild(
            new Text(
              `${theme.fg("toolTitle", theme.bold(clean(`$ ${firstLine(card.command)}`)))}${background(theme, card.background)}`,
              0,
              0,
            ),
          );
          break;
        case "diff":
          box.addChild(new Text(title(theme, card.title, card.subject), 0, 0));
          if (card.diff) {
            box.addChild(
              preview(theme, renderDiff(clean(card.diff)), undefined, expanded),
            );
          }
          break;
        case "todo": {
          const done = card.items.filter((item) => item.status === "completed");
          box.addChild(
            new Text(
              title(theme, "Todos", `${done.length}/${card.items.length} done`),
              0,
              0,
            ),
          );
          box.addChild(
            new Text(
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
            ),
          );
          break;
        }
        case "plan":
          box.addChild(new Text(title(theme, "Plan", ""), 0, 0));
          if (card.plan) {
            box.addChild(
              new Markdown(clean(card.plan), 0, 0, getMarkdownTheme()),
            );
          }
          break;
        case "question":
          box.addChild(new Text(title(theme, "Question for you", ""), 0, 0));
          box.addChild(new Text(clean(card.lines.join("\n")), 0, 0));
          break;
        case "task":
          box.addChild(
            new Text(
              `${title(theme, "Task", card.subject)}${background(theme, card.background)}`,
              0,
              0,
            ),
          );
          break;
        case "activity":
          box.addChild(
            new Text(title(theme, card.title || name, card.subject), 0, 0),
          );
          break;
      }
      // Expanded, a call shows its full arguments unless its body already does.
      const described =
        card.kind === "diff" ||
        card.kind === "todo" ||
        card.kind === "plan" ||
        card.kind === "question";
      if (expanded && !described && Object.keys(args ?? {}).length) {
        box.addChild(
          new Text(
            theme.fg("muted", clean(JSON.stringify(args, null, 2))),
            0,
            0,
          ),
        );
      }
      return box;
    },
    renderResult(result, options, theme, context) {
      const card = toolCard(name, context.args);
      const details = (result.details ?? {}) as {
        steps?: string[];
        background?: boolean;
        isError?: boolean;
      };
      const box = new Container();
      // A sub-agent's latest steps, or all of them when expanded.
      if (details.steps?.length) {
        const shown = options.expanded
          ? details.steps
          : details.steps.slice(-4);
        const hidden = details.steps.length - shown.length;
        box.addChild(
          new Text(
            [
              ...(hidden
                ? [theme.fg("muted", `… ${hidden} earlier steps`)]
                : []),
              ...shown.map((step) => theme.fg("muted", clean(`↳ ${step}`))),
            ].join("\n"),
            0,
            0,
          ),
        );
      }
      if (details.background && options.isPartial) {
        box.addChild(
          new Text(theme.fg("warning", "running in the background"), 0, 0),
        );
      }
      if (card.kind === "question" && !options.isPartial) {
        box.addChild(new Text(theme.fg("dim", "Answered"), 0, 0));
        return box;
      }
      const failed = details.isError === true;
      // An edit or a checklist says it all. Its output matters only on failure.
      const quiet = !failed && (card.kind === "diff" || card.kind === "todo");
      const output = failed
        ? toolError(resultText(result))
        : resultText(result);
      if (output && !quiet) {
        // Read results number each line. The card shows the file as it is.
        const shown =
          card.kind === "activity" && card.trimLines
            ? output.replace(/^\s*\d+[→|:\t]\s?/gm, "")
            : output;
        box.addChild(
          preview(
            theme,
            shown,
            failed ? "error" : "toolOutput",
            options.expanded,
          ),
        );
      }
      return box;
    },
  };
}

/* ── Entries, with Pi's components ───────────────────────────────────── */

function files(
  theme: Theme,
  parent: { addChild(component: Component): void },
  attachments: readonly Attachment[],
  images: ReadonlyMap<string, string>,
) {
  for (const file of attachments) {
    const mime = file.contentType || "application/octet-stream";
    const name = file.filename || "Attachment";
    parent.addChild(
      new Text(theme.fg("muted", clean(`▸ ${name} · ${mime}`)), 0, 0),
    );
    const data = file.url ? images.get(file.url) : undefined;
    if (data && IMAGE_TYPE.test(mime) && BASE64.test(data)) {
      parent.addChild(
        new Image(
          data,
          mime,
          { fallbackColor: (text) => text },
          { filename: clean(name), maxWidthCells: 70, maxHeightCells: 25 },
        ),
      );
    }
  }
}

// People get Pi's own message card, with a name line for shared sessions.
function person(theme: Theme, shown: Shown): Component {
  const { entry, members, viewerId, images } = shown;
  const data = entryData(entry);
  const message = messageOf(entry);
  const card = new Container();
  const author = clean(authorOf(data, members, viewerId) ?? "User");
  const own = author.endsWith(" (you)");
  const [state, tone] = DELIVERY[data.status ?? ""] ?? [];
  const app = SENT_FROM.get(data.harness ?? "");
  card.addChild(
    new Text(
      [
        theme.bold(
          theme.fg("userMessageText", author.replace(/ \(you\)$/, "")),
        ),
        own ? theme.fg("muted", " (you)") : "",
        data.created
          ? theme.fg(
              "muted",
              `  ${new Date(data.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
            )
          : "",
        app ? theme.fg("muted", ` · Sent from ${app}`) : "",
        state && tone ? theme.fg(tone, ` · ${state}`) : "",
      ].join(""),
      1,
      0,
    ),
  );
  const body = message?.role === "user" ? userText(message.content) : "";
  if (body) {
    card.addChild(new UserMessageComponent(clean(body)));
  }
  if (data.attachments?.length) {
    const box = new Container();
    files(theme, box, data.attachments, images);
    card.addChild(box);
  }
  return card;
}

/**
 * Pi's component for one entry. `read` gives the entry as the view has it
 * now; the component follows it until Pi discards the component.
 */
export function createEntryComponent(
  read: () => Shown | undefined,
  expanded: boolean,
  theme: Theme,
  tui: TUI,
  cwd: string,
): Component {
  let previous: Shown | undefined;
  let rendered: Container | undefined;
  let assistant: AssistantMessageComponent | undefined;
  let tool: ToolExecutionComponent | undefined;

  const same = (a: Shown | undefined, b: Shown) =>
    a?.entry === b.entry &&
    a.result === b.result &&
    a.slot === b.slot &&
    a.members === b.members &&
    a.images === b.images;

  // Every card's parts, from scratch.
  const build = (shown: Shown): Container => {
    const container = new Container();
    assistant = undefined;
    tool = undefined;
    const { entry } = shown;
    const data = entryData(entry);
    const message = messageOf(entry);
    // Pi's assistant and tool components bring their own gap above. The others need one.
    if (entry.kind === "pi.user") {
      container.addChild(new Spacer(1));
      container.addChild(person(theme, shown));
      return container;
    }
    if (entry.kind === "pi.compaction") {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.italic(theme.fg("dim", "Context compacted")), 1, 0),
      );
      return container;
    }
    if (entry.kind === "leverage.notice") {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.italic(
            theme.fg(
              "dim",
              clean(noticeText(data, shown.members, shown.viewerId)),
            ),
          ),
          1,
          0,
        ),
      );
      return container;
    }
    if (message?.role !== "assistant") {
      return container;
    }
    const call = message.content.find((block) => block.type === "toolCall");
    if (call) {
      tool = new ToolExecutionComponent(
        call.name,
        call.id,
        call.arguments,
        {},
        toolRenderers(call.name, expanded) as ToolDefinition,
        tui,
        cwd,
      );
      tool.setExpanded(expanded);
      tool.setArgsComplete();
      container.addChild(tool);
      return container;
    }
    // Pi folds thinking away until the tools are expanded.
    assistant = new AssistantMessageComponent(
      message,
      !expanded,
      getMarkdownTheme(),
      undefined,
      1,
    );
    container.addChild(assistant);
    return container;
  };

  // What changed since the last render, applied to the existing components.
  const follow = (shown: Shown) => {
    const message = messageOf(shown.entry);
    if (assistant && message?.role === "assistant") {
      assistant.updateContent(message, message.stopReason === "pending");
    }
    if (tool) {
      const data = entryData(shown.entry);
      const steps = stepsOf(data);
      const resultMessage = shown.result ? messageOf(shown.result) : undefined;
      if (resultMessage?.role === "toolResult") {
        const background = entryData(shown.result!).background;
        tool.updateResult(
          {
            content: resultMessage.content,
            details: {
              ...(steps.length ? { steps } : {}),
              ...(background ? { background } : {}),
              isError: resultMessage.isError,
            },
            isError: resultMessage.isError,
          },
          Boolean(background && shown.slot?.status === "running"),
        );
      } else if (shown.slot) {
        tool.markExecutionStarted();
        if (shown.slot.output || steps.length) {
          tool.updateResult(
            {
              content: [{ type: "text", text: shown.slot.output ?? "" }],
              details: { ...(steps.length ? { steps } : {}), isError: false },
              isError: false,
            },
            true,
          );
        }
      } else if (steps.length) {
        tool.markExecutionStarted();
        tool.updateResult(
          { content: [], details: { steps, isError: false }, isError: false },
          true,
        );
      }
    }
  };

  return {
    // A theme change invalidates every component. Rebuilding the cards repaints their colors.
    invalidate() {
      rendered = undefined;
    },
    render(width) {
      const shown = read();
      if (!shown) {
        return [];
      }
      if (!rendered || previous?.entry.kind !== shown.entry.kind) {
        rendered = build(shown);
        follow(shown);
      } else if (!same(previous, shown)) {
        if (shown.entry.kind === "pi.user" || (!assistant && !tool)) {
          rendered = build(shown);
        }
        follow(shown);
      }
      previous = shown;
      return rendered.render(width);
    },
  };
}
