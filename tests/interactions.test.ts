import { afterEach, describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import type {
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { type ModelChoice, PendingInteractions } from "../src/interactions";
import { SessionReplica } from "../src/workspace/view";
import {
  eventually,
  hostedModel,
  input,
  invocation,
  MEMBER,
  SESSION,
  workspaceFixture,
} from "./workspace/fixture";

const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) {
    await dispose();
  }
});

type Fixture = ReturnType<typeof workspaceFixture>;

// Frames that only keep the connection and subscription alive.
const housekeeping = new Set([
  "session.subscribe",
  "session.unsubscribe",
  "presence.heartbeat",
]);

/**
 * A shared session read through the local Leverage, with Pi dialogs that
 * answer from a script.
 */
async function setup(
  options: {
    ui?: Partial<ExtensionUIContext>;
    user?: string;
    prepare?: (f: Fixture) => void;
    chooseModel?: (choice: ModelChoice) => void;
  } = {},
) {
  const f = workspaceFixture();
  options.prepare?.(f);
  f.client(options.user);
  const notifications: string[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify: (message: string) => notifications.push(message),
      ...options.ui,
    },
  } as ExtensionContext;
  const controller = new AbortController();
  let pending: PendingInteractions | undefined;
  const shared = new SessionReplica(SESSION, () => {});
  shared.state.subscribe(() => pending?.sync());
  disposals.push(async () => {
    controller.abort();
    shared.close();
    await f.close();
  });
  await shared.start(controller.signal);
  pending = new PendingInteractions(
    ctx,
    shared,
    controller.signal,
    () => shared.doc.canWrite && !shared.doc.revoked,
    options.chooseModel,
  );
  return {
    f,
    shared,
    pending,
    notifications,
    controller,
    // Decisions this client posted, with the invocation each one decided.
    decisions: () =>
      f.requests
        .filter((one) => one.path.endsWith("/decide"))
        .map(
          (one): Record<string, unknown> => ({
            path: one.path,
            ...one.body,
          }),
        ),
    // Socket frames that act on the session.
    actions: () =>
      f.frames.filter((one) => !housekeeping.has(String(one.type))),
  };
}

function decided(id: string) {
  return `/api/tool-invocations/${id}/decide`;
}

// A select dialog that stays open until something closes it.
function held(answer: string | undefined) {
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const select: ExtensionUIContext["select"] = (_title, _options, opts) =>
    new Promise((resolve) => {
      opts?.signal?.addEventListener("abort", () => resolve(answer), {
        once: true,
      });
      opened();
    });
  return { ready, select };
}

// The agent asks the person one or more questions.
function ask(
  f: Fixture,
  questions: Array<{
    question: string;
    options: string[];
    multiSelect?: boolean;
  }>,
) {
  f.emit("ask_user", {
    toolUseId: "toolu_q",
    input: {
      questions: questions.map((one) => ({
        question: one.question,
        options: one.options.map((label) => ({ label })),
        multiSelect: one.multiSelect === true,
      })),
    },
  });
}

