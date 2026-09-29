import { afterEach, expect, test } from "bun:test";
import { SharedSession } from "../../src/workspace/state";
import { eventually, MEMBER, SESSION, workspaceFixture } from "./fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
const sessions: SharedSession[] = [];
afterEach(async () => {
	for (const session of sessions.splice(0)) session.close();
	for (const fixture of fixtures.splice(0)) await fixture.close();
});
function fixture() {
	const f = workspaceFixture();
	fixtures.push(f);
	return f;
}
const message = {
	uuid: "message",
	sessionId: SESSION,
	authorId: MEMBER,
	authorName: "Bob",
	harness: "codex",
	content: "From Bob",
	status: "received",
	createdAt: new Date().toISOString(),
};

test("reconnects with replay cursor and deduplicates repeated native messages", async () => {
	const f = fixture();
	const api = f.client();
	const socket = await api.socket();
	await socket.connect();
	socket.subscribe(SESSION, 4);
	const events: string[] = [];
	socket.onEvent((event) => {
		if (event.type === "session.messages.updated")
			events.push(event.messages[0]?.content);
	});
	const frame = {
		type: "session.messages.updated",
		sessionId: SESSION,
		version: 1,
		messages: [message],
		_topic: "session",
		cursor: 5,
	};
	f.publish(frame);
	f.publish(frame);
	await eventually(() => events.length === 1);
	for (const connection of f.connections) connection.close();
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
		messages: [{ ...message, content: "Updated" }],
	});
	await eventually(() => events.length === 2);
	expect(events).toEqual(["From Bob", "Updated"]);
});

test("revocation clears the conversation; workspace viewers cannot write", async () => {
	const f = fixture();
	f.session.visibility = "workspace";
	const errors: unknown[] = [];
	let denied = 0;
	const shared = new SharedSession(
		f.client(MEMBER),
		SESSION,
		() => {},
		(e) => errors.push(e),
		() => {
			denied++;
		},
	);
	sessions.push(shared);
	await shared.start(new AbortController().signal);
	expect(shared.canWrite).toBe(false);
	f.grants.push({
		principalType: "user",
		principalId: MEMBER,
		role: "collaborator",
	});
	f.publish({ type: "session.updated", sessionId: SESSION });
	await eventually(() => shared.canWrite);
	f.publish({
		type: "session.messages.updated",
		sessionId: SESSION,
		version: 2,
		messages: [message],
	});
	await eventually(() => shared.messages.size === 1);
	f.grants.splice(0);
	f.publish({ type: "session.updated", sessionId: SESSION });
	await eventually(() => !shared.canWrite);
	f.publish({ type: "session.access_revoked", sessionId: SESSION });
	await eventually(() => shared.revoked);
	expect(shared.messages.size).toBe(0);
	expect(denied).toBe(1);
	expect(errors).toEqual([]);
});

test("a stale bootstrap cannot overwrite newer author metadata or message delivery", async () => {
	const f = fixture();
	const shared = new SharedSession(
		f.client(),
		SESSION,
		() => {},
		() => {},
		() => {},
	);
	sessions.push(shared);
	await shared.start(new AbortController().signal);
	let release!: () => void;
	f.state.readDelay = new Promise<void>((r) => {
		release = r;
	});
	const refreshing = shared.refresh();
	f.publish({
		type: "session.messages.updated",
		sessionId: SESSION,
		version: 5,
		messages: [message],
	});
	await eventually(() => shared.version === 5);
	f.state.version = 1;
	f.state.nativeMessages = [{ ...message, content: "Stale", status: "queued" }];
	release();
	await refreshing;
	expect(shared.messages.get(message.uuid)?.content).toBe("From Bob");
	expect(shared.messages.get(message.uuid)?.harness).toBe("codex");
	shared.close();
	f.publish({
		type: "session.messages.updated",
		sessionId: SESSION,
		version: 9,
		messages: [{ ...message, content: "Wrong view" }],
	});
	await Bun.sleep(20);
	expect(shared.messages.get(message.uuid)?.content).toBe("From Bob");
});
