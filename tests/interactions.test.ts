import { afterEach, describe, expect, test } from "bun:test";
import type {
	ExtensionContext,
	ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	type ModelInfo,
	type PermissionRequest,
	SessionClient,
	type SessionEvent,
	type SessionForm,
} from "../src/api";
import { PendingInteractions } from "../src/interactions";

const permission: PermissionRequest = {
	id: "per_publish",
	sessionID: "ses_shared",
	action: "publish change",
	resources: ["project/example"],
	save: ["*"],
	metadata: { branch: "feature" },
};
const form: SessionForm = {
	id: "frm_details",
	sessionID: "ses_shared",
	title: "Project details",
	fields: [{ key: "name", type: "string", required: true, title: "Name" }],
};
const model: ModelInfo = {
	id: "hosted-model",
	modelID: "hosted-model",
	providerID: "leverage",
	name: "Hosted model",
	capabilities: { tools: true, input: ["text"], output: ["text"] },
	variants: [{ id: "low" }, { id: "high" }],
	time: { released: 0 },
	cost: [],
	status: "active",
	enabled: true,
	limit: { context: 200_000, output: 64000 },
};
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function fixture(
	ui: Partial<ExtensionUIContext> = {},
	extra?: (request: Request) => Response | Promise<Response>,
) {
	const state = {
		permissions: [permission],
		forms: [] as SessionForm[],
		writes: [] as Array<{ method: string; path: string; body?: unknown }>,
		widgets: [] as Array<string[] | undefined>,
		notifications: [] as string[],
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method !== "GET") {
				state.writes.push({
					method: request.method,
					path,
					...(request.method === "POST"
						? { body: (await request.clone().json()) as unknown }
						: {}),
				});
			}
			if (extra) return extra(request);
			if (request.method !== "GET") return new Response(null, { status: 204 });
			return Response.json({
				data: path.endsWith("/permission")
					? state.permissions
					: path.endsWith("/model")
						? [model]
						: state.forms,
			});
		},
	});
	const client = new SessionClient({
		host: server.url.origin,
		workspace: "demo",
		token: "test-token",
	});
	const controller = new AbortController();
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			setWidget: (_key: string, content: string[] | undefined) =>
				state.widgets.push(content),
			notify: (message: string) => state.notifications.push(message),
			...ui,
		},
	} as ExtensionContext;
	const pending = new PendingInteractions(
		client,
		ctx,
		"ses_shared",
		controller.signal,
	);
	disposals.push(async () => {
		controller.abort();
		client.close();
		await server.stop(true);
	});
	return { pending, state, controller };
}
function replied(): SessionEvent {
	return {
		id: "evt_settled",
		created: 1,
		type: "permission.replied",
		location: { directory: "/demo" },
		data: { sessionID: "ses_shared", requestID: permission.id, reply: "once" },
	};
}

