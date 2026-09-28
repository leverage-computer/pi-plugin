import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { eventually, SESSION, workspaceFixture } from "./workspace-fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});
function fixture(extra?: Parameters<typeof workspaceFixture>[0]) {
	const value = workspaceFixture(extra);
	fixtures.push(value);
	return value;
}

test("a creation retry keeps the one empty session and finishes its title", async () => {
	let failures = 1;
	const f = fixture((request) =>
		request.method === "PATCH" && failures-- > 0
			? Response.json({ error: "Unavailable" }, { status: 503 })
			: undefined,
	);
	const api = f.client();
	const signal = new AbortController().signal;
	const draft = api.draft();
	draft.title = "Named draft";
	await rejects(api.create(draft, signal), /503/);
	expect(draft.sessionId).toBe(SESSION);
	expect(f.state.createCount).toBe(1);
	expect(f.requests.some((r) => r.path.includes("/inbox"))).toBe(false);
	expect(await api.create(draft, signal)).toBe(SESSION);
	expect(f.state.createCount).toBe(1);
	expect(f.session.title).toBe("Named draft");
	const create = f.frames.find((frame) => frame.type === "session.create")!;
	expect(create.prompt).toBe("");
	expect(create.title).toBeUndefined();
	expect(create.attachments).toBeUndefined();
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
	expect(
		new Set(
			f.frames
				.filter((e) => e.type === "session.create")
				.map((e) => e.clientRequestId),
		).size,
	).toBe(1);
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
	expect(f.state.createCount).toBe(0);
	draft.reasoningEffort = "high";
	await api.create(draft, signal);
	expect(f.state.createCount).toBe(1);
});

test("both transports use the same refreshed credential and native responses are validated", async () => {
	const f = fixture();
	const api = f.client("expired");
	await Promise.all([api.members(), api.transport.models()]);
	const socket = await api.socket();
	await socket.connect();
	expect(f.state.refreshCount).toBe(1);
	expect(socket.userId).toBe("owner");
	const broken = fixture((request) =>
		new URL(request.url).pathname === "/api/users"
			? Response.json([{ id: 12, name: "Invalid" }])
			: undefined,
	);
	await rejects(broken.client().members(), /invalid data/);
});
