import { afterEach, expect, test } from "bun:test";
import { workspace } from "../../src/workspace/api";
import { PRESENCE_TIMING } from "../../src/workspace/socket";
import { SessionReplica, type SessionView } from "../../src/workspace/view";
import {
  eventually,
  input,
  invocation,
  MEMBER,
  SESSION,
  workspaceFixture,
} from "./fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
const sessions: SessionReplica[] = [];
afterEach(async () => {
  workspace.timing = PRESENCE_TIMING;
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

// A shared session that records every state it publishes.
async function open(user = "owner") {
  const f = fixture();
  f.client(user);
  const states: SessionView[] = [];
  const errors: unknown[] = [];
  const shared = new SessionReplica(SESSION, (error) => errors.push(error));
  shared.state.subscribe((state) => states.push(state));
  sessions.push(shared);
  await shared.start(new AbortController().signal);
  return { f, shared, states, errors };
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
  const { f, shared, states } = await open();
  expect(shared.value.docs["pi.live"]?.run !== undefined).toBe(false);
  f.update({ status: "active", turnId: "turn_1" });
  await eventually(() => shared.value.docs["pi.live"]?.run !== undefined);
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
    shared.value.entries.some((one) =>
      JSON.stringify(one.model).includes("Hello there"),
    ),
  );
  f.update({ status: "idle", turnId: null });
  await eventually(() => shared.value.docs["pi.live"]?.run === undefined);
  const { entries } = shared.value;
  expect(entries.map((one) => one.kind)).toEqual(["pi.user", "pi.assistant"]);
  // Revisions reach a subscriber in order, each a new value, and one without
  // an entry change keeps its entries.
  await eventually(() => states.at(-1) === shared.value);
  expect(new Set(states).size).toBe(states.length);
  expect(states.at(-1)?.entries).toBe(entries);
  expect(states.at(-2)?.entries).toBe(entries);
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
  await eventually(
    () => shared.value.docs["leverage.approvals"].items.length === 1,
  );
  f.approvals[0] = { ...pending, state: "approved" };
  f.publish({
    type: "session.approval.updated",
    sessionId: SESSION,
    invocation: f.approvals[0],
  });
  await eventually(
    () => shared.value.docs["leverage.approvals"].items.length === 0,
  );
  f.emit("ask_user", {
    toolUseId: "toolu_q",
    input: { questions: [{ question: "Which branch?", options: [] }] },
  });
  await eventually(() => shared.value.docs["leverage.asks"].items.length === 1);
  f.emit("tool_result", { toolUseId: "toolu_q", content: "main" });
  await eventually(() => shared.value.docs["leverage.asks"].items.length === 0);
});

test("revocation clears the conversation; workspace viewers cannot write", async () => {
  const f = fixture();
  f.session.visibility = "workspace";
  f.client(MEMBER);
  const errors: unknown[] = [];
  const shared = new SessionReplica(SESSION, (e) => errors.push(e));
  const revocations: SessionView[] = [];
  shared.state.subscribe((state) => {
    if (state.docs["leverage.session"].revoked) {
      revocations.push(state);
    }
  });
  sessions.push(shared);
  await shared.start(new AbortController().signal);
  expect(shared.doc.canWrite).toBe(false);
  f.grants.push({
    principalType: "user",
    principalId: MEMBER,
    role: "collaborator",
  });
  f.publish({ type: "session.list.changed", sessionId: SESSION });
  await eventually(() => shared.doc.canWrite);
  f.publish({
    type: "session.messages.updated",
    sessionId: SESSION,
    version: 2,
    messages: [bob],
  });
  await eventually(() => shared.value.docs["pi.inbox"]!.items.length === 1);
  f.publish({ type: "session.access_revoked", sessionId: SESSION });
  await eventually(() => shared.doc.revoked);
  expect(shared.value.docs["pi.inbox"]!.items).toEqual([]);
  expect(shared.value.entries).toEqual([]);
  expect(shared.doc.canWrite).toBe(false);
  expect(revocations).toHaveLength(1);
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
  await eventually(() => shared.doc.version === 5);
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
  await eventually(
    () => shared.value.docs["leverage.approvals"].items.length === 1,
  );
  release();
  await refreshing;
  expect(shared.value.docs["leverage.approvals"].items).toHaveLength(1);
});

test("shows who has the session open, who is typing, and who is online", async () => {
  const { f, shared } = await open();
  const doc = () => shared.doc;
  // Joining tells the server the person is watching, and lists them back.
  await eventually(() =>
    f.frames.some((one) => one.type === "session.subscribe"),
  );
  expect(f.frames.find((one) => one.type === "session.subscribe")).toEqual({
    type: "session.subscribe",
    sessionId: SESSION,
    afterCursor: expect.any(Number),
    state: "active",
  });
  await eventually(() => doc().viewers.length === 1);
  expect(doc().viewers).toEqual([
    { userId: "owner", userName: "Alice", state: "active" },
  ]);
  expect(doc().presence.owner).toMatchObject({ status: "online" });
  f.viewer(MEMBER, true);
  f.typing(MEMBER, true);
  f.presence(MEMBER, "online", ["codex"]);
  await eventually(
    () => doc().typing.length === 1 && doc().presence[MEMBER] !== undefined,
  );
  expect(doc().viewers.map((one) => one.userId)).toEqual(["owner", MEMBER]);
  expect(doc().typing).toEqual([MEMBER]);
  expect(doc().presence[MEMBER]).toMatchObject({
    status: "online",
    clients: ["codex"],
  });
  // Stepping away keeps the row but marks it, and leaving drops it with its typing.
  f.viewer(MEMBER, true, "idle");
  await eventually(() => doc().viewers[1]?.state === "idle");
  f.viewer(MEMBER, false);
  await eventually(() => doc().viewers.length === 1);
  expect(doc().typing).toEqual([]);
  // Workspace presence survives a fresh read, and an away status replaces online.
  f.presence(MEMBER, "away");
  await eventually(() => doc().presence[MEMBER]?.status === "away");
  await shared.refresh();
  expect(doc().presence[MEMBER]?.status).toBe("away");
});

test("a quiet person goes idle and stops heartbeats until they do something", async () => {
  const f = fixture();
  const api = f.client();
  api.timing = { heartbeatMs: 30, idleMs: 120 };
  const socket = await api.socket();
  await socket.connect();
  socket.subscribe(SESSION, 0);
  const sent = (type: string) => f.frames.filter((one) => one.type === type);
  await eventually(() => sent("presence.heartbeat").length >= 2);
  await eventually(() => sent("session.presence.set").length === 1);
  expect(sent("session.presence.set")[0]).toEqual({
    type: "session.presence.set",
    sessionId: SESSION,
    state: "idle",
  });
  expect(f.viewers(SESSION)[0]?.state).toBe("idle");
  // No heartbeats while idle. The last one may still be on its way.
  await Bun.sleep(100);
  const beats = sent("presence.heartbeat").length;
  await Bun.sleep(100);
  expect(sent("presence.heartbeat").length).toBe(beats);
  // Doing something reports the person at once, and the subscription follows.
  socket.active();
  await eventually(() => sent("session.presence.set").length === 2);
  expect(sent("session.presence.set")[1]).toMatchObject({ state: "active" });
  await eventually(() => sent("presence.heartbeat").length > beats);
  expect(f.viewers(SESSION)[0]?.state).toBe("active");
  socket.close();
});
