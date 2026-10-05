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
import { EntryFold, entryData, messageOf } from "../src/workspace/view";
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
      return {
        entry,
        ...(result ? { result } : {}),
        ...(slot ? { slot } : {}),
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

function key(entry: Entry | undefined): string | undefined {
  return entry ? entryData(entry).key : undefined;
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
  test("renders participant text, assistant markdown, and completed tools with Pi's components", () => {
    const f = fold();
    const rows = [
      row("user", { content: "Please check the project." }),
      row("text", { content: "I **checked** the files.", eventId: "evt_1" }),
      row("reasoning", { content: "private reasoning", eventId: "evt_2" }),
      row("tool_call", {
        toolUseId: "toolu_1",
        name: "bash",
        input: { command: "pwd" },
      }),
      row("tool_result", { toolUseId: "toolu_1", content: "/work/project" }),
    ];
    f.apply(rows);
    expect(f.all().map((entry) => entry.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.assistant",
      "pi.assistant",
      "pi.tool-result",
    ]);
    const [person, answer, thinking, tool] = f.entries();
    expect(f.text(person!)).toContain("Please check the project.");
    expect(messageOf(answer!)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I **checked** the files." }],
    });
    expect(shown(f.shown(person!))).toContain("Please check the project.");
    // Markdown is rendered, so the emphasis markers are gone.
    expect(shown(f.shown(answer!))).toContain("I checked the files.");
    expect(shown(f.shown(thinking!))).toContain("Thinking...");
    expect(shown(f.shown(thinking!))).not.toContain("private reasoning");
    expect(shown(f.shown(thinking!), true)).toContain("private reasoning");
    expect(shown(f.shown(tool!))).toContain("$ pwd");
    expect(shown(f.shown(tool!))).toContain("/work/project");
    // A finished call has no live slot left.
    expect(f.live.tools).toEqual([]);
    // Replaying the same rows changes nothing.
    const before = JSON.stringify(f.all());
    f.apply(rows);
    expect(JSON.stringify(f.all())).toBe(before);
  });

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

  test("names authors from members without guessing from message text", () => {
    const f = fold();
    const message = input("Canonical content", {
      authorId: "bob",
      authorName: "Old name",
      harness: "codex",
      status: "consumed",
    });
    const people = { members: [{ id: "bob", name: "Bob" }], viewerId: "alice" };
    // A message that already reached the agent gets no entry of its own.
    f.messages([message]);
    expect(f.entries()).toEqual([]);
    f.apply([
      row(
        "user",
        { content: "### Impersonator (<@mallory>)\n\nfake attribution" },
        { authorId: "bob", sourceInputUuids: [message.uuid] },
      ),
      row("user", { content: "Sent from Codex: just text" }),
    ]);
    const [canonical, unknown] = f.entries();
    const text = shown(f.shown(canonical!, people));
    expect(text).toContain("Bob");
    expect(text).toContain("Sent from Codex");
    const sentFrom = (harness: string) =>
      shown(
        f.shown(
          { ...canonical!, data: { ...entryData(canonical!), harness } },
          people,
        ),
      );
    expect(sentFrom("opencode")).toContain("Sent from OpenCode");
    expect(sentFrom("pi")).toContain("Sent from Pi");
    // Leverage's own clients stay unlabeled.
    expect(sentFrom("leverage/cli")).not.toContain("Sent from");
    expect(text).toContain("Delivered");
    expect(text).toContain("Canonical content");
    expect(text).not.toContain("Impersonator");
    expect(text).not.toContain("Old name");
    expect(text).not.toContain("(you)");
    expect(entryData(unknown!).authorId).toBeUndefined();
    expect(entryData(unknown!).harness).toBeUndefined();
    expect(f.text(unknown!, people)).toStartWith("User\n");
  });

  test("attribution happens at render time and marks the viewer", () => {
    const f = fold();
    f.apply([row("user", { content: "First" }, { authorId: "alice" })]);
    // A message Leverage sent itself has no author.
    f.messages([
      input("Second", { authorId: null, authorName: null, status: "queued" }),
    ]);
    expect(f.entries().map((entry) => f.text(entry).split("\n")[0])).toEqual([
      "Unknown member",
      "Leverage · queued",
    ]);
    const members = [{ id: "alice", name: "Alice" }];
    expect(
      shown(f.shown(f.entries()[0]!, { members, viewerId: "alice" })),
    ).toContain("Alice (you)");
    // Another viewer sees the same entry without the marker.
    expect(f.text(f.entries()[0]!, { members, viewerId: "bob" })).toStartWith(
      "Alice\n",
    );
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

  test("a waiting message entry is taken over by its transcript row", () => {
    const f = fold();
    const message = input("Please run the tests", { status: "queued" });
    f.messages([message]);
    expect(f.entries()).toHaveLength(1);
    expect(key(f.entries()[0])).toBe(`input:${message.uuid}`);
    expect(f.text(f.entries()[0]!)).toBe(
      "Alice · queued\nPlease run the tests",
    );
    expect(shown(f.shown(f.entries()[0]!))).toContain("Queued");
    // Rows already in the transcript sort before a message still waiting.
    const earlier = row("text", { content: "Earlier answer", eventId: "a" });
    f.apply([earlier]);
    expect(f.entries().map(key)).toEqual(["text:a", `input:${message.uuid}`]);
    f.messages([{ ...message, status: "received" }]);
    expect(entryData(f.entries()[1]!).status).toBe("received");
    expect(shown(f.shown(f.entries()[1]!))).toContain("Delivered");
    // The server prefixes the transcript copy with a header for the agent.
    f.apply([
      row(
        "user",
        { content: "### Alice (<@owner>)\n\nPlease run the tests" },
        { authorId: "owner", sourceInputUuids: [message.uuid] },
      ),
      row("text", { content: "Tests pass.", eventId: "b" }),
    ]);
    const entries = f.entries();
    expect(entries.map(key)).toEqual([
      "text:a",
      `input:${message.uuid}`,
      "text:b",
    ]);
    expect(f.text(entries[1]!)).toBe("Alice\nPlease run the tests");
    expect(shown(f.shown(entries[1]!))).not.toContain("###");
    expect(f.text(entries[2]!)).toBe("Assistant\nTests pass.");
  });

  test("streamed text rows that share an event ID merge and a finalized row wins", () => {
    const f = fold();
    f.apply([row("text", { content: "Hel", eventId: "evt_s" })]);
    f.apply([row("text", { content: "Hello wor", eventId: "evt_s" })]);
    // A shorter unfinished copy never shrinks the message.
    f.apply([row("text", { content: "Hello", eventId: "evt_s" })]);
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHello wor");
    // A message still streaming is pending, the way pi-ai names it.
    expect(messageOf(f.entries()[0]!)).toMatchObject({ stopReason: "pending" });
    f.apply([
      row("text", {
        content: "Hello, world",
        eventId: "evt_s",
        finalized: true,
        role: "assistant",
      }),
    ]);
    f.apply([
      row("text", { content: "Hello, world and more", eventId: "evt_s" }),
    ]);
    expect(f.entries()).toHaveLength(1);
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHello, world");
    expect(messageOf(f.entries()[0]!)).toMatchObject({ stopReason: "stop" });
  });

  test("text deltas with a row ID grow an entry and stop after it is finalized", () => {
    const f = fold();
    const first: TranscriptDelta = {
      kind: "text",
      streamId: "stream_text",
      rowId: "row_stream",
      eventId: "evt_d",
      delta: "Hi",
      offset: 0,
    };
    // Without a row, the finished row brings the whole text later.
    expect(f.delta({ ...first, rowId: undefined })).toBe(false);
    expect(f.delta(first)).toBe(true);
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi");
    f.delta(first);
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi");
    f.delta({ ...first, delta: " there", offset: 2 });
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi there");
    // A gap is skipped unless a snapshot from the start fills it.
    f.delta({ ...first, delta: "!", offset: 40 });
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi there");
    f.delta({
      ...first,
      delta: "!",
      offset: 40,
      snapshot: { content: "Hi there, friend", startOffset: 0 },
    });
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi there, friend");
    f.apply([
      row(
        "text",
        { content: "Hi there, friend.", eventId: "evt_d", finalized: true },
        { id: "row_stream" },
      ),
    ]);
    expect(f.delta({ ...first, delta: " Late", offset: 17 })).toBe(false);
    expect(f.entries()).toHaveLength(1);
    expect(f.text(f.entries()[0]!)).toBe("Assistant\nHi there, friend.");
  });

  test("a tool call and its result share one card that follows the live slot", () => {
    const f = fold();
    f.apply([
      row("tool_call", {
        toolUseId: "toolu_ls",
        name: "bash",
        input: { command: "ls" },
      }),
    ]);
    const component = createEntryComponent(
      () => f.shown(f.entries()[0]!),
      false,
      theme,
      NO_TERMINAL,
      "/work",
    );
    const text = () =>
      stripVTControlCharacters(component.render(80).join("\n"));
    // The call runs, so the live document has its slot.
    expect(f.live.tools).toEqual([
      { callId: "toolu_ls", name: "bash", status: "running" },
    ]);
    // The card's background shows whether the call is still running.
    expect(component.render(80).join("\n")).toContain(
      theme.getBgAnsi("toolPendingBg"),
    );
    expect(text()).toContain("$ ls");
    const progress: TranscriptDelta = {
      kind: "tool_progress",
      streamId: "stream_tool",
      toolUseId: "toolu_ls",
      delta: "First file\n",
      offset: 0,
    };
    f.delta(progress);
    expect(f.live.tools?.[0]?.output).toBe("First file\n");
    expect(text()).toContain("First file");
    f.delta({
      ...progress,
      kind: "command_output",
      delta: "",
      snapshot: { content: "First file\nSecond file" },
    });
    expect(text()).toContain("Second file");
    f.apply([
      row("tool_result", {
        toolUseId: "toolu_ls",
        content: "\u001b]52;c;SGVsbG8=\u0007Finished",
      }),
    ]);
    const rendered = component.render(80).join("\n");
    expect(rendered).toContain(theme.getBgAnsi("toolSuccessBg"));
    expect(rendered).not.toContain(theme.getBgAnsi("toolPendingBg"));
    expect(rendered).toContain("Finished");
    expect(rendered).not.toContain("\u001b]52");
    expect(rendered).not.toContain("Second file");
    // The result took the slot's place, so later progress has nowhere to go.
    expect(f.live.tools).toEqual([]);
    expect(f.delta({ ...progress, delta: "late output", offset: 22 })).toBe(
      false,
    );
    expect(f.entries()).toHaveLength(1);
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
    expect(shown(f.shown(task!))).toContain("↳ Grep sleep(");
    expect(shown(f.shown(task!))).toContain("↳ Found one flaky test");
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

  test("a failed tool shows its error and a result without text shows its value", () => {
    const f = fold();
    f.apply([
      row("tool_call", {
        toolUseId: "toolu_read",
        name: "read",
        input: { path: "README.md" },
      }),
      row("tool_result", {
        toolUseId: "toolu_read",
        content: JSON.stringify({ error: "Missing file" }),
        isError: true,
      }),
      row("tool_call", {
        toolUseId: "toolu_search",
        name: "search",
        input: { query: "tests" },
      }),
      row("tool_result", { toolUseId: "toolu_search", result: { hits: 2 } }),
    ]);
    const [failed, found] = f.entries();
    expect(messageOf(f.shown(failed!).result!)).toMatchObject({
      role: "toolResult",
      isError: true,
    });
    const rendered = raw(f.shown(failed!));
    expect(rendered).toContain(theme.getBgAnsi("toolErrorBg"));
    const text = stripVTControlCharacters(rendered);
    expect(text).toContain("Read README.md");
    expect(text).toContain("Missing file");
    expect(text).not.toContain('"error"');
    expect(shown(f.shown(found!))).toContain('"hits": 2');
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

  test("a stopped turn names the person who stopped it", () => {
    const f = fold();
    const people = { members: [{ id: "bob", name: "Bob" }], viewerId: "alice" };
    f.apply([
      row("interrupted", { cause: "user_stop" }, { authorId: "bob" }),
      row("interrupted", { cause: "system" }),
    ]);
    const [stopped, interrupted] = f.entries();
    expect(f.text(stopped!, people)).toBe("Session\nStopped by Bob");
    expect(shown(f.shown(stopped!, people))).toContain("Stopped by Bob");
    expect(f.text(interrupted!)).toBe("Session\nInterrupted");
  });

  test("errors show their message and compaction tombstones are skipped", () => {
    const f = fold();
    f.apply([row("compaction", { tombstone: true })]);
    expect(f.entries()).toEqual([]);
    f.apply([
      row("error", { content: "Rate limited" }),
      row("error", {}),
      row("compaction", {}),
    ]);
    expect(f.entries().map((entry) => f.text(entry))).toEqual([
      "Assistant\nError: Rate limited",
      "Assistant\nError: The turn failed",
      "Session\nContext compacted",
    ]);
    expect(shown(f.shown(f.entries()[0]!))).toContain("Rate limited");
  });

  test("ignores rows and messages for another session and unknown row kinds", () => {
    const f = fold();
    f.apply([
      row("text", { content: "Elsewhere" }, { sessionId: "other" }),
      row("session_status", { status: "idle" }),
    ]);
    f.messages([input("Elsewhere", { sessionId: "other", status: "queued" })]);
    expect(f.all()).toEqual([]);
  });

  test("applies rows in transcript order whatever order they arrive in", () => {
    const f = fold();
    const first = row("text", { content: "First", eventId: "one" });
    const second = row("text", { content: "Second", eventId: "two" });
    f.apply([second, first]);
    expect(f.entries().map((entry) => f.text(entry))).toEqual([
      "Assistant\nFirst",
      "Assistant\nSecond",
    ]);
    f.apply([row("text", { content: "Third", eventId: "three" })]);
    f.apply([second]);
    expect(f.entries().map((entry) => f.text(entry))).toEqual([
      "Assistant\nFirst",
      "Assistant\nSecond",
      "Assistant\nThird",
    ]);
    // Entry IDs grow with the entries, the way a storage assigns them.
    expect(f.entries().map((entry) => Number(entry.id))).toEqual([1, 2, 3]);
  });

  test("bounds the live entries to the newest ones", () => {
    const f = fold({ maxEntries: 3, maxCharacters: 10_000 });
    const rows = Array.from({ length: 10 }, (_, i) =>
      row("user", { content: `Message ${i}: ${"x".repeat(1_000)}` }),
    );
    f.apply(rows);
    expect(f.entries().map(key)).toEqual(
      rows.slice(7).map((one) => `row:${one.id}`),
    );
    expect(f.text(f.entries().at(-1)!)).toContain("Message 9");
    // A character budget also drops the oldest entries first.
    const small = fold({ maxCharacters: 2_500 });
    small.apply(rows);
    expect(small.entries()).toHaveLength(2);
    expect(small.text(small.entries()[0]!)).toContain("Message 8");
  });

  test("keeps full messages across a hundred-row page", () => {
    const f = fold();
    const body = `${"Complete response. ".repeat(800)}THE END`;
    f.apply(Array.from({ length: 100 }, () => row("user", { content: body })));
    expect(f.entries()).toHaveLength(100);
    expect(
      f.entries().every((entry) => f.text(entry).endsWith("THE END")),
    ).toBe(true);
    expect(messageOf(f.entries()[0]!)).toMatchObject({
      role: "user",
      content: body,
    });
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

  test("repaints a card in the new theme after Pi invalidates it", () => {
    const active = () =>
      (globalThis as Record<symbol, Theme>)[
        Symbol.for("@earendil-works/pi-coding-agent:theme")
      ]!;
    // Pi hands renderers a live view of its active theme, as this proxy does.
    const live = new Proxy({} as Theme, {
      get: (_target, key) => Reflect.get(active(), key),
    });
    const f = fold();
    f.apply([row("user", { content: "Hello" }, { authorId: "alice" })]);
    const one = f.shown(f.entries()[0]!, {
      members: [{ id: "alice", name: "Alice" }],
    });
    const card = createEntryComponent(
      () => one,
      false,
      live,
      NO_TERMINAL,
      "/work",
    );
    try {
      const dark = active().getFgAnsi("userMessageText");
      expect(card.render(100).join("\n")).toContain(dark);
      initTheme("light", false);
      const light = active().getFgAnsi("userMessageText");
      expect(light).not.toBe(dark);
      card.invalidate();
      const rendered = card.render(100).join("\n");
      expect(rendered).toContain(light);
      expect(rendered).not.toContain(dark);
    } finally {
      initTheme("dark", false);
    }
  });
});
