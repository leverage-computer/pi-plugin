import { afterEach, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { ChannelConversation } from "../src/channels-ui";
import {
	eventually,
	MEMBER,
	SESSION,
	workspaceFixture,
} from "./workspace-fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});
function fixture(extra?: Parameters<typeof workspaceFixture>[0]) {
	const value = workspaceFixture(extra);
	fixtures.push(value);
	return value;
}

test("creation retries keep one empty session and confirm private grants before returning", async () => {
	const f = fixture();
	const api = f.client();
	const signal = new AbortController().signal;
	const draft = await api.draft(signal);
	draft.visibility = "private";
	draft.title = "Private draft";
	draft.grants.push({
		principalType: "user",
		principalId: MEMBER,
		role: "collaborator",
	});
	f.state.visibilityFailures = 1;
	await rejects(api.create(draft, signal), /503/);
	expect(draft.sessionId).toBe(SESSION);
	expect(f.state.createCount).toBe(1);
	expect(f.requests.some((r) => r.path.includes("/inbox"))).toBe(false);
	expect(await api.create(draft, signal)).toBe(SESSION);
	expect(f.state.createCount).toBe(1);
	expect((await api.sharing(SESSION)).members[0]?.role).toBe("collaborator");
	const create = f.frames.find((frame) => frame.type === "session.create")!;
	expect(create.prompt).toBe("");
	expect(create.title).toBeUndefined();
	expect(create.attachments).toBeUndefined();
	const mutating = f.requests.filter((r) => r.method !== "GET");
	expect(mutating.map((r) => r.path.split("/").at(-1))).toEqual([
		"visibility",
		"visibility",
		"members",
		`ses_${SESSION}`,
	]);
});

test("a lost creation acknowledgement retries the stable request ID without duplicating a session", async () => {
	const f = fixture();
	const api = f.client();
	const draft = await api.draft();
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

test("revalidates removed branches, unavailable providers, and unsupported reasoning before creating", async () => {
	const f = fixture();
	const api = f.client();
	const draft = await api.draft();
	const signal = new AbortController().signal;
	draft.context = { type: "repo", repoConnectionId: "repo", branch: "removed" };
	await rejects(api.create(draft, signal), /branch/);
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

test("channel sends and thread replies retain distinct drafts and stable message identities", async () => {
	const f = fixture();
	const owner = f.client();
	const member = f.client(MEMBER);
	const signal = new AbortController().signal;
	const root = new ChannelConversation();
	root.draft = "Start a thread";
	await root.send(owner, "general", signal);
	const timeline = await member.timeline("general");
	expect(timeline.messages).toHaveLength(1);
	const message = timeline.messages[0];
	const reply = new ChannelConversation();
	reply.draft = "Bob's reply";
	root.draft = "Unsent channel draft";
	await reply.send(member, "general", signal, message.id);
	const replies = await owner.thread("general", message.id);
	expect(replies[0]?.authorId).toBe(MEMBER);
	expect(replies[0]?.parentMessageId).toBe(message.id);
	expect(root.draft).toBe("Unsent channel draft");
	expect(reply.draft).toBe("");
	await member.sendMessage(
		"general",
		"Bob's reply",
		replies[0].clientMessageId!,
		signal,
		message.id,
	);
	expect(await owner.thread("general", message.id)).toHaveLength(1);
	root.merge(timeline.messages);
	root.merge(timeline.messages);
	expect(root.entries()).toHaveLength(1);
	root.reconcile([], true);
	expect(root.entries()).toHaveLength(0);
	expect(root.draft).toBe("Unsent channel draft");
});

test("a channel snapshot cannot restore a message deleted during refresh", () => {
	const conversation = new ChannelConversation();
	const message = {
		id: "one",
		channelId: "general",
		authorId: MEMBER,
		content: "Removed",
		createdAt: new Date().toISOString(),
	};
	conversation.merge([message]);
	const load = conversation.revision;
	conversation.remove(message.id);
	conversation.reconcile([message], true, load);
	expect(conversation.entries()).toEqual([]);
	conversation.merge([{ ...message, id: "two", content: "Live edit" }]);
	const oldLoad = conversation.revision;
	conversation.merge([{ ...message, id: "two", content: "Newer edit" }]);
	conversation.reconcile(
		[{ ...message, id: "two", content: "Live edit" }],
		true,
		oldLoad,
	);
	expect(conversation.entries()[0]?.content).toBe("Newer edit");
});
