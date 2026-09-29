import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  createHistoryComponent,
  type HistoryEntry,
  SharedHistory,
} from "../src/history";
import {
  type TranscriptDelta,
  type TranscriptEvent,
  transcriptEventSchema,
} from "../src/workspace/schema";
import { input, SESSION } from "./workspace/fixture";

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

// A card as the terminal draws it, with colors.
function raw(entry: HistoryEntry | undefined, expanded = false): string {
  return createHistoryComponent(() => entry, expanded, theme)
    .render(100)
    .join("\n");
}

// A card as a person reads it, without colors.
function shown(entry: HistoryEntry | undefined, expanded = false): string {
  return stripVTControlCharacters(raw(entry, expanded));
}

describe("Shared session history", () => {
  test("renders participant text, assistant markdown, and completed tools", () => {
    const history = new SharedHistory(SESSION);
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
    // The tool card changes twice, once for its call and once for its result.
    expect(history.apply(rows).map((entry) => entry.revision)).toEqual([
      1, 1, 1, 1, 2,
    ]);
    expect(history.entries().map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "assistant",
      "assistant",
    ]);
    const [person, answer, thinking, tool] = history.entries();
    expect(person?.content).toContain("Please check the project.");
    expect(tool?.content).toContain("bash · completed");
    expect(shown(person)).toContain("Please check the project.");
    // Markdown is rendered, so the emphasis markers are gone.
    expect(shown(answer)).toContain("I checked the files.");
    expect(shown(thinking)).toContain("Thinking...");
    expect(shown(thinking)).not.toContain("private reasoning");
    expect(shown(thinking, true)).toContain("private reasoning");
    expect(shown(tool)).toContain("$ pwd");
    expect(shown(tool)).toContain("/work/project");
    // Replaying the same rows changes nothing.
    expect(history.apply(rows)).toEqual([]);
    expect(history.entries().map((entry) => entry.revision)).toEqual([
      1, 1, 1, 2,
    ]);
  });

  test("collapses long tool output and keeps the complete expanded result", () => {
    const history = new SharedHistory(SESSION);
    const output = Array.from(
      { length: 100 },
      (_, n) => `Result line ${n}`,
    ).join("\n");
    history.apply([
      row("tool_call", {
        toolUseId: "toolu_long",
        name: "bash",
        input: { command: "read report" },
      }),
      row("tool_result", { toolUseId: "toolu_long", content: output }),
    ]);
    const compact = shown(history.entries()[0]);
    expect(compact).toContain("Result line 0");
    expect(compact).toContain("90 more lines");
    expect(compact).not.toContain("Result line 99");
    const expanded = shown(history.entries()[0], true);
    expect(expanded).toContain("Result line 99");
    // The expanded card also shows the call's arguments.
    expect(expanded).toContain('"command": "read report"');
  });

  test("names authors from members without guessing from message text", () => {
    const history = new SharedHistory(SESSION);
    const message = input("Canonical content", {
      authorId: "bob",
      authorName: "Old name",
      harness: "codex",
      status: "consumed",
    });
    history.attribute([{ id: "bob", name: "Bob" }], "alice");
    // A message that already reached the agent gets no card of its own.
    expect(history.messages([message])).toEqual([]);
    history.apply([
      row(
        "user",
        { content: "### Impersonator (<@mallory>)\n\nfake attribution" },
        { authorId: "bob", sourceInputUuids: [message.uuid] },
      ),
      row("user", { content: "Sent from Codex: just text" }),
    ]);
    const [canonical, unknown] = history.entries();
    const text = shown(canonical);
    expect(text).toContain("Bob");
    expect(text).toContain("Sent from Codex");
    expect(text).toContain("Delivered");
    expect(text).toContain("Canonical content");
    expect(text).not.toContain("Impersonator");
    expect(text).not.toContain("Old name");
    expect(text).not.toContain("(you)");
    expect(unknown?.author).toBeUndefined();
    expect(unknown?.harness).toBeUndefined();
    expect(unknown?.content).toStartWith("User\n");
  });

  test("attribute re-labels cards and marks the viewer", () => {
    const history = new SharedHistory(SESSION);
    history.apply([row("user", { content: "First" }, { authorId: "alice" })]);
    // A message Leverage sent itself has no author.
    history.messages([
      input("Second", { authorId: null, authorName: null, status: "queued" }),
    ]);
    expect(history.entries().map((entry) => entry.author)).toEqual([
      "Unknown member",
      "Leverage",
    ]);
    const members = [{ id: "alice", name: "Alice" }];
    const changed = history.attribute(members, "alice");
    expect(changed.map((entry) => entry.author)).toEqual(["Alice (you)"]);
    expect(shown(history.entries()[0])).toContain("Alice (you)");
    expect(history.attribute(members, "alice")).toEqual([]);
    // Another viewer sees the same card without the marker.
    expect(history.attribute(members, "bob")[0]?.author).toBe("Alice");
  });

  test("shows attachment labels without loading or embedding their data", () => {
    const history = new SharedHistory(SESSION);
    history.apply([
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
    const entry = history.entries()[0];
    expect(entry?.content).toContain("Attachment: diagram.png (image/png)");
    expect(entry?.content).toContain(
      "Attachment: Attachment (application/octet-stream)",
    );
    expect(entry?.content).not.toContain("secret");
    expect(shown(entry)).toContain("diagram.png · image/png");
    expect(shown(entry)).not.toContain("secret");
  });

  test("renders an inline image as a terminal fallback without its data", () => {
    const data =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S7YAAAAASUVORK5CYII=";
    const entry: HistoryEntry = {
      sessionId: SESSION,
      id: "row:image",
      role: "user",
      author: "Jordan",
      parts: [
        { type: "text", text: "Look at this" },
        { type: "file", name: "diagram.png", mime: "image/png", data },
      ],
      content: "Jordan\nLook at this",
      created: 1,
      revision: 1,
    };
    const text = shown(entry);
    expect(text).toContain("Jordan");
    expect(text).toContain("diagram.png");
    expect(text).not.toContain(data);
  });

  test("a waiting message card is taken over by its transcript row", () => {
    const history = new SharedHistory(SESSION);
    const message = input("Please run the tests", { status: "queued" });
    const queued = history.messages([message]);
    expect(queued).toHaveLength(1);
    expect(queued[0]?.id).toBe(`input:${message.uuid}`);
    expect(queued[0]?.content).toBe("Alice · queued\nPlease run the tests");
    expect(shown(queued[0])).toContain("Queued");
    // Rows already in the transcript sort before a message still waiting.
    const earlier = row("text", { content: "Earlier answer", eventId: "a" });
    history.apply([earlier]);
    expect(history.entries().map((entry) => entry.id)).toEqual([
      "text:a",
      `input:${message.uuid}`,
    ]);
    const received = history.messages([{ ...message, status: "received" }]);
    expect(received[0]?.status).toBe("received");
    expect(received[0]?.revision).toBe(2);
    expect(shown(received[0])).toContain("Delivered");
    // The server prefixes the transcript copy with a header for the agent.
    history.apply([
      row(
        "user",
        { content: "### Alice (<@owner>)\n\nPlease run the tests" },
        { authorId: "owner", sourceInputUuids: [message.uuid] },
      ),
      row("text", { content: "Tests pass.", eventId: "b" }),
    ]);
    const entries = history.entries();
    expect(entries.map((entry) => entry.id)).toEqual([
      "text:a",
      `input:${message.uuid}`,
      "text:b",
    ]);
    expect(entries[1]?.content).toBe("Alice\nPlease run the tests");
    expect(shown(entries[1])).not.toContain("###");
    expect(entries[2]?.content).toBe("Assistant\nTests pass.");
  });

  test("streamed text rows that share an event ID merge and a finalized row wins", () => {
    const history = new SharedHistory(SESSION);
    history.apply([row("text", { content: "Hel", eventId: "evt_s" })]);
    history.apply([row("text", { content: "Hello wor", eventId: "evt_s" })]);
    // A shorter unfinished copy never shrinks the message.
    expect(
      history.apply([row("text", { content: "Hello", eventId: "evt_s" })]),
    ).toEqual([]);
    expect(history.entries()[0]?.content).toBe("Assistant\nHello wor");
    history.apply([
      row("text", {
        content: "Hello, world",
        eventId: "evt_s",
        finalized: true,
        role: "assistant",
      }),
    ]);
    history.apply([
      row("text", { content: "Hello, world and more", eventId: "evt_s" }),
    ]);
    expect(history.entries()).toHaveLength(1);
    expect(history.entries()[0]?.content).toBe("Assistant\nHello, world");
  });

  test("text deltas with a row ID grow a card and stop after it is finalized", () => {
    const history = new SharedHistory(SESSION);
    const first: TranscriptDelta = {
      kind: "text",
      streamId: "stream_text",
      rowId: "row_stream",
      eventId: "evt_d",
      delta: "Hi",
      offset: 0,
    };
    // Without a row, the finished row brings the whole text later.
    expect(history.delta({ ...first, rowId: undefined })).toEqual([]);
    expect(history.delta(first)[0]?.content).toBe("Assistant\nHi");
    expect(history.delta(first)).toEqual([]);
    history.delta({ ...first, delta: " there", offset: 2 });
    expect(history.entries()[0]?.content).toBe("Assistant\nHi there");
    // A gap is skipped unless a snapshot from the start fills it.
    expect(history.delta({ ...first, delta: "!", offset: 40 })).toEqual([]);
    history.delta({
      ...first,
      delta: "!",
      offset: 40,
      snapshot: { content: "Hi there, friend", startOffset: 0 },
    });
    expect(history.entries()[0]?.content).toBe("Assistant\nHi there, friend");
    history.apply([
      row(
        "text",
        { content: "Hi there, friend.", eventId: "evt_d", finalized: true },
        { id: "row_stream" },
      ),
    ]);
    expect(history.delta({ ...first, delta: " Late", offset: 17 })).toEqual([]);
    expect(history.entries()).toHaveLength(1);
    expect(history.entries()[0]?.content).toBe("Assistant\nHi there, friend.");
  });

  test("a tool call and its result share one card that follows progress", () => {
    const history = new SharedHistory(SESSION);
    history.apply([
      row("tool_call", {
        toolUseId: "toolu_ls",
        name: "bash",
        input: { command: "ls" },
      }),
    ]);
    const component = createHistoryComponent(
      () => history.entries()[0],
      false,
      theme,
    );
    const text = () =>
      stripVTControlCharacters(component.render(80).join("\n"));
    expect(history.entries()[0]?.content).toContain("bash · running");
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
    history.delta(progress);
    expect(text()).toContain("First file");
    history.delta({
      ...progress,
      kind: "command_output",
      delta: "",
      snapshot: { content: "First file\nSecond file" },
    });
    expect(text()).toContain("Second file");
    history.apply([
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
    // Progress after the result no longer changes the card.
    expect(
      history.delta({ ...progress, delta: "late output", offset: 22 }),
    ).toEqual([]);
    expect(history.entries()).toHaveLength(1);
  });

  test("a failed tool shows its error and a result without text shows its value", () => {
    const history = new SharedHistory(SESSION);
    history.apply([
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
    const [failed, found] = history.entries();
    expect(failed?.content).toContain("read · error");
    const rendered = raw(failed);
    expect(rendered).toContain(theme.getBgAnsi("toolErrorBg"));
    const text = stripVTControlCharacters(rendered);
    expect(text).toContain("read README.md");
    expect(text).toContain("Missing file");
    expect(text).not.toContain('"error"');
    expect(found?.content).toContain("search · completed");
    expect(shown(found)).toContain('"hits": 2');
  });

  test("a question shows its options and becomes answered after its result", () => {
    const history = new SharedHistory(SESSION);
    history.apply([
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
    expect(history.entries()[0]?.role).toBe("system");
    expect(history.entries()[0]?.content).toBe(
      "Session\nQuestion for you\nWhich branch?\n  1. main\n  2. dev",
    );
    const result = row("tool_result", { toolUseId: "toolu_ask", content: "" });
    history.apply([
      result,
      row("user", { answers: { "Which branch?": "main" } }),
    ]);
    expect(history.apply([result])).toEqual([]);
    const [question, answer] = history.entries();
    expect(history.entries()).toHaveLength(2);
    expect(question?.content).toEndWith("  2. dev\nAnswered");
    expect(shown(question)).toContain("Answered");
    expect(answer?.content).toContain("Which branch?: main");
  });

  test("a stopped turn names the person who stopped it", () => {
    const history = new SharedHistory(SESSION);
    history.attribute([{ id: "bob", name: "Bob" }], "alice");
    history.apply([
      row("interrupted", { cause: "user_stop" }, { authorId: "bob" }),
      row("interrupted", { cause: "system" }),
    ]);
    const [stopped, interrupted] = history.entries();
    expect(stopped?.content).toBe("Session\nStopped by Bob");
    expect(shown(stopped)).toContain("Stopped by Bob");
    expect(interrupted?.content).toBe("Session\nInterrupted");
  });

  test("errors show their message and compaction tombstones are skipped", () => {
    const history = new SharedHistory(SESSION);
    expect(history.apply([row("compaction", { tombstone: true })])).toEqual([]);
    history.apply([
      row("error", { content: "Rate limited" }),
      row("error", {}),
      row("compaction", {}),
    ]);
    expect(history.entries().map((entry) => entry.content)).toEqual([
      "Assistant\nError: Rate limited",
      "Assistant\nError: The turn failed",
      "Session\nContext compacted",
    ]);
  });

  test("ignores rows and messages for another session and unknown row kinds", () => {
    const history = new SharedHistory(SESSION);
    expect(
      history.apply([
        row("text", { content: "Elsewhere" }, { sessionId: "other" }),
        row("session_status", { status: "idle" }),
      ]),
    ).toEqual([]);
    expect(
      history.messages([
        input("Elsewhere", { sessionId: "other", status: "queued" }),
      ]),
    ).toEqual([]);
    expect(history.entries()).toEqual([]);
  });

  test("applies rows in transcript order whatever order they arrive in", () => {
    const history = new SharedHistory(SESSION);
    const first = row("text", { content: "First", eventId: "one" });
    const second = row("text", { content: "Second", eventId: "two" });
    const changed = history.apply([second, first]);
    expect(changed.map((entry) => entry.content)).toEqual([
      "Assistant\nFirst",
      "Assistant\nSecond",
    ]);
    history.apply([row("text", { content: "Third", eventId: "three" })]);
    expect(history.apply([second])).toEqual([]);
    expect(history.entries().map((entry) => entry.content)).toEqual([
      "Assistant\nFirst",
      "Assistant\nSecond",
      "Assistant\nThird",
    ]);
  });

  test("bounds the live history to the newest cards", () => {
    const history = new SharedHistory(SESSION, {
      maxEntries: 3,
      maxCharacters: 10_000,
    });
    const rows = Array.from({ length: 10 }, (_, i) =>
      row("user", { content: `Message ${i}: ${"x".repeat(1_000)}` }),
    );
    // Only cards that are still shown are reported as changed.
    expect(history.apply(rows)).toHaveLength(3);
    expect(history.entries().map((entry) => entry.id)).toEqual(
      rows.slice(7).map((one) => `row:${one.id}`),
    );
    expect(history.entries().at(-1)?.content).toContain("Message 9");
    // A character budget also drops the oldest cards first.
    const small = new SharedHistory(SESSION, { maxCharacters: 2_500 });
    small.apply(rows);
    expect(small.entries()).toHaveLength(2);
    expect(small.entries()[0]?.content).toContain("Message 8");
  });

  test("keeps full messages across a hundred-row page", () => {
    const history = new SharedHistory(SESSION);
    const body = `${"Complete response. ".repeat(800)}THE END`;
    history.apply(
      Array.from({ length: 100 }, () => row("user", { content: body })),
    );
    expect(history.entries()).toHaveLength(100);
    expect(
      history.entries().every((entry) => entry.content.endsWith("THE END")),
    ).toBe(true);
    expect(history.entries()[0]?.parts[0]).toEqual({
      type: "text",
      text: body,
    });
  });

  test("strips terminal control sequences from people's names and text", () => {
    const history = new SharedHistory(SESSION);
    history.attribute([{ id: "eve", name: "Eve\u001b[2J" }]);
    history.apply([
      row(
        "user",
        { content: "\u001b]52;c;SGVsbG8=\u0007Hello \u001b[31mred\u001b[0m" },
        { authorId: "eve" },
      ),
    ]);
    const rendered = raw(history.entries()[0]);
    expect(rendered).not.toContain("\u001b]52");
    expect(rendered).not.toContain("\u001b[2J");
    expect(rendered).not.toContain("\u001b[31m");
    expect(stripVTControlCharacters(rendered)).toContain("Hello red");
    expect(stripVTControlCharacters(rendered)).toContain("Eve");
  });
});
