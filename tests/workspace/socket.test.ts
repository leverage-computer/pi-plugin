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
  client: "codex",
  status: "queued",
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
