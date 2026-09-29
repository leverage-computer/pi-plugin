import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
	ApiError,
	type InboxItem,
	type ModelInfo,
	type PermissionRequest,
	SessionClient,
	type SessionEvent,
	type SessionForm,
	type SessionInfo,
	type SessionMessage,
} from "../src/api";
import { RemoteWorkspace } from "../src/remote";

const session: SessionInfo = {
	id: "ses_task-one",
	projectID: "prj_workspace",
	location: { directory: "/alpha/project" },
	title: "Shared task",
	cost: 0,
	tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	time: { created: 1000, updated: 2000 },
};
const message: SessionMessage = {
	id: "msg_first",
	type: "user",
	text: "Read the shared history",
	time: { created: 1000 },
};
const connected: SessionEvent = {
	id: "evt_connected",
	type: "server.connected",
	location: { directory: "/alpha" },
	data: {},
};
const disposals: Array<() => void> = [];
afterEach(() => {
	for (const dispose of disposals.splice(0)) dispose();
});
function fixture(
	handler: (request: Request) => Response | Promise<Response>,
	refreshToken?: string,
) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	const connection = {
		host: server.url.origin,
		workspace: "alpha",
		token: "test-token",
		refreshToken,
	};
	const client = new SessionClient(connection);
	disposals.push(() => {
		client.close();
		void server.stop(true);
	});
	return { client, connection };
}
function eventResponse(frames: string[], open = false, onCancel?: () => void) {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const frame of frames) controller.enqueue(encoder.encode(frame));
				if (!open) controller.close();
			},
			cancel() {
				onCancel?.();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}
function frame(event: SessionEvent): string {
	return `data: ${JSON.stringify(event)}\r\n\r\n`;
}

