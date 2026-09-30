import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import {
  eventually,
  invocation,
  MEMBER,
  SESSION,
  workspaceFixture,
} from "./fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.close();
  }
});

function fixture(extra?: Parameters<typeof workspaceFixture>[0]) {
  const value = workspaceFixture(extra);
  fixtures.push(value);
  return value;
}

test("creating a session sends its title with the empty first message", async () => {
  const f = fixture();
  const api = f.client();
  const draft = api.draft();
  draft.title = "  Named   draft ";
  expect(await api.create(draft, new AbortController().signal)).toBe(SESSION);
  const create = f.frames.find((frame) => frame.type === "session.create")!;
  expect(create.prompt).toBe("");
  expect(create.title).toBe("Named draft");
  expect(create.harness).toBe("pi");
  expect(f.session.title).toBe("Named draft");
  // A created draft reuses its session instead of asking for another.
  expect(await api.create(draft, new AbortController().signal)).toBe(SESSION);
  expect(f.state.createCount).toBe(1);
});

test("a default-model session is created even when the model catalog is missing", async () => {
  const f = fixture((request) =>
    new URL(request.url).pathname.endsWith("/provider-models")
      ? new Response("Not found", { status: 404 })
      : undefined,
  );
  const api = f.client();
  expect(await api.create(api.draft(), new AbortController().signal)).toBe(
    SESSION,
  );
  expect(f.state.createCount).toBe(1);
  expect(f.requests.some((r) => r.path.endsWith("/provider-models"))).toBe(
    false,
  );
});

test("a missing Pi choice leaves out nothing, and a malformed one fails", async () => {
  const f = fixture();
  const api = f.client();
  expect(await api.choices()).toEqual({
    excludedChannelIds: [],
    showStandalone: true,
    showShared: true,
  });
  f.state.preferences = {
    piExcludedChannelIds: ["general"],
    piShowStandaloneSessions: false,
    piShowSharedSessions: false,
  };
  expect(await api.choices()).toEqual({
    excludedChannelIds: ["general"],
    showStandalone: false,
    showShared: false,
  });
  for (const malformed of [
    { piExcludedChannelIds: "general" },
    { piShowStandaloneSessions: "no" },
    { piShowSharedSessions: 0 },
  ]) {
    f.state.preferences = malformed;
    await rejects(api.choices());
  }
});

test("a lost creation acknowledgement retries the stable request ID without duplicating a session", async () => {
  const f = fixture();
  const api = f.client();
  const draft = api.draft();
  f.state.dropCreated = true;
  const life = new AbortController();
  const attempt = api.create(draft, life.signal);
  const failure = rejects(attempt, /not confirmed/);
  await eventually(() => f.state.createCount === 1);
  life.abort();
  await failure;
  expect(draft.sessionId).toBeUndefined();
  await api.create(draft, new AbortController().signal);
  expect(f.state.createCount).toBe(1);
  const ids = f.frames
    .filter((e) => e.type === "session.create")
    .map((e) => e.clientRequestId);
  expect(new Set(ids).size).toBe(1);
});

test("revalidates removed channels, unavailable providers, and unsupported reasoning before creating", async () => {
  const f = fixture();
  const api = f.client();
  const draft = api.draft();
  const signal = new AbortController().signal;
  draft.context = { type: "channel", channelId: "removed" };
  await rejects(api.create(draft, signal), /channel/);
  draft.context = { type: "none" };
  draft.providerFamily = "codex";
  await rejects(api.create(draft, signal), /unavailable/);
  draft.providerFamily = "claude_code";
  draft.model = "hosted-model";
  draft.reasoningEffort = "impossible";
  await rejects(api.create(draft, signal), /reasoning/);
  draft.model = "retired-model";
  await rejects(api.create(draft, signal), /no longer available/);
  expect(f.state.createCount).toBe(0);
  draft.model = "hosted-model";
  draft.reasoningEffort = "high";
  await api.create(draft, signal);
  expect(f.state.createCount).toBe(1);
});

