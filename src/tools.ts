import { generateDiffString } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

/**
 * How a tool call reads in the conversation. Leverage names tools the way
 * Claude and Codex do, so each kind gets the card the web app and the
 * Leverage CLI give it.
 */
export type ToolCard =
  | { kind: "shell"; command: string; background: boolean }
  | { kind: "diff"; title: string; subject: string; diff: string }
  | { kind: "todo"; items: TodoItem[] }
  | { kind: "plan"; plan: string }
  | { kind: "task"; subject: string; background: boolean }
  | { kind: "activity"; title: string; subject: string; trimLines: boolean };

export interface TodoItem {
  text: string;
  status: "pending" | "in_progress" | "completed";
}

const text = z.string().catch("");
const flag = z.boolean().catch(false);

// Every input field any card reads. A field of the wrong type reads as empty.
const inputSchema = z.looseObject({
  command: text,
  cmd: text,
  script: text,
  file_path: text,
  notebook_path: text,
  path: text,
  pattern: text,
  query: text,
  url: text,
  uri: text,
  description: text,
  subagent_type: text,
  prompt: text,
  skill: text,
  name: text,
  plan: text,
  old_string: text,
  new_string: text,
  content: text,
  new_source: text,
  run_in_background: flag,
  edits: z.array(z.object({ old_string: text, new_string: text })).catch([]),
  todos: z
    .array(
      z.object({
        content: text,
        activeForm: text,
        status: z
          .enum(["pending", "in_progress", "completed"])
          .catch("pending"),
      }),
    )
    .catch([]),
  changes: z
    .array(
      z.object({
        path: text,
        diff: text,
        kind: z
          .object({ type: text, move_path: text })
          .catch({ type: "", move_path: "" }),
      }),
    )
    .catch([]),
  search_query: z.array(z.looseObject({ q: text })).catch([]),
});

type ToolInput = z.infer<typeof inputSchema>;

// MCP and namespaced tools keep only their last name, without separators.
function bareName(name: string): string {
  const last = name.split("__").pop()?.split(".").pop() ?? name;
  return last.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function firstLine(value: string): string {
  return value.trim().split("\n")[0]?.trim() ?? "";
}

// Codex patches carry whole files for adds and deletes, and a unified diff for updates.
function patchDiff(input: ToolInput): string {
  return input.changes
    .flatMap((change) => {
      const lines = change.diff ? change.diff.split("\n") : [];
      const body =
        change.kind.type === "add" || change.kind.type === "delete"
          ? lines.map(
              (line) => `${change.kind.type === "add" ? "+" : "-"} ${line}`,
            )
          : lines
              .filter(
                (line) => !line.startsWith("@@") && !line.startsWith("\\"),
              )
              .map((line) => `${line[0] ?? " "} ${line.slice(1)}`);
      const moved = change.kind.move_path ? ` → ${change.kind.move_path}` : "";
      return input.changes.length > 1
        ? [` ${change.path}${moved}`, ...body]
        : body;
    })
    .join("\n");
}

function editDiff(name: string, input: ToolInput): string {
  switch (name) {
    case "write":
      return generateDiffString("", input.content).diff;
    case "notebookedit":
      return generateDiffString("", input.new_source).diff;
    case "multiedit":
      return input.edits
        .map(
          (edit) => generateDiffString(edit.old_string, edit.new_string).diff,
        )
        .join("\n   ...\n");
    default:
      return generateDiffString(input.old_string, input.new_string).diff;
  }
}

/** One line that names a tool call, as a sub-agent's step list shows it. */
export function toolLabel(name: string, inputJson: string): string {
  const card = toolCard(name, inputJson);
  switch (card.kind) {
    case "shell":
      return `$ ${firstLine(card.command)}`;
    case "diff":
      return `${card.title} ${card.subject}`.trim();
    case "todo":
      return "Todos";
    case "plan":
      return "Plan";
    case "task":
      return `Task ${card.subject}`.trim();
    case "activity":
      return `${card.title} ${card.subject}`.trim();
  }
}

/** The card for one tool call, from its name and JSON arguments. */
export function toolCard(name: string, inputJson: string): ToolCard {
  let raw: unknown = {};
  try {
    raw = JSON.parse(inputJson || "{}");
  } catch {
    raw = {};
  }
  const input = inputSchema.catch(inputSchema.parse({})).parse(raw);
  const bare = bareName(name);
  switch (bare) {
    case "bash":
    case "shell":
    case "execcommand":
    case "executecommand":
      return {
        kind: "shell",
        command: input.command || input.cmd || input.script,
        background: input.run_in_background,
      };
    case "edit":
    case "multiedit":
    case "write":
    case "notebookedit":
      return {
        kind: "diff",
        title: name,
        subject: input.file_path || input.notebook_path,
        diff: editDiff(bare, input),
      };
    case "applypatch":
      return {
        kind: "diff",
        title: "Patch",
        subject:
          input.changes.length === 1
            ? (input.changes[0]?.path ?? "")
            : `${input.changes.length} files`,
        diff: patchDiff(input),
      };
    case "todowrite":
      return {
        kind: "todo",
        items: input.todos
          .filter((todo) => todo.content)
          .map((todo) => ({
            text:
              todo.status === "in_progress"
                ? todo.activeForm || todo.content
                : todo.content,
            status: todo.status,
          })),
      };
    case "exitplanmode":
      return { kind: "plan", plan: input.plan };
    case "task":
    case "agent":
    case "spawnagent":
    case "subagent":
      return {
        kind: "task",
        subject: [
          input.description || firstLine(input.prompt),
          input.subagent_type,
        ]
          .filter(Boolean)
          .join(" · "),
        background: input.run_in_background,
      };
    case "read":
    case "readfile":
      return {
        kind: "activity",
        title: "Read",
        subject: input.file_path || input.path,
        trimLines: true,
      };
    case "grep":
    case "ripgrep":
      return {
        kind: "activity",
        title: "Grep",
        subject: [input.pattern, input.path].filter(Boolean).join(" in "),
        trimLines: false,
      };
    case "glob":
      return {
        kind: "activity",
        title: "Glob",
        subject: input.pattern,
        trimLines: false,
      };
    case "websearch":
      return {
        kind: "activity",
        title: "Web search",
        subject: input.query || (input.search_query[0]?.q ?? ""),
        trimLines: false,
      };
    case "webfetch":
      return {
        kind: "activity",
        title: "Web fetch",
        subject: input.url || input.uri,
        trimLines: false,
      };
    case "skill":
      return {
        kind: "activity",
        title: "Skill",
        subject: input.skill || input.name,
        trimLines: false,
      };
    default:
      return {
        kind: "activity",
        title: name,
        subject: firstLine(
          input.file_path ||
            input.path ||
            input.pattern ||
            input.query ||
            input.url ||
            input.name ||
            input.description,
        ),
        trimLines: false,
      };
  }
}