describe("Leverage sessions", () => {
	test("pages transcript messages with workspace authentication", async () => {
		const seen: URL[] = [];
		const { client } = fixture((request) => {
			expect(request.headers.get("authorization")).toBe("Bearer test-token");
			expect(request.headers.get("x-leverage-workspace")).toBe("alpha");
			const url = new URL(request.url);
			seen.push(url);
			return Response.json({
				data: [message],
				cursor: url.searchParams.has("cursor") ? {} : { next: "next/+=" },
			});
		});
		const history = await client.history("task-one", {
			limit: 1,
			order: "desc",
		});
		expect(history.data).toEqual([message]);
		await client.history("ses_task-one", { cursor: history.cursor.next });
		expect(seen.map((url) => url.pathname)).toEqual([
			"/api/opencode/api/session/ses_task-one/message",
			"/api/opencode/api/session/ses_task-one/message",
		]);
		expect(seen[0]?.searchParams.get("order")).toBe("desc");
		expect(seen[1]?.searchParams.get("cursor")).toBe("next/+=");
	});
	test("normalizes title limits before renaming", async () => {
		const requests: Array<{ method: string; body: unknown }> = [];
		const { client } = fixture(async (request) => {
			requests.push({ method: request.method, body: await request.json() });
			return new Response(null, { status: 204 });
		});
		for (const title of [" ", "\t\n", "x".repeat(81), "🙂".repeat(41)]) {
			await assert.rejects(client.rename(session.id, title), /1 to 80/);
		}
		expect(requests).toEqual([]);

		const boundaryTitle = "🙂".repeat(40);
		await client.rename(session.id, ` \t${boundaryTitle}\n `);
		expect(requests).toEqual([
			{ method: "PATCH", body: { title: boundaryTitle } },
		]);
	});

	test("reads session details, running state and available workspace folders", async () => {
		const { client } = fixture((request) => {
			const path = new URL(request.url).pathname;
			if (path.endsWith("/active"))
				return Response.json({ data: { [session.id]: { type: "running" } } });
			if (path.endsWith("/project"))
				return Response.json([
					{ sandboxes: ["/alpha/project", "/alpha/project", "/alpha/other"] },
				]);
			return Response.json({ data: session });
		});
		expect(await client.get("task-one")).toEqual(session);
		expect(await client.active()).toEqual({
			[session.id]: { type: "running" },
		});
		expect(await client.folders()).toEqual([
			"/alpha",
			"/alpha/project",
			"/alpha/other",
		]);
	});
	test("keeps shared credentials alive after a remote task is closed", async () => {
		const { client } = fixture(() => Response.json({ data: session }));
		const remote = new RemoteWorkspace(client, session.id);
		remote.close();
		expect((await client.get(session.id)).id).toBe(session.id);
	});
	test("coalesces renewal across session requests without cancelling another caller", async () => {
		let refreshes = 0;
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let began: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			began = resolve;
		});
		const { client } = fixture(async (request) => {
			if (new URL(request.url).pathname.endsWith("/refresh")) {
				refreshes++;
				began();
				await gate;
				return Response.json({ access_token: "renewed-token" });
			}
			if (request.headers.get("authorization") !== "Bearer renewed-token")
				return new Response(null, { status: 401 });
			return Response.json({ data: session });
		}, "refresh-token");
		const abort = new AbortController();
		const cancelled = client.get(session.id, abort.signal);
		const survivor = client.get(session.id);
		await started;
		await Bun.sleep(10);
		abort.abort(new Error("Cancelled picker"));
		await assert.rejects(cancelled, /Cancelled picker/);
		release();
		expect((await survivor).id).toBe(session.id);
		expect(refreshes).toBe(1);
	});

	test("rejects malformed pages and invalid inputs without leaking response content", async () => {
		const { client } = fixture(() =>
			Response.json({ data: [{ secret: "private" }], cursor: {} }),
		);
		await assert.rejects(client.history("task"), /invalid page/);
		await assert.rejects(client.get("../other"), /Invalid Leverage session/);
		await assert.rejects(client.history("task", { limit: 201 }), /page size/);
	});

	test("reports the failing endpoint and server reason without response payloads or query text", async () => {
		const { client, connection } = fixture(() =>
			Response.json(
				{
					_tag: "UnknownError",
					message:
						"\u001b[31mthis folder could not be read just now\u001b[0m\n",
					data: { token: "private-response-data" },
				},
				{
					status: 503,
					headers: { "x-leverage-correlation-id": "test-request-123" },
				},
			),
		);
		await assert.rejects(
			client.history("task-one", { cursor: "private-cursor-text" }),
			(error) => {
				expect(error).toBeInstanceOf(ApiError);
				const failure = error as ApiError;
				expect(failure.status).toBe(503);
				expect(failure.message).toContain(
					"this folder could not be read just now",
				);
				expect(failure.message).toContain(
					`GET ${connection.host}/api/opencode/api/session`,
				);
				expect(failure.message).toContain("Request ID: test-request-123");
				expect(failure.message).not.toMatch(
					/private-|test-token|\u001b|\?limit/,
				);
				return true;
			},
		);
	});

	test("keeps HTTP failures usable with HTML, malformed JSON, or oversized error bodies", async () => {
		for (const [body, contentType] of [
			["<html>private-gateway-page</html>", "text/html"],
			['{"message":"private-invalid-json', "application/json"],
			[
				JSON.stringify({ message: "private-".repeat(4000) }),
				"application/json",
			],
		]) {
			const { client } = fixture(
				() =>
					new Response(body, {
						status: 503,
						headers: { "content-type": contentType },
					}),
			);
			await assert.rejects(client.history("task-one"), (error) => {
				expect(error).toBeInstanceOf(ApiError);
				expect((error as Error).message).toContain("request failed (503)");
				expect((error as Error).message).toContain("/api/opencode/api/session");
				expect((error as Error).message).not.toContain("private-");
				return true;
			});
		}
	});
	test("validates nested history fields before the UI reads them", async () => {
		const { client } = fixture(() =>
			Response.json({
				data: [
					{ id: "msg_broken", type: "assistant", time: { created: 1000 } },
				],
				cursor: {},
			}),
		);
		await assert.rejects(client.history(session.id), /invalid page/);
	});
});

describe("Leverage live events", () => {
	test("parses split frames and reconnects so callers can refresh history", async () => {
		let connections = 0;
		let cancelled = false;
		const abort = new AbortController();
		const states: string[] = [];
		const events: SessionEvent[] = [];
		const unicode: SessionEvent = { ...connected, id: "evt_你好" };
		const { client } = fixture(() => {
			connections++;
			if (connections === 1) {
				const data = frame(connected);
				return eventResponse([
					": heartbeat\n\n",
					data.slice(0, 12),
					data.slice(12),
				]);
			}
			return eventResponse([frame(unicode)], true, () => {
				cancelled = true;
			});
		});
		await client.events({
			signal: abort.signal,
			onConnection: (state) => states.push(state),
			onEvent: (event) => {
				events.push(event);
				if (events.length === 2) abort.abort();
			},
		});
		expect(connections).toBe(2);
		expect(events.map((event) => event.id)).toEqual([connected.id, unicode.id]);
		expect(states).toEqual(["connected", "reconnecting", "connected"]);
		await Bun.sleep(10);
		expect(cancelled).toBe(true);
	});
	test("fails forbidden streams without reconnecting", async () => {
		let connections = 0;
		const { client } = fixture(() => {
			connections++;
			return new Response(null, { status: 403 });
		});
		await assert.rejects(
			client.events({ signal: new AbortController().signal, onEvent() {} }),
			/403/,
		);
		expect(connections).toBe(1);
	});
	test("rejects malformed event data and cancels a pending stream on close", async () => {
		const malformed = fixture(() => eventResponse(["data: {broken}\n\n"]));
		await assert.rejects(
			malformed.client.events({
				signal: new AbortController().signal,
				onEvent() {},
			}),
			/invalid event/,
		);
		const open = fixture(() => eventResponse([frame(connected)], true));
		let received = false;
		await open.client.events({
			signal: new AbortController().signal,
			onEvent() {
				received = true;
				open.client.close();
			},
		});
		expect(received).toBe(true);
	});
});