describe("tool approvals", () => {
  test("viewers can inspect tool arguments but cannot decide approvals", async () => {
    const titles: string[] = [];
    const { f, pending, decisions } = await setup({
      user: MEMBER,
      prepare: (f) => {
        f.session.visibility = "workspace";
      },
      ui: {
        select: async (title, options) => {
          titles.push(title);
          expect(options).toEqual(["Back"]);
          return "Back";
        },
      },
    });
    f.approvals.push(invocation({ originalArguments: { branch: "feature" } }));
    await pending.show("approvals");
    expect(titles).toHaveLength(1);
    expect(titles[0]).toContain("Read-only");
    expect(titles[0]).toContain('"branch": "feature"');
    expect(titles[0]).toContain("Runs as Alice");
    expect(decisions()).toEqual([]);
    expect(pending.approvalCount).toBe(1);
  });

  test("losing write access closes an open approval without sending a decision", async () => {
    const dialog = held("Approve once");
    const { f, shared, pending, decisions } = await setup({
      user: MEMBER,
      prepare: (f) => {
        f.session.visibility = "workspace";
        f.grants.push({
          principalType: "user",
          principalId: MEMBER,
          role: "collaborator",
        });
      },
      ui: { select: dialog.select },
    });
    f.approvals.push(invocation());
    expect(shared.doc.canWrite).toBe(true);
    const showing = pending.show("approvals");
    await dialog.ready;
    f.grants.splice(0);
    // The next read reports the lost role and closes the dialog.
    await shared.refresh();
    await showing;
    expect(shared.doc.canWrite).toBe(false);
    expect(pending.hasDialog).toBe(false);
    expect(decisions()).toEqual([]);
  });

  test("escape and leave pending keep the approval and send nothing", async () => {
    const answers: Array<string | undefined> = [undefined, "Leave pending"];
    const titles: string[] = [];
    const { f, pending, decisions } = await setup({
      ui: {
        select: async (title) => {
          titles.push(title);
          return answers.shift();
        },
      },
    });
    f.approvals.push(invocation({ toolDisplayName: "\u001b[2JRun a command" }));
    await pending.show("approvals");
    await pending.show("approvals");
    expect(titles).toHaveLength(2);
    expect(titles[0]).toContain("Allow");
    expect(titles[0]).not.toContain("\u001b");
    expect(decisions()).toEqual([]);
    expect(pending.approvalCount).toBe(1);
  });

  test.each([
    ["Approve once", "once"],
    ["Approve for this session", "session"],
    ["Always approve", "always"],
  ])("%s sends the %s scope", async (choice, scope) => {
    const { f, pending, decisions } = await setup({
      ui: { select: async () => choice },
    });
    const found = invocation();
    f.approvals.push(found);
    await pending.show("approvals");
    expect(decisions()).toEqual([
      { path: decided(found.id), action: "approve", approvalScope: scope },
    ]);
    expect(pending.approvalCount).toBe(0);
  });

  test("offers only the choices Leverage accepts from this person", async () => {
    const offered: string[][] = [];
    const { f, pending } = await setup({
      user: MEMBER,
      prepare: (f) =>
        f.grants.push({
          principalType: "user",
          principalId: MEMBER,
          role: "collaborator",
        }),
      ui: {
        select: async (_title, options) => {
          offered.push(options);
          return undefined;
        },
      },
    });
    // A collaborator decides first-party calls, but an "always" rule is the owner's.
    f.approvals.push(invocation({ actingUserId: "owner" }));
    await pending.show("approvals");
    // Someone else's personal connection: only its owner may approve.
    f.approvals.splice(0, 1, {
      ...invocation({ actingUserId: "owner" }),
      connectorScope: "user",
      connectorOwnerUserId: "owner",
      workspaceConnectorId: "conn_1",
    });
    await pending.show("approvals");
    expect(
      offered.map((one) => one.filter((label) => !label.startsWith("("))),
    ).toEqual([
      ["Approve once", "Approve for this session", "Deny", "Leave pending"],
      ["Deny", "Leave pending"],
    ]);
  });

  test("deny asks for an optional reason and sends it", async () => {
    const reasons: Array<string | undefined> = [
      undefined,
      "  Needs review  ",
      "",
    ];
    const { f, pending, decisions } = await setup({
      ui: {
        select: async () => "Deny",
        input: async (title, placeholder) => {
          expect(title).toBe("Reason for denial");
          expect(placeholder).toBe("Optional reason");
          return reasons.shift();
        },
      },
    });
    const first = invocation();
    f.approvals.push(first);
    // Escape on the reason leaves the approval pending.
    await pending.show("approvals");
    expect(decisions()).toEqual([]);
    await pending.show("approvals");
    const second = invocation();
    f.approvals.push(second);
    await pending.show("approvals");
    expect(decisions()).toEqual([
      { path: decided(first.id), action: "deny", denialReason: "Needs review" },
      { path: decided(second.id), action: "deny" },
    ]);
    expect(pending.approvalCount).toBe(0);
  });

  test("several approvals open a list and decide only the one picked", async () => {
    const lists: string[][] = [];
    const { f, pending, decisions } = await setup({
      ui: {
        select: async (title, options) => {
          lists.push(options);
          return title === "Leverage approvals" ? options[1] : "Approve once";
        },
      },
    });
    const bash = invocation();
    const edit = invocation({ tool: "edit", toolDisplayName: "Edit a file" });
    f.approvals.push(bash, edit);
    await pending.show("approvals");
    expect(lists[0]).toEqual([
      `1. Run a command · ${bash.id}`,
      `2. Edit a file · ${edit.id}`,
    ]);
    expect(decisions()).toEqual([
      { path: decided(edit.id), action: "approve", approvalScope: "once" },
    ]);
    expect(pending.approvalCount).toBe(1);
  });
});

