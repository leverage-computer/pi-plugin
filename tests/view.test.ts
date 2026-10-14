import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import type { LiveState } from "@earendil-works/pi-durable";
import { createEntryComponent, entryText, type Shown } from "../src/render";
import { NO_TERMINAL } from "../src/session";
import {
  type TranscriptDelta,
  type TranscriptEvent,
  transcriptEventSchema,
  type WorkspaceMember,
} from "../src/workspace/schema";
import { conversationOf, EntryFold, messageOf } from "../src/workspace/view";
import { input, SESSION } from "./workspace/fixture";

type Entry = ReturnType<EntryFold["current"]>[number];

let nextRow = 0;
initTheme("dark", false);
// Pi keeps its active theme on globalThis and exports no getter for it.
const theme = (globalThis as Record<symbol, Theme>)[
  Symbol.for("@earendil-works/pi-coding-agent:theme")
];

// A transcript row in the order the server stores it.
function row(
  kind: string,
  data: Record<string, unknown>,
  overrides: Partial<TranscriptEvent> = {},
): TranscriptEvent {
  nextRow += 1;
  return transcriptEventSchema.parse({
    id: `row_${nextRow}`,
    sessionId: SESSION,
    kind,
    data,
    createdAt: new Date(nextRow * 1000).toISOString(),
    transcriptSeq: nextRow,
    ...overrides,
  });
}

/** A fold with the live document a session keeps beside it. */
function fold(limits?: ConstructorParameters<typeof EntryFold>[2]) {
  const live: LiveState = {};
  const entries = new EntryFold(SESSION, undefined, limits);
  return {
    live,
    apply: (rows: TranscriptEvent[]) => entries.apply(rows, live),
    delta: (delta: TranscriptDelta) => entries.delta(delta, live),
    messages: (inputs: Parameters<EntryFold["messages"]>[0]) =>
      entries.messages(inputs),
    // A sub-agent's conversation, by the ID its call's details name.
    subagent: (id: number) => entries.subagent(id),
    // The entries Pi marks: tool results show inside their call.
    entries: () =>
      entries.current().filter((entry) => entry.kind !== "pi.tool-result"),
    all: () => entries.current(),
    // What a marked entry shows, with its result and live output.
    shown(entry: Entry, people: Attribution = {}): Shown {
      const message = messageOf(entry);
      const call =
        message?.role === "assistant"
          ? message.content.find((block) => block.type === "toolCall")
          : undefined;
      const result = call
        ? entries.current().find((one) => {
            const answer = messageOf(one);
            return (
              answer?.role === "toolResult" && answer.toolCallId === call.id
            );
          })
        : undefined;
      const slot = call
        ? live.tools?.find((one) => one.callId === call.id)
        : undefined;
      // A sub-agent's call names its conversation, as the session view finds it.
      const answer = result ? messageOf(result) : undefined;
      const agent =
        conversationOf(
          answer?.role === "toolResult" ? answer.details : undefined,
        ) ?? conversationOf(slot?.details);
      const conversation =
        agent === undefined ? undefined : entries.subagent(agent)?.current();
      return {
        entry,
        ...(result ? { result } : {}),
        ...(slot ? { slot } : {}),
        ...(conversation ? { conversation: [...conversation] } : {}),
        members: people.members ?? [],
        ...(people.viewerId ? { viewerId: people.viewerId } : {}),
        images: people.images ?? new Map(),
      };
    },
    text: (entry: Entry, people: Attribution = {}) =>
      entryText(entry, people.members ?? [], people.viewerId),
  };
}

interface Attribution {
  members?: WorkspaceMember[];
  viewerId?: string;
  images?: Map<string, string>;
}

// A card as the terminal draws it, with colors.
function raw(shown: Shown | undefined, expanded = false): string {
  return createEntryComponent(
    () => shown,
    expanded,
    theme,
    NO_TERMINAL,
    "/work",
  )
    .render(100)
    .join("\n");
}

// A card as a person reads it, without colors.
function shown(one: Shown | undefined, expanded = false): string {
  return stripVTControlCharacters(raw(one, expanded));
}