test("a message resolves once Leverage stores it, and an unconfirmed one fails", async () => {
  const f = fixture();
  const api = f.client();
  const signal = new AbortController().signal;
  const clientRequestId = crypto.randomUUID();
  const stored = await api.send(
    SESSION,
    { clientRequestId, content: "Run the tests", delivery: "send" },
    signal,
  );
  expect(stored.uuid).toBe(clientRequestId);
  expect(stored.content).toBe("Run the tests");
  const frame = f.frames.find((one) => one.type === "session.message")!;
  expect(frame.delivery).toBe("send");
  expect(frame.harness).toBe("pi");
  f.state.dropMessageAck = true;
  const life = new AbortController();
  const lost = api.send(
    SESSION,
    {
      clientRequestId: crypto.randomUUID(),
      content: "Lost",
      delivery: "queue",
    },
    life.signal,
  );
  await eventually(
    () => f.frames.filter((one) => one.type === "session.message").length === 2,
  );
  life.abort();
  await rejects(lost, /not confirmed/);
});

test("rename, stop and answer wait for Leverage to accept them", async () => {
  const f = fixture();
  const api = f.client();
  const signal = new AbortController().signal;
  expect(await api.rename(SESSION, "  New   name ", signal)).toBe("New name");
  await rejects(api.rename(SESSION, "   ", signal), /1 to 80/);
  await api.stop(SESSION, "turn_1", signal);
  await api.answer(
    SESSION,
    "toolu_q",
    { answers: { "Which branch?": "main" } },
    signal,
  );
  const stop = f.frames.find((one) => one.type === "session.stop")!;
  expect(stop.turnId).toBe("turn_1");
  const answer = f.frames.find((one) => one.type === "session.answer")!;
  expect(answer.answers).toEqual({ "Which branch?": "main" });
});

test("archive and restore wait for Leverage to apply them, and report a refusal", async () => {
  const f = fixture();
  const api = f.client();
  const signal = new AbortController().signal;
  await api.archive(SESSION, signal);
  expect(f.session.archivedAt).toEqual(expect.any(String));
  await api.unarchive(SESSION, signal);
  expect(f.session.archivedAt).toBeNull();
  const viewer = fixture();
  viewer.session.visibility = "workspace";
  const readOnly = viewer.client(MEMBER);
  await rejects(readOnly.archive(SESSION, signal), /Only writers/);
});

test("reads approvals, the queue and the model catalog, and sends a decision", async () => {
  const f = fixture();
  const api = f.client();
  const pending = invocation();
  f.approvals.push(pending);
  expect((await api.pendingApprovals(SESSION)).map((one) => one.id)).toEqual([
    pending.id,
  ]);
  const decided = await api.decide(pending.id, {
    action: "approve",
    approvalScope: "session",
  });
  expect(decided.state).toBe("approved");
  expect(f.requests.at(-1)?.body).toEqual({
    action: "approve",
    approvalScope: "session",
  });
  expect(await api.queue(SESSION)).toEqual([]);
  expect((await api.models()).map((one) => one.id)).toEqual(["hosted-model"]);
});

test("uploads a file in one piece and returns its attachment ID", async () => {
  const f = fixture();
  const api = f.client();
  const id = await api.upload({
    filename: "shot.png",
    contentType: "image/png",
    bytes: new Uint8Array([1, 2, 3, 4]),
  });
  expect(f.uploads).toEqual([{ id, bytes: 4, completed: true }]);
});

test("both transports use the same refreshed credential and native responses are validated", async () => {
  const f = fixture();
  const api = f.client("expired");
  await Promise.all([api.members(), api.models()]);
  const socket = await api.socket();
  await socket.connect();
  expect(f.state.refreshCount).toBe(1);
  expect(socket.userId).toBe("owner");
  const broken = fixture((request) =>
    new URL(request.url).pathname === "/api/users"
      ? Response.json([{ id: 12, name: "Invalid" }])
      : undefined,
  );
  await rejects(
    broken.client().members(),
    /invalid data for \/api\/users \(0\.id\)/,
  );
});