describe("requests resolved elsewhere", () => {
  test.each([
    "approvals",
    "questions",
  ] as const)("closes an open %s dialog when someone else resolves it", async (kind) => {
    const dialog = held("Approve once");
    const { f, pending, decisions, actions } = await setup({
      ui: { select: dialog.select, confirm: async () => true },
    });
    const found = invocation();
    f.approvals.push(found);
    ask(f, [{ question: "Which color?", options: ["Red", "Blue"] }]);
    const showing = pending.show(kind);
    await dialog.ready;
    expect(pending.hasDialog).toBe(true);
    if (kind === "approvals") {
      found.state = "approved";
      f.publish({
        type: "session.approval.updated",
        sessionId: SESSION,
        invocation: { ...found },
      });
    } else {
      f.emit("tool_result", { toolUseId: "toolu_q" });
    }
    await showing;
    expect(pending.hasDialog).toBe(false);
    expect(decisions()).toEqual([]);
    expect(actions()).toEqual([]);
  });

  test("session shutdown closes a question without answering it", async () => {
    const dialog = held("1. Red");
    const { f, pending, controller, actions } = await setup({
      ui: { select: dialog.select, confirm: async () => true },
    });
    ask(f, [{ question: "Which color?", options: ["Red", "Blue"] }]);
    const showing = pending.show("questions");
    await dialog.ready;
    controller.abort();
    await showing;
    expect(pending.hasDialog).toBe(false);
    expect(actions()).toEqual([]);
  });
});

describe("questions", () => {
  test("collects single and multi-select answers and confirms before sending", async () => {
    const summaries: string[] = [];
    // Multi-select labels change as options toggle, so picks match by name.
    const picks = ["2. Blue", "1. A", "2. B", "2. B", "3. C", "Done"];
    const { f, pending, actions } = await setup({
      ui: {
        select: async (_title, options) => {
          const next = picks.shift() ?? "";
          return options.find((one) => one.endsWith(next));
        },
        confirm: async (title, body) => {
          expect(title).toBe("Send these answers?");
          summaries.push(body);
          return true;
        },
      },
    });
    ask(f, [
      { question: "Which color?", options: ["Red", "Blue"] },
      {
        question: "Which targets?",
        options: ["A", "B", "C"],
        multiSelect: true,
      },
    ]);
    await pending.show("questions");
    expect(picks).toEqual([]);
    expect(summaries).toEqual(["Which color?: Blue\nWhich targets?: A, C"]);
    expect(actions()).toEqual([
      {
        type: "session.answer",
        sessionId: SESSION,
        toolUseId: "toolu_q",
        answers: { "Which color?": "Blue", "Which targets?": "A, C" },
        clientRequestId: expect.any(String),
      },
    ]);
    // The question stays open until the agent records its result.
    expect(pending.questionCount).toBe(1);
    f.emit("tool_result", { toolUseId: "toolu_q" });
    await eventually(() => pending.questionCount === 0);
  });

  test("a plan is approved, or sent back with a note, never approved unseen", async () => {
    const picks = ["Ask for changes", "Approve the plan"];
    const titles: string[] = [];
    const { f, pending, actions } = await setup({
      ui: {
        select: async (title, options) => {
          titles.push(title);
          const next = picks.shift();
          return options.find((one) => one === next);
        },
        input: async () => "Test the migration first",
      },
    });
    f.emit("ask_user", {
      toolUseId: "toolu_plan",
      input: { plan: "# Ship it\n1. Migrate\n2. Deploy" },
    });
    await pending.show("questions");
    expect(titles).toEqual(["Review the plan above"]);
    await pending.show("questions");
    expect(actions()).toEqual([
      {
        type: "session.answer",
        sessionId: SESSION,
        toolUseId: "toolu_plan",
        answers: { plan: "changes_requested" },
        annotations: {
          plan: {
            notes: JSON.stringify([
              { selectedText: "", comment: "Test the migration first" },
            ]),
          },
        },
        clientRequestId: expect.any(String),
      },
      {
        type: "session.answer",
        sessionId: SESSION,
        toolUseId: "toolu_plan",
        answers: { plan: "approved" },
        clientRequestId: expect.any(String),
      },
    ]);
  });

  test("sends nothing when the answers are not confirmed or the dialog is cancelled", async () => {
    let confirms = 0;
    const answers: Array<string | undefined> = ["1. Red", undefined];
    const { f, pending, actions } = await setup({
      ui: {
        select: async () => answers.shift(),
        confirm: async () => {
          confirms++;
          return false;
        },
      },
    });
    ask(f, [{ question: "Which color?", options: ["Red", "Blue"] }]);
    await pending.show("questions");
    await pending.show("questions");
    expect(confirms).toBe(1);
    expect(actions()).toEqual([]);
    expect(pending.questionCount).toBe(1);
  });

  test("write another answer sends free text", async () => {
    const { f, pending, actions } = await setup({
      ui: {
        select: async (_title, options) => {
          expect(options).toEqual([
            "1. Red",
            "2. Blue",
            "Write another answer",
          ]);
          return "Write another answer";
        },
        input: async (title, placeholder) => {
          expect(title).toBe("Which color?");
          expect(placeholder).toBe("Your answer");
          return "  Green  ";
        },
        confirm: async () => true,
      },
    });
    ask(f, [{ question: "Which color?", options: ["Red", "Blue"] }]);
    await pending.show("questions");
    expect(actions()).toEqual([
      expect.objectContaining({
        type: "session.answer",
        answers: { "Which color?": "Green" },
      }),
    ]);
  });

  test("viewers cannot open questions, the inbox, or the model", async () => {
    const { pending } = await setup({
      user: MEMBER,
      prepare: (f) => {
        f.session.visibility = "workspace";
      },
    });
    for (const kind of ["questions", "inbox", "model"] as const) {
      await rejects(pending.show(kind), /read-only/);
    }
  });
});