describe("Session view entries", () => {
  test("collapses long tool output and keeps the complete expanded result", () => {
    const f = fold();
    const output = Array.from(
      { length: 100 },
      (_, n) => `Result line ${n}`,
    ).join("\n");
    f.apply([
      row("tool_call", {
        toolUseId: "toolu_long",
        name: "bash",
        input: { command: "read report" },
      }),
      row("tool_result", { toolUseId: "toolu_long", content: output }),
    ]);
    const compact = shown(f.shown(f.entries()[0]!));
    expect(compact).toContain("Result line 0");
    expect(compact).toContain("90 more lines");
    expect(compact).not.toContain("Result line 99");
    const expanded = shown(f.shown(f.entries()[0]!), true);
    expect(expanded).toContain("Result line 99");
    // The expanded card also shows the call's arguments.
    expect(expanded).toContain('"command": "read report"');
  });

  test("shows attachment labels without loading or embedding their data", () => {
    const f = fold();
    f.apply([
      row("user", {
        content: "Check this image",
        attachments: [
          {
            filename: "diagram.png",
            contentType: "image/png",
            url: "https://example.invalid/secret",
          },
          {},
        ],
      }),
    ]);
    const entry = f.entries()[0]!;
    expect(f.text(entry)).toContain("Attachment: diagram.png (image/png)");
    expect(f.text(entry)).toContain(
      "Attachment: Attachment (application/octet-stream)",
    );
    expect(f.text(entry)).not.toContain("secret");
    expect(shown(f.shown(entry))).toContain("diagram.png · image/png");
    expect(shown(f.shown(entry))).not.toContain("secret");
  });

  test("renders an inline image as a terminal fallback without its data", () => {
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S7YAAAAASUVORK5CYII=";
    const f = fold();
    f.apply([
      row(
        "user",
        {
          content: "Look at this",
          attachments: [
            {
              filename: "diagram.png",
              contentType: "image/png",
              url: "/api/files/diagram.png",
            },
          ],
        },
        { authorId: "jordan" },
      ),
    ]);
    const text = shown(
      f.shown(f.entries()[0]!, {
        members: [{ id: "jordan", name: "Jordan" }],
        images: new Map([["/api/files/diagram.png", data]]),
      }),
    );
    expect(text).toContain("Jordan");
    expect(text).toContain("diagram.png");
    expect(text).not.toContain(data);
  });

  test("tool calls get the card their kind has in the web app", () => {
    const f = fold();
    const call = (id: string, name: string, input: unknown, output = "") => [
      row("tool_call", { toolUseId: id, name, input }),
      row("tool_result", { toolUseId: id, content: output }),
    ];
    f.apply([
      ...call("t1", "Bash", { command: "bun test\n--watch" }, "3 pass"),
      ...call(
        "t2",
        "Edit",
        {
          file_path: "src/cart.ts",
          old_string: "const total = 0;",
          new_string: "const total = sum(items);",
        },
        "The file was updated",
      ),
      ...call("t3", "ApplyPatch", {
        changes: [
          {
            path: "src/a.ts",
            kind: { type: "update" },
            diff: "@@ -1 +1 @@\n-old line\n+new line",
          },
          { path: "src/b.ts", kind: { type: "add" }, diff: "created" },
        ],
      }),
      ...call("t4", "TodoWrite", {
        todos: [
          { content: "Write tests", status: "completed" },
          {
            content: "Fix bug",
            activeForm: "Fixing the bug",
            status: "in_progress",
          },
          { content: "Ship", status: "pending" },
        ],
      }),
      ...call(
        "t5",
        "Read",
        { file_path: "README.md" },
        "     1\t# Title\n     2\tBody",
      ),
      ...call("t6", "Task", {
        description: "Find flaky tests",
        subagent_type: "Explore",
        prompt: "Look everywhere",
        run_in_background: true,
      }),
      ...call("t7", "mcp__linear__create_issue", { title: "Bug" }, "Created"),
      ...call("t8", "Write", {
        file_path: "/home/.claude/plans/ship.md",
        content: "# Ship it\n1. Migrate",
      }),
      ...call("t9", "ExitPlanMode", {}),
    ]);
    const [shell, edit, patch, todos, read, task, mcp, , plan] = f
      .entries()
      .map((entry) => shown(f.shown(entry)));
    expect(shell).toContain("$ bun test");
    expect(shell).toContain("3 pass");
    expect(edit).toContain("Edit src/cart.ts");
    expect(edit).toMatch(/-\s*1 const total = 0;/);
    expect(edit).toMatch(/\+\s*1 const total = sum\(items\);/);
    expect(edit).not.toContain("The file was updated");
    expect(patch).toContain("Patch 2 files");
    expect(patch).toContain("src/b.ts");
    expect(patch).toContain("new line");
    expect(todos).toContain("Todos 1/3 done");
    expect(todos).toContain("✓ Write tests");
    expect(todos).toContain("▸ Fixing the bug");
    expect(todos).toContain("☐ Ship");
    expect(read).toContain("Read README.md");
    expect(read).toContain("# Title");
    expect(read).not.toContain("1\t# Title");
    expect(task).toContain("Task Find flaky tests · Explore · background");
    expect(mcp).toContain("mcp__linear__create_issue");
    expect(mcp).toContain("Created");
    expect(plan).toContain("Plan");
    expect(plan).toContain("Ship it");
    expect(plan).toContain("1. Migrate");
  });

  test("a stopped turn keeps its unfinished answer", () => {
    const f = fold();
    const people = {
      members: [{ id: "owner", name: "Alice" }],
      viewerId: "owner",
    };
    const streaming = row("text", { content: "", eventId: "evt_cut" });
    f.apply([streaming]);
    f.delta({
      kind: "text",
      streamId: "evt_cut",
      eventId: "evt_cut",
      rowId: streaming.id,
      delta: "The first half of the ans",
      offset: 0,
    });
    f.apply([
      row("interrupted", { cause: "user_stop" }, { authorId: "owner" }),
    ]);
    const [answer, stopped] = f.entries();
    expect(f.text(answer!)).toContain("The first half of the ans");
    expect(f.text(stopped!, people)).toContain("Stopped by Alice (you)");
    expect(shown(f.shown(stopped!, people))).toContain(
      "Stopped by Alice (you)",
    );
  });

  test("reopening keeps every message, including ones sent mid-turn", () => {
    const f = fold();
    const first = input("Run the tests", { status: "consumed" });
    const steer = input("Only the checkout ones", {
      status: "consumed",
      intent: "steer",
    });
    const later = input("And lint too", { status: "consumed" });
    const older = input("From an older page", {
      status: "consumed",
      consumedTranscriptSeq: 1,
    });
    const rows = [
      row(
        "user",
        { content: "### Alice\nRun the tests\nOnly the checkout ones" },
        { sourceInputUuids: [first.uuid, steer.uuid] },
      ),
      row("text", { content: "Running them", finalized: true }),
      row("text", { content: "All pass", finalized: true }),
    ];
    f.apply(rows);
    f.messages([
      first,
      steer,
      { ...later, consumedTranscriptSeq: rows[1]?.transcriptSeq },
      older,
    ]);
    expect(
      f.entries().map((entry) => f.text(entry).split("\n").slice(1).join(" ")),
    ).toEqual([
      "Run the tests",
      "Only the checkout ones",
      "Running them",
      "And lint too",
      "All pass",
    ]);
  });

  test("a sub-agent works inside its Task card, and background work stays open", () => {
    const f = fold();
    f.apply([
      row("tool_call", {
        toolUseId: "toolu_task",
        name: "Task",
        input: { description: "Find flaky tests", subagent_type: "Explore" },
      }),
      row("task", {
        taskId: "task_1",
        taskKind: "agent",
        phase: "started",
        toolUseId: "toolu_task",
      }),
      row("tool_call", {
        toolUseId: "toolu_child",
        name: "Grep",
        input: { pattern: "sleep(" },
        parentToolUseId: "toolu_task",
      }),
      row("text", {
        content: "Found one flaky test",
        eventId: "child_text",
        finalized: true,
        delegatedTaskId: "task_1",
      }),
      row("tool_result", { toolUseId: "toolu_task", content: "Done" }),
      row("tool_call", {
        toolUseId: "toolu_bg",
        name: "Bash",
        input: { command: "bun run dev", run_in_background: true },
      }),
      row("tool_result", { toolUseId: "toolu_bg", content: "Started" }),
      row("task", {
        taskId: "task_2",
        phase: "started",
        backgrounded: true,
        toolUseId: "toolu_bg",
      }),
      row("compaction", { phase: "started", trigger: "manual" }),
    ]);
    f.delta({
      kind: "text",
      streamId: "child_stream",
      rowId: "child_row",
      delta: "Thinking in the sub-agent",
      offset: 0,
      delegatedTaskId: "task_1",
    });
    const [task, background, compaction] = f.entries();
    expect(f.entries()).toHaveLength(3);
    expect(shown(f.shown(task!))).toContain("Task Find flaky tests · Explore");
    expect(shown(f.shown(task!))).toContain("→ Grep sleep(");
    expect(shown(f.shown(task!))).toContain("Found one flaky test");
    // The background command stays a live slot after its result.
    expect(f.live.tools?.map((slot) => slot.callId)).toEqual(["toolu_bg"]);
    expect(shown(f.shown(background!))).toContain("running in the background");
    expect(f.text(compaction!)).toContain("Compacting context…");

    f.apply([
      row("task", {
        taskId: "task_2",
        phase: "settled",
        status: "completed",
        toolUseId: "toolu_bg",
      }),
      row("compaction", { phase: "completed", trigger: "manual" }),
    ]);
    const entries = f.entries();
    expect(entries).toHaveLength(3);
    expect(f.live.tools).toEqual([]);
    expect(shown(f.shown(entries[1]!))).not.toContain(
      "running in the background",
    );
    expect(entries[2]?.kind).toBe("pi.compaction");
    expect(f.text(entries[2]!)).toContain("Context compacted");
    expect(entries.map((one) => f.text(one)).join("\n")).not.toContain(
      "Compacting",
    );
  });

  test("a question is a tool call that shows its options and becomes answered after its result", () => {
    const f = fold();
    f.apply([
      row("ask_user", {
        toolUseId: "toolu_ask",
        input: {
          questions: [
            {
              question: "Which branch?",
              options: [{ label: "main" }, { label: "dev" }],
              multiSelect: false,
            },
          ],
        },
      }),
    ]);
    expect(messageOf(f.entries()[0]!)).toMatchObject({
      content: [{ type: "toolCall", name: "AskUserQuestion" }],
    });
    expect(f.text(f.entries()[0]!)).toBe(
      "Assistant\nQuestion for you\nWhich branch?\n  1. main\n  2. dev",
    );
    expect(shown(f.shown(f.entries()[0]!))).not.toContain("Answered");
    const result = row("tool_result", { toolUseId: "toolu_ask", content: "" });
    f.apply([result, row("user", { answers: { "Which branch?": "main" } })]);
    const before = JSON.stringify(f.all());
    f.apply([result]);
    expect(JSON.stringify(f.all())).toBe(before);
    const [question, answer] = f.entries();
    expect(f.entries()).toHaveLength(2);
    expect(shown(f.shown(question!))).toContain("Answered");
    expect(f.text(answer!)).toContain("Which branch?: main");
  });

  test("strips terminal control sequences from people's names and text", () => {
    const f = fold();
    f.apply([
      row(
        "user",
        { content: "\u001b]52;c;SGVsbG8=\u0007Hello \u001b[31mred\u001b[0m" },
        { authorId: "eve" },
      ),
    ]);
    const rendered = raw(
      f.shown(f.entries()[0]!, {
        members: [{ id: "eve", name: "Eve\u001b[2J" }],
      }),
    );
    expect(rendered).not.toContain("\u001b]52");
    expect(rendered).not.toContain("\u001b[2J");
    expect(rendered).not.toContain("\u001b[31m");
    expect(stripVTControlCharacters(rendered)).toContain("Hello red");
    expect(stripVTControlCharacters(rendered)).toContain("Eve");
  });
});
