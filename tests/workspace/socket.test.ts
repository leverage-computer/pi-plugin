import { afterEach, expect, test } from "bun:test";
import type { HistoryEntry } from "../../src/history";
import { SharedSession } from "../../src/workspace/state";
import {
  eventually,
  input,
  invocation,
  MEMBER,
  SESSION,
  workspaceFixture,
} from "./fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
const sessions: SharedSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.close();
  }
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

function fixture() {
  const f = workspaceFixture();
  fixtures.push(f);
  return f;
}

// A shared session that records what it reports.
async function open(user = "owner") {
  const f = fixture();
  f.client(user);
  const changes: HistoryEntry[] = [];
  const errors: unknown[] = [];
  let denied = 0;
  const shared = new SharedSession(SESSION, {
    changed: (entries) => changes.push(...entries),
    failed: (error) => errors.push(error),
    denied: () => {
      denied++;
    },
  });
  sessions.push(shared);
  await shared.start(new AbortController().signal);
  return { f, shared, changes, errors, denied: () => denied };
}

const bob = input("From Bob", {
  uuid: "22222222-2222-4222-8222-222222222222",
  authorId: MEMBER,
  authorName: "Bob",
  harness: "codex",
  status: "queued",
});

test("reconnects with its replay cursor and drops repeated frames", async () => {
  const f = fixture();
  const api = f.client();
  const socket = await api.socket();
  await socket.connect();
  socket.subscribe(SESSION, 4);
  const seen: string[] = [];
  socket.onEvent((event) => {
    if (event.type === "session.messages.updated") {
      seen.push(event.messages[0]?.content ?? "");
    }
  });
  const frame = {
    type: "session.messages.updated",
    sessionId: SESSION,
    version: 1,
    messages: [bob],
    _topic: "session",
    cursor: 5,
  };
  f.publish(frame);
  f.publish(frame);
  await eventually(() => seen.length === 1);
  for (const connection of f.connections) {
    connection.close();
  }
  await eventually(
    () => f.frames.filter((e) => e.type === "session.subscribe").length >= 2,
  );
  expect(
    f.frames.filter((e) => e.type === "session.subscribe").at(-1)?.afterCursor,
  ).toBe(5);
  f.publish(frame);
  f.publish({
    ...frame,
    cursor: 6,
    version: 2,
    messages: [{ ...bob, content: "Updated" }],
  });
  await eventually(() => seen.length === 2);
  expect(seen).toEqual(["From Bob", "Updated"]);
});

test("live rows, streamed text and status changes reach the conversation", async () => {
  const { f, shared } = await open();
  expect(shared.running).toBe(false);
  f.update({ status: "active", turnId: "turn_1" });
  await eventually(() => shared.running);
  f.emit("user", { content: "Hi" }, { authorId: "owner" });
  const row = f.emit("text", {
    role: "assistant",
    content: "",
    eventId: "stream_1",
  });
  f.publish({
    type: "session.event.delta",
    sessionId: SESSION,
    delta: {
      kind: "text",
      streamId: "stream_1",
      eventId: "stream_1",
      rowId: row.id,
      delta: "Hello there",
      offset: 0,
    },
  });
  await eventually(() =>
    shared.history.entries().some((one) => one.content.endsWith("Hello there")),
  );
  f.update({ status: "idle", turnId: null });
  await eventually(() => !shared.running);
  expect(shared.history.entries().map((one) => one.role)).toEqual([
    "user",
    "assistant",
  ]);
});

test("tracks approvals and questions until someone resolves them", async () => {
  const { f, shared } = await open();
  const pending = invocation();
  f.approvals.push(pending);
  f.publish({
    type: "session.approval.pending",
    sessionId: SESSION,
    invocation: pending,
  });
  await eventually(() => shared.pendingApprovals().length === 1);
  f.approvals[0] = { ...pending, state: "approved" };
  f.publish({
    type: "session.approval.updated",
    sessionId: SESSION,
    invocation: f.approvals[0],
  });
  await eventually(() => shared.pendingApprovals().length === 0);
  f.emit("ask_user", {
    toolUseId: "toolu_q",
    input: { questions: [{ question: "Which branch?", options: [] }] },
  });
  await eventually(() => shared.pendingQuestions().length === 1);
  f.emit("tool_result", { toolUseId: "toolu_q", content: "main" });
  await eventually(() => shared.pendingQuestions().length === 0);
});

test("revocation clears the conversation; workspace viewers cannot write", async () => {
  const f = fixture();
  f.session.visibility = "workspace";
  f.client(MEMBER);
  let denied = 0;
  const errors: unknown[] = [];
  const shared = new SharedSession(SESSION, {
    changed: () => {},
    failed: (e) => errors.push(e),
    denied: () => {
      denied++;
    },
  });
  sessions.push(shared);
  await shared.start(new AbortController().signal);
  expect(shared.canWrite).toBe(false);
  f.grants.push({
    principalType: "user",
    principalId: MEMBER,
    role: "collaborator",
  });
  f.publish({ type: "session.list.changed", sessionId: SESSION });
  await eventually(() => shared.canWrite);
  f.publish({
    type: "session.messages.updated",
    sessionId: SESSION,
    version: 2,
    messages: [bob],
  });
  await eventually(() => shared.queued().length === 1);
  f.publish({ type: "session.access_revoked", sessionId: SESSION });
  await eventually(() => shared.revoked);
  expect(shared.queued()).toEqual([]);
  expect(shared.canWrite).toBe(false);
  expect(denied).toBe(1);
  expect(errors).toEqual([]);
});

test("a stale read cannot overwrite a newer message update", async () => {
  const { f, shared } = await open();
  let release!: () => void;
  f.state.readDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refreshing = shared.refresh();
  f.publish({
    type: "session.messages.updated",
    sessionId: SESSION,
    version: 5,
    messages: [bob],
  });
  await eventually(() => shared.version === 5);
  f.state.version = 1;
  f.state.nativeMessages = [{ ...bob, content: "Stale", status: "received" }];
  release();
  await refreshing;
  expect(shared.input(bob.uuid)?.content).toBe("From Bob");
  expect(shared.input(bob.uuid)?.harness).toBe("codex");
  shared.close();
  f.publish({
    type: "session.messages.updated",
    sessionId: SESSION,
    version: 9,
    messages: [{ ...bob, content: "Wrong view" }],
  });
  await Bun.sleep(20);
  expect(shared.input(bob.uuid)?.content).toBe("From Bob");
});

test("a read that overlaps a live approval keeps it", async () => {
  const { f, shared } = await open();
  // Startup may still be reading. Only the read below should overlap the frame.
  await shared.refresh();
  let release!: () => void;
  f.state.readDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  const refreshing = shared.refresh();
  f.publish({
    type: "session.approval.pending",
    sessionId: SESSION,
    invocation: invocation(),
  });
  await eventually(() => shared.pendingApprovals().length === 1);
  release();
  await refreshing;
  expect(shared.pendingApprovals()).toHaveLength(1);
});