describe("queued messages", () => {
  // One message waits for its turn after one that was already delivered.
  function queue(f: Fixture) {
    const waiting = input("Next turn", { status: "queued" });
    f.state.queue = [waiting];
    f.state.nativeMessages = [input("Already sent"), waiting];
    return waiting;
  }

  test("send it now steers the queued message into the running turn", async () => {
    const lists: string[][] = [];
    const { f, pending, actions } = await setup({
      ui: {
        select: async (title, options) => {
          if (title === "Messages waiting for their turn") {
            lists.push(options);
            return options[0];
          }
          return "Send it now";
        },
      },
    });
    const waiting = queue(f);
    await pending.show("inbox");
    expect(lists).toEqual([["1. Next turn"]]);
    await eventually(() => actions().length === 1);
    expect(actions()).toEqual([
      { type: "session.queue.steer", sessionId: SESSION, uuid: waiting.uuid },
    ]);
  });

  test("take it back cancels only after confirmation", async () => {
    let confirmed = false;
    const { f, pending, actions } = await setup({
      ui: {
        select: async (_title, options) =>
          options.includes("Take it back") ? "Take it back" : options[0],
        confirm: async (title, body) => {
          expect(title).toBe("Take this message back?");
          expect(body).toBe("Next turn");
          return confirmed;
        },
      },
    });
    const waiting = queue(f);
    await pending.show("inbox");
    await Bun.sleep(50);
    expect(actions()).toEqual([]);
    confirmed = true;
    await pending.show("inbox");
    await eventually(() => actions().length === 1);
    expect(actions()).toEqual([
      { type: "session.queue.cancel", sessionId: SESSION, uuid: waiting.uuid },
    ]);
  });

  test("an empty queue says so", async () => {
    const { pending, notifications } = await setup();
    await pending.show("inbox");
    expect(notifications).toEqual(["No messages are waiting."]);
  });
});

describe("session model", () => {
  test("the model choice stays local until the next message", async () => {
    const choices: ModelChoice[] = [];
    const lists: string[][] = [];
    const { f, pending, notifications, actions } = await setup({
      prepare: (f) => {
        f.state.catalog = [
          hostedModel,
          { ...hostedModel, id: "older", label: "Older model", legacy: true },
          { ...hostedModel, id: "codex", label: "Codex", family: "codex" },
          {
            ...hostedModel,
            id: "fast",
            label: "Fast model",
            reasoningEfforts: [],
            defaultReasoningEffort: null,
          },
        ];
      },
      chooseModel: (choice) => choices.push(choice),
      ui: {
        select: async (title, options) => {
          lists.push(options);
          return title === "Reasoning effort" ? "high" : options[0];
        },
      },
    });
    await pending.show("model");
    expect(lists).toEqual([
      ["Hosted model (current)", "Fast model"],
      ["low (default)", "high"],
    ]);
    expect(choices).toEqual([
      { model: "hosted-model", reasoningEffort: "high" },
    ]);
    expect(notifications).toEqual([
      "Hosted model (high) is used from your next message.",
    ]);
    expect(f.requests.filter((one) => one.method !== "GET")).toEqual([]);
    expect(actions()).toEqual([]);
  });
});