describe("Leverage shared interactions", () => {
	test("leaves approvals pending on escape and sends only the explicit decision", async () => {
		let action: string | undefined;
		const { pending, state } = fixture({
			select: async (title) => {
				expect(title).toContain('"branch": "feature"');
				expect(title).not.toContain("\u001b");
				return action;
			},
			input: async () => "Needs review",
		});
		state.permissions = [{ ...permission, action: "\u001b[2Jpublish change" }];
		await pending.show("approvals");
		expect(state.writes).toHaveLength(0);
		expect(state.widgets.at(-1)?.[0]).toContain("1 approval");
		action = "Approve once";
		await pending.show("approvals");
		action = "Deny";
		await pending.show("approvals");
		expect(state.writes.map((one) => one.body)).toEqual([
			{ decision: "once" },
			{ decision: "reject", message: "Needs review" },
		]);
	});

	test.each([
		"approvals",
		"questions",
	] as const)("closes stale %s when a peer decides the approval", async (kind) => {
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const { pending, state } = fixture({
			select: (_title, _options, options) =>
				new Promise((resolve) => {
					options!.signal!.addEventListener(
						"abort",
						() => resolve("Approve once"),
						{ once: true },
					);
					opened();
				}),
		});
		if (kind === "questions")
			state.forms = [{ ...form, id: "frm_scope_publish" }];
		const showing = pending.show(kind);
		await ready;
		expect(pending.hasDialog).toBe(true);
		pending.apply(replied());
		await showing;
		expect(state.writes).toHaveLength(0);
		expect(pending.hasDialog).toBe(false);
		expect(state.widgets.at(-1)).toBeUndefined();
	});

	test("requires a fresh approval when the requested arguments change", async () => {
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		let aborted = false;
		const { pending, state } = fixture({
			select: (_title, _options, options) =>
				new Promise((resolve) => {
					options!.signal!.addEventListener(
						"abort",
						() => {
							aborted = true;
							resolve("Approve once");
						},
						{ once: true },
					);
					opened();
				}),
		});
		const showing = pending.show("approvals");
		await ready;
		pending.apply({
			id: "evt_repeat",
			created: 1,
			type: "permission.asked",
			data: { metadata: permission.metadata, ...permission },
		});
		expect(aborted).toBe(false);
		pending.apply({
			id: "evt_changed",
			created: 2,
			type: "permission.asked",
			data: { ...permission, metadata: { branch: "main" } },
		});
		await showing;
		expect(aborted).toBe(true);
		expect(state.writes).toHaveLength(0);
	});

	test("does not restore a peer-resolved request from an older refresh", async () => {
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		let release!: () => void;
		const delayed = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reads = 0;
		const { pending, state } = fixture({}, async (request) => {
			if (request.url.endsWith("/permission")) {
				if (++reads === 1) {
					started();
					await delayed;
					return Response.json({ data: [permission] });
				}
			}
			return Response.json({ data: [] });
		});
		const refreshing = pending.refresh();
		await ready;
		pending.apply(replied());
		release();
		await refreshing;
		expect(reads).toBe(2);
		expect(state.widgets.at(-1)).toBeUndefined();
	});

	test("session shutdown cancels a question without rejecting it remotely", async () => {
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => {
			opened = resolve;
		});
		const { pending, state, controller } = fixture({
			select: (_title, _options, options) =>
				new Promise((resolve) => {
					options!.signal!.addEventListener(
						"abort",
						() => resolve("Cancel question"),
						{ once: true },
					);
					opened();
				}),
		});
		state.forms = [form];
		const showing = pending.show("questions");
		await ready;
		controller.abort();
		await showing;
		expect(state.writes).toHaveLength(0);
	});

	test("collects required, multiple, conditional and custom answers before one shared reply", async () => {
		const inputs = ["", "Atlas", "Custom", "3"];
		const actions = [
			"Answer",
			"first",
			"second",
			"Done",
			"Write another answer",
		];
		const { pending, state } = fixture({
			input: async () => inputs.shift(),
			select: async (_title, options) => {
				const next = actions.shift();
				return next === "first"
					? options[0]
					: next === "second"
						? options[1]
						: next;
			},
			confirm: async (_title, summary) => {
				expect(summary).toContain("Atlas");
				expect(summary).toContain("a, b");
				return true;
			},
		});
		state.forms = [
			{
				...form,
				fields: [
					{
						key: "name",
						type: "string",
						required: true,
						minLength: 2,
						title: "Name",
					},
					{
						key: "targets",
						type: "multiselect",
						required: true,
						minItems: 2,
						options: [
							{ label: "A", value: "a" },
							{ label: "B", value: "b" },
						],
					},
					{
						key: "other",
						type: "string",
						custom: true,
						options: [{ label: "Choice", value: "choice" }],
					},
					{
						key: "count",
						type: "integer",
						minimum: 1,
						when: [{ key: "targets", op: "eq", value: "a" }],
					},
					{ key: "hidden", type: "boolean", hidden: true, default: false },
					{
						key: "inactive",
						type: "string",
						required: true,
						when: [{ key: "count", op: "eq", value: 99 }],
					},
				],
			},
		];
		await pending.show("questions");
		expect(state.notifications).toContain("An answer is required.");
		expect(state.writes).toEqual([
			{
				method: "POST",
				path: "/api/opencode/api/session/ses_shared/form/frm_details/reply",
				body: {
					answer: {
						name: "Atlas",
						targets: ["a", "b"],
						other: "Custom",
						count: "3",
						hidden: "false",
					},
				},
			},
		]);
	});

	test("does not submit partial answers or turn escape into question cancellation", async () => {
		const { pending, state } = fixture({
			select: async () => "Answer",
			input: async () => undefined,
		});
		state.forms = [form];
		await pending.show("questions");
		expect(state.writes).toHaveLength(0);
	});

	test("requires a deliberate confirmation to cancel a question", async () => {
		let confirmed = false;
		const { pending, state } = fixture({
			select: async () => "Cancel question",
			confirm: async () => confirmed,
		});
		state.forms = [form];
		await pending.show("questions");
		expect(state.writes).toHaveLength(0);
		confirmed = true;
		await pending.show("questions");
		expect(state.writes).toEqual([
			{
				method: "DELETE",
				path: "/api/opencode/api/session/ses_shared/form/frm_details",
			},
		]);
	});

	test("remembers approval scope through the server form and leaves a cancelled scope pending", async () => {
		const scope: SessionForm = {
			id: "frm_scope_publish",
			sessionID: "ses_shared",
			title: "Remember this approval",
			fields: [
				{
					type: "string",
					key: "scope",
					required: true,
					options: [
						{ label: "This session", value: "This session" },
						{ label: "Always", value: "Always" },
					],
				},
			],
		};
		let chooseScope = false;
		let answers = ["Approve and remember…", "Answer", "scope"];
		const { pending, state } = fixture({
			select: async (_title, options) => {
				expect(options).not.toContain("Cancel question");
				const next = answers.shift();
				return next === "scope" ? (chooseScope ? options[0] : undefined) : next;
			},
			confirm: async () => true,
		});
		state.forms = [scope];
		await pending.show("approvals");
		expect(state.writes.map((write) => write.body)).toEqual([
			{ decision: "always" },
		]);
		chooseScope = true;
		answers = ["Answer", "scope"];
		await pending.show("questions");
		expect(state.writes.at(-1)?.body).toEqual({
			answer: { scope: "This session" },
		});
	});

	test("selects the hosted model and reasoning effort without changing local model settings", async () => {
		let chooseEffort = false;
		const { pending, state } = fixture({
			select: async (_title, options) => {
				if (!chooseEffort) {
					chooseEffort = true;
					return options[0];
				}
				return "high";
			},
		});
		await pending.show("model");
		expect(state.writes).toEqual([
			{
				method: "POST",
				path: "/api/opencode/api/session/ses_shared/model",
				body: {
					model: {
						providerID: "leverage",
						id: "hosted-model",
						variant: "high",
					},
				},
			},
		]);
	});

	test("cancels queued input only after confirmation and does not cancel messages already sending", async () => {
		let queued = true;
		let picks = 0;
		const { pending, state } = fixture(
			{
				select: async (_title, options) => options[picks++ === 0 ? 0 : 1],
				confirm: async () => true,
			},
			(request) => {
				if (request.method === "DELETE") {
					queued = false;
					return new Response(null, { status: 204 });
				}
				return Response.json({
					data: queued
						? [
								{
									id: "msg_sending",
									sessionID: "ses_shared",
									time: { created: 1 },
									type: "user",
									payload: { text: "In flight" },
									delivery: "steer",
								},
								{
									id: "msg_queued",
									sessionID: "ses_shared",
									time: { created: 2 },
									type: "user",
									payload: { text: "Next turn" },
									delivery: "queue",
								},
							]
						: [],
				});
			},
		);
		await pending.show("inbox");
		expect(state.notifications).toContain(
			"This message is already on its way.",
		);
		expect(state.writes).toEqual([
			{
				method: "DELETE",
				path: "/api/opencode/api/session/ses_shared/inbox/msg_queued",
			},
		]);
	});
});