const inboxItem: InboxItem = {
	id: "msg_outgoing",
	sessionID: session.id,
	type: "user",
	payload: { text: "Explore this project" },
	delivery: "steer",
	time: { created: 3000 },
};
const model: ModelInfo = {
	id: "remote-model",
	modelID: "remote-model",
	providerID: "leverage",
	name: "Remote model",
	capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
	variants: [{ id: "high" }],
	time: { released: 0 },
	cost: [],
	status: "active",
	enabled: true,
	limit: { context: 200000, output: 64000 },
};
const permission: PermissionRequest = {
	id: "per_call-one",
	sessionID: session.id,
	action: "write_file",
	resources: [],
	save: ["*"],
	metadata: { path: "notes.txt" },
};
const question: SessionForm = {
	id: "frm_question-one",
	sessionID: session.id,
	title: "Project settings",
	fields: [
		{
			key: "Database?",
			type: "string",
			title: "Database",
			description: "Choose a database",
			required: true,
			options: [
				{ value: "Postgres", label: "Postgres", description: "Shared storage" },
			],
		},
	],
};

describe("Leverage hosted execution", () => {
	test("sends inline attachments and retains the message ID through authentication renewal", async () => {
		const prompts: unknown[] = [];
		const { client } = fixture(async (request) => {
			if (new URL(request.url).pathname.endsWith("/refresh"))
				return Response.json({ access_token: "renewed-token" });
			const input = (await request.json()) as {
				id: string;
				text: string;
				delivery: "steer" | "queue";
			};
			prompts.push(input);
			if (request.headers.get("authorization") !== "Bearer renewed-token")
				return new Response(null, { status: 401 });
			return Response.json({
				data: {
					...inboxItem,
					id: input.id,
					payload: { text: input.text },
					delivery: input.delivery,
				},
			});
		}, "test-refresh");
		const outgoing = {
			id: inboxItem.id,
			text: "Look at this image",
			files: [{ name: "picture.png", uri: "data:image/png;base64,aW1hZ2U=" }],
			delivery: "queue" as const,
		};
		const result = await client.prompt(session.id, outgoing);
		expect(result.id).toBe(outgoing.id);
		expect(result.delivery).toBe("queue");
		expect(prompts).toEqual([outgoing, outgoing]);
	});

	test("does not retry failed sends and lets the caller reuse the same message ID", async () => {
		const ids: string[] = [];
		const { client } = fixture(async (request) => {
			const input = (await request.json()) as { id: string };
			ids.push(input.id);
			return ids.length === 1
				? new Response(null, { status: 503 })
				: Response.json({ data: inboxItem });
		});
		const outgoing = { id: inboxItem.id, text: inboxItem.payload.text };
		await assert.rejects(client.prompt(session.id, outgoing), /503/);
		expect(ids).toEqual([inboxItem.id]);
		expect((await client.prompt(session.id, outgoing)).id).toBe(inboxItem.id);
		expect(ids).toEqual([inboxItem.id, inboxItem.id]);
	});

	test("rejects local attachment paths and mismatched acknowledgements", async () => {
		let requests = 0;
		const { client } = fixture(() => {
			requests++;
			return Response.json({ data: { ...inboxItem, id: "msg_other" } });
		});
		await assert.rejects(
			client.prompt(session.id, {
				id: inboxItem.id,
				text: "read",
				files: [{ uri: "file:///local/private.txt" }],
			}),
			/inline data URLs/,
		);
		expect(requests).toBe(0);
		await assert.rejects(
			client.prompt(session.id, { id: inboxItem.id, text: "read" }),
			/invalid prompt acknowledgement/,
		);
	});

	test("reads hosted models and queue, selects effort, cancels queued input and stops the turn", async () => {
		const writes: Array<{ path: string; method: string; body: unknown }> = [];
		const { client } = fixture(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET")
				return Response.json({
					data: path.endsWith("/model") ? [model] : [inboxItem],
				});
			writes.push({
				path,
				method: request.method,
				body: await request
					.text()
					.then((text): unknown => (text ? JSON.parse(text) : undefined)),
			});
			return path.endsWith("/interrupt")
				? Response.json({ interrupted: true })
				: new Response(null, { status: 204 });
		});
		expect((await client.models())[0]?.variants).toEqual([{ id: "high" }]);
		expect((await client.inbox(session.id))[0]?.payload).toEqual(
			inboxItem.payload,
		);
		await client.selectModel(session.id, {
			providerID: "leverage",
			id: model.id,
			variant: "high",
		});
		await client.cancelInput(session.id, inboxItem.id);
		await client.interrupt(session.id);
		expect(writes).toEqual([
			{
				path: `/api/opencode/api/session/${session.id}/model`,
				method: "POST",
				body: {
					model: { providerID: "leverage", id: model.id, variant: "high" },
				},
			},
			{
				path: `/api/opencode/api/session/${session.id}/inbox/${inboxItem.id}`,
				method: "DELETE",
				body: undefined,
			},
			{
				path: `/api/opencode/api/session/${session.id}/interrupt`,
				method: "POST",
				body: undefined,
			},
		]);
	});

	test("answers governed tools and questions with the IDs supplied by the server", async () => {
		const writes: Array<{ path: string; method: string; body: unknown }> = [];
		const { client } = fixture(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET")
				return Response.json({
					data: path.endsWith("/permission") ? [permission] : [question],
				});
			writes.push({
				path,
				method: request.method,
				body: await request
					.text()
					.then((text): unknown => (text ? JSON.parse(text) : undefined)),
			});
			return new Response(null, { status: 204 });
		});
		const [pending] = await client.permissions(session.id);
		const [form] = await client.forms(session.id);
		if (!pending || !form) throw new Error("Missing pending interaction");
		await client.decidePermission(
			session.id,
			pending.id,
			"reject",
			"Use the existing file",
		);
		await client.answerForm(session.id, form.id, {
			"Database?": "Postgres",
			"Features?": ["Search", "Sync"],
			"Count?": 2,
		});
		await client.cancelForm(session.id, form.id);
		expect(writes).toEqual([
			{
				path: `/api/opencode/api/session/${session.id}/permission/${permission.id}/reply`,
				method: "POST",
				body: { decision: "reject", message: "Use the existing file" },
			},
			{
				path: `/api/opencode/api/session/${session.id}/form/${question.id}/reply`,
				method: "POST",
				body: {
					answer: {
						"Database?": "Postgres",
						"Features?": ["Search", "Sync"],
						"Count?": "2",
					},
				},
			},
			{
				path: `/api/opencode/api/session/${session.id}/form/${question.id}`,
				method: "DELETE",
				body: undefined,
			},
		]);
	});

	test("requests compaction, marks history read, renames and archives the shared task", async () => {
		const writes: Array<{ path: string; body: unknown }> = [];
		const compacted: InboxItem = {
			...inboxItem,
			id: "msg_compact",
			type: "compaction",
			payload: {},
		};
		const { client } = fixture(async (request) => {
			const path = new URL(request.url).pathname;
			writes.push({
				path,
				body: await request
					.text()
					.then((text): unknown => (text ? JSON.parse(text) : undefined)),
			});
			return path.endsWith("/compact")
				? Response.json({ data: compacted })
				: new Response(null, { status: 204 });
		});
		expect((await client.compact(session.id, compacted.id)).type).toBe(
			"compaction",
		);
		await client.markRead(session.id);
		await client.rename(session.id, "  New   title  ");
		await client.archive(session.id, "/alpha/.archive");
		expect(writes).toEqual([
			{
				path: `/api/opencode/api/session/${session.id}/compact`,
				body: { id: compacted.id },
			},
			{ path: `/api/opencode/api/session/${session.id}/view`, body: undefined },
			{
				path: `/api/opencode/api/session/${session.id}`,
				body: { title: "New title" },
			},
			{
				path: `/api/opencode/api/session/${session.id}/move`,
				body: { directory: "/alpha/.archive" },
			},
		]);
	});

	test("rejects malformed interaction lists and surfaces decisions already made elsewhere", async () => {
		let writes = 0;
		const { client } = fixture((request) => {
			if (request.method === "GET")
				return Response.json({ data: [{ id: "frm_bad", fields: [null] }] });
			writes++;
			return new Response(null, { status: 409 });
		});
		await assert.rejects(client.forms(session.id), /invalid list/);
		await assert.rejects(client.models(), /invalid list/);
		await assert.rejects(
			client.decidePermission(session.id, permission.id, "once"),
			/409/,
		);
		expect(writes).toBe(1);
	});
});
