import { afterEach, describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	createAgentSession,
	DefaultResourceLoader,
	discoverAndLoadExtensions,
	type ExtensionActions,
	type ExtensionCommandContextActions,
	ExtensionRunner,
	initTheme,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
	InboxItem,
	PromptRequest,
	SessionEvent,
	SessionInfo,
	SessionMessage,
} from "../src/api";
import { HISTORY_ENTRY } from "../src/history";
import { LINK_ENTRY, sessionLink } from "../src/session-ui";
import { nativeId } from "../src/workspace-api";

// Terminal widgets and history rows draw with the active Pi theme.
initTheme("dark", false);
const directories: string[] = [];
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory() {
	const directory = mkdtempSync(join(tmpdir(), "pi-extension-"));
	directories.push(directory);
	return directory;
}

function models(directory: string) {
	return ModelRuntime.create({
		authPath: join(directory, "auth.json"),
		modelsPath: null,
		modelsStorePath: join(directory, "models.json"),
		allowModelNetwork: false,
		refreshOnCreate: false,
		credentials: {
			read: async () => undefined,
			list: async () => [],
			modify: async (_provider, update) => update(undefined),
			delete: async () => {},
		},
	});
}

async function load(
	options: {
		manager?: SessionManager;
		onPrompt?: () => void;
		sendUserMessage?: ExtensionActions["sendUserMessage"];
		activeTools?: (tools: string[]) => void;
	} = {},
) {
	const directory = options.manager?.getCwd() ?? temporaryDirectory();
	const manager = options.manager ?? SessionManager.inMemory(directory);
	const loaded = await discoverAndLoadExtensions(
		[resolve(import.meta.dir, "..")],
		directory,
		directory,
	);
	expect(loaded.errors).toEqual([]);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		directory,
		manager,
		new ModelRegistry(await models(directory)),
	);
	runner.bindCore(
		{
			...loaded.runtime,
			appendEntry(type, data) {
				manager.appendCustomEntry(type, data);
			},
			setSessionName(name) {
				manager.appendSessionInfo(name);
			},
			getSessionName: () => manager.getSessionName(),
			setActiveTools(names) {
				options.activeTools?.(names);
			},
			getActiveTools: () => [],
			sendMessage() {
				options.onPrompt?.();
			},
			sendUserMessage(content, settings) {
				if (options.sendUserMessage) options.sendUserMessage(content, settings);
				else options.onPrompt?.();
			},
		},
		{
			getModel: () => undefined,
			getScopedModels: () => [],
			isIdle: () => true,
			isProjectTrusted: () => true,
			getSignal: () => undefined,
			abort() {},
			hasPendingMessages: () => false,
			shutdown() {},
			getContextUsage: () => undefined,
			compact() {},
			getSystemPrompt: () => "",
		},
	);
	disposals.push(async () => {
		await runner.emit({ type: "session_shutdown", reason: "quit" });
	});
	return runner;
}

const sharedSession: SessionInfo = {
	id: "ses_task-one",
	projectID: "prj_workspace",
	location: { directory: "/demo/project" },
	title: "Shared project",
	cost: 0,
	tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	time: { created: 1, updated: 2 },
};

function serverFixture(
	messages: SessionMessage[] = [],
	connectImmediately = true,
) {
	const requests: Array<{ method: string; url: URL; body?: unknown }> = [];
	const sessions = [{ ...sharedSession }];
	const histories = new Map([[sharedSession.id, messages]]);
	const inputs = new Map<string, InboxItem[]>();
	const active: Record<string, { type: "running" }> = {};
	const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
	const state = {
		promptFailures: 0,
		denied: false,
		streamDenied: false,
		historyFailure: undefined as Promise<void> | undefined,
	};
	let sequence = 0;
	const encode = (event: SessionEvent) =>
		new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
	const publish = (event: SessionEvent) => {
		for (const stream of streams) stream.enqueue(encode(event));
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			if (new URL(request.url).pathname === "/ws" && server.upgrade(request))
				return;
			const url = new URL(request.url);
			const text =
				request.method === "POST" || request.method === "PATCH"
					? await request.text()
					: "";
			const body: unknown = text ? JSON.parse(text) : undefined;
			requests.push({ method: request.method, url, body });
			const path = url.pathname;
			if (state.denied || (state.streamDenied && path.endsWith("/event")))
				return Response.json({ message: "Access denied" }, { status: 403 });
			if (path === "/api/workspaces")
				return Response.json([{ id: "workspace", slug: "demo" }]);
			if (path === "/api/users")
				return Response.json([{ id: "owner", name: "Test owner" }]);
			if (path === "/api/channels")
				return Response.json([
					{
						id: "channel",
						name: "project",
						defaultProviderFamily: "claude_code",
					},
				]);
			if (path.endsWith("/provider-family-settings"))
				return Response.json({ settings: [] });
			if (path.endsWith("/provider-access/availability"))
				return Response.json({ claude_code: true, codex: false });
			if (path.endsWith("/bootstrap")) {
				const session =
					sessions.find((one) => path.includes(nativeId(one.id))) ??
					sharedSession;
				return Response.json({
					session: {
						id: nativeId(session.id),
						title: session.title,
						channelId: null,
						visibility: "private",
						providerFamily: "claude_code",
						model: null,
						mode: "yolo",
						status: "idle",
						ownerId: "owner",
					},
					messages: [],
					version: 0,
					lastCursorIncluded: 0,
					viewerCanWrite: true,
				});
			}
			if (path.endsWith("/api/event")) {
				let stream: ReadableStreamDefaultController<Uint8Array>;
				return new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							stream = controller;
							streams.add(controller);
							if (connectImmediately)
								controller.enqueue(
									encode({
										id: `evt_connected_${++sequence}`,
										type: "server.connected",
										location: { directory: "/demo" },
										data: {},
									}),
								);
						},
						cancel() {
							streams.delete(stream);
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			}
			const selectedId =
				path.match(/\/session\/(ses_[^/]+)/)?.[1] ?? sharedSession.id;
			if (path.endsWith("/message")) {
				if (state.historyFailure) {
					await state.historyFailure;
					return Response.json(
						{ message: "History is unavailable" },
						{ status: 503 },
					);
				}
				return Response.json({
					data: histories.get(selectedId) ?? [],
					cursor: {},
				});
			}
			if (path.endsWith("/inbox"))
				return Response.json({ data: inputs.get(selectedId) ?? [] });
			if (path.endsWith("/permission") || path.endsWith("/form"))
				return Response.json({ data: [] });
			if (path.endsWith("/active")) return Response.json({ data: active });
			if (path.endsWith("/view")) return new Response(null, { status: 204 });
			if (path.endsWith("/interrupt")) {
				delete active[selectedId];
				return Response.json({ interrupted: true });
			}
			if (path.endsWith("/prompt")) {
				if (state.promptFailures > 0) {
					state.promptFailures--;
					return Response.json(
						{ message: "Runner unavailable" },
						{ status: 503 },
					);
				}
				const prompt = body as PromptRequest;
				const inbox = inputs.get(selectedId) ?? [];
				const accepted: Extract<InboxItem, { type: "user" }> = inbox.find(
					(item): item is Extract<InboxItem, { type: "user" }> =>
						item.type === "user" && item.id === prompt.id,
				) ?? {
					id: prompt.id,
					sessionID: selectedId,
					type: "user",
					payload: { text: prompt.text },
					delivery: prompt.delivery ?? "steer",
					time: { created: ++sequence },
				};
				if (!inbox.includes(accepted)) inbox.push(accepted);
				inputs.set(selectedId, inbox);
				publish({
					id: `evt_prompt_${++sequence}`,
					type: "session.inbox.enqueued",
					created: sequence,
					durable: { aggregateID: selectedId, seq: sequence, version: 1 },
					data: {
						sessionID: selectedId,
						inboxID: accepted.id,
						item: {
							type: "user",
							payload: accepted.payload,
							delivery: accepted.delivery,
						},
					},
				});
				return Response.json({ data: accepted });
			}
			if (path.endsWith("/terminal"))
				return Response.json(
					{ message: "Tools are starting" },
					{ status: 503 },
				);
			if (path.endsWith("/project"))
				return Response.json([{ sandboxes: ["/demo/project"] }]);
			if (request.method === "POST" && path.endsWith("/session")) {
				const input = body as { id: string; location: { directory: string } };
				const session = {
					...sharedSession,
					id: input.id,
					location: input.location,
				};
				sessions.push(session);
				return Response.json({ data: session });
			}
			if (request.method === "PATCH") {
				const session = sessions.find((item) => item.id === selectedId);
				if (session && body && typeof body === "object" && "title" in body)
					session.title = String(body.title);
				return new Response(null, { status: 204 });
			}
			if (path.endsWith("/session"))
				return Response.json({ data: sessions, cursor: {} });
			const session = sessions.find((item) => path.endsWith(`/${item.id}`));
			return session
				? Response.json({ data: session })
				: new Response(null, { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ type: "connection.ready", userId: "owner" }));
			},
			message() {},
		},
	});
	const previousToken = process.env.LEVERAGE_TOKEN;
	process.env.LEVERAGE_TOKEN = "test-device-token";
	disposals.push(async () => {
		if (previousToken === undefined) delete process.env.LEVERAGE_TOKEN;
		else process.env.LEVERAGE_TOKEN = previousToken;
		await server.stop(true);
	});
	return {
		requests,
		sessions,
		histories,
		inputs,
		active,
		streams,
		state,
		publish,
		origin: server.url.origin,
		configure(runner: ExtensionRunner, sessionId?: string) {
			runner.setFlagValue("leverage-host", server.url.origin);
			runner.setFlagValue("leverage-workspace", "demo");
			if (sessionId) runner.setFlagValue("leverage-session", sessionId);
		},
	};
}

function commandActions(
	runner: ExtensionRunner,
	overrides: Partial<ExtensionCommandContextActions> = {},
) {
	runner.bindCommandContext({
		waitForIdle: async () => {},
		newSession: async () => ({ cancelled: false }),
		fork: async () => ({ cancelled: false }),
		navigateTree: async () => ({ cancelled: false }),
		switchSession: async () => ({ cancelled: false }),
		reload: async () => {},
		...overrides,
	});
}

async function command(runner: ExtensionRunner, text: string) {
	const handler = runner.getCommand("leverage");
	if (!handler) throw new Error("Missing Leverage command");
	await handler.handler(text, runner.createCommandContext());
}

function transcript(runner: ExtensionRunner) {
	const renderer = runner.getEntryRenderer(HISTORY_ENTRY);
	if (!renderer) throw new Error("Missing shared history renderer");
	return stripVTControlCharacters(
		runner
			.createContext()
			.sessionManager.getBranch()
			.flatMap((entry) =>
				entry.type === "custom" && entry.customType === HISTORY_ENTRY
					? (renderer(
							entry,
							{ expanded: false },
							runner.getUIContext().theme,
						)?.render(120) ?? [])
					: [],
			)
			.join("\n"),
	);
}

function historyRows(runner: ExtensionRunner) {
	return runner
		.createContext()
		.sessionManager.getBranch()
		.filter(
			(entry) => entry.type === "custom" && entry.customType === HISTORY_ENTRY,
		);
}

async function eventually(check: () => boolean | Promise<boolean>) {
	for (let attempt = 0; attempt < 200; attempt++) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("The extension did not reach its expected state");
}

function user(id: string, text: string, created = 1): SessionMessage {
	return { id, type: "user", text, time: { created } };
}

let nextEvent = 0;
function event<T extends SessionEvent["type"]>(
	type: T,
	data: Extract<SessionEvent, { type: T }>["data"],
): Extract<SessionEvent, { type: T }> {
	return {
		id: `evt_test_${++nextEvent}`,
		type,
		created: nextEvent,
		...(!type.endsWith(".delta") && type !== "session.tool.progress"
			? {
					durable: {
						aggregateID: sharedSession.id,
						seq: nextEvent,
						version:
							type === "session.tool.success" || type === "session.tool.failed"
								? 2
								: 1,
					},
				}
			: {}),
		data,
	} as Extract<SessionEvent, { type: T }>;
}

describe("Pi hosted frontend", () => {
	test("opens newest-first history pages in chronological chat order", async () => {
		const fixture = serverFixture();
		fixture.histories.set(sharedSession.id, [
			user("msg_later", "The later message", 20),
			user("msg_earlier", "The earlier message", 10),
		]);
		const runner = await load();
		fixture.configure(runner, sharedSession.id);
		await runner.emit({ type: "session_start", reason: "startup" });
		const content = transcript(runner);
		expect(content).toContain("The later message");
		expect(content.indexOf("The earlier message")).toBeLessThan(
			content.indexOf("The later message"),
		);
	});

	test("loads through Pi, disables local tools, and keeps disconnected input handled", async () => {
		const fixture = serverFixture();
		fixture.state.denied = true;
		const toolSelections: string[][] = [];
		const runner = await load({
			activeTools: (names) => toolSelections.push(names),
		});
		fixture.configure(runner, sharedSession.id);
		const notices: string[] = [];
		runner.setUIContext({
			...runner.getUIContext(),
			notify: (message) => {
				notices.push(message);
			},
		});
		await runner.emit({ type: "session_start", reason: "startup" });
		expect(toolSelections).toEqual([[]]);
		expect(
			await runner.emitInput(
				"Read the local secrets",
				undefined,
				"interactive",
			),
		).toEqual({ action: "handled" });
		expect(notices.join("\n")).toContain("403");
		expect(fixture.requests.map((request) => request.url.pathname)).toEqual([
			`/api/opencode/api/session/${sharedSession.id}`,
		]);
		expect(runner.createContext().sessionManager.getBranch()).toEqual([]);
	});

	test("disconnected manual shell commands cannot fall back to the local machine", async () => {
		const runner = await load();
		const directory = runner.createContext().cwd;
		const sentinel = join(directory, "should-not-exist");
		const shell = `touch '${sentinel}'`;
		const result = await runner.emitUserBash({
			type: "user_bash",
			command: shell,
			cwd: directory,
			excludeFromContext: false,
		});
		if (!result?.operations) throw new Error("Missing remote shell operations");
		await rejects(
			result.operations.exec(shell, directory, { onData() {} }),
			/leverage/i,
		);
		expect(existsSync(sentinel)).toBe(false);
	});

	test("the published AgentSession sends prompts and images without local model authentication or execution, including HTTP failure", async () => {
		const fixture = serverFixture();
		const directory = temporaryDirectory();
		const settingsManager = SettingsManager.inMemory();
		const modelRuntime = await models(directory);
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager,
			additionalExtensionPaths: [resolve(import.meta.dir, "..")],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const { session } = await createAgentSession({
			cwd: directory,
			agentDir: directory,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(directory),
			settingsManager,
		});
		fixture.configure(session.extensionRunner, sharedSession.id);
		const notices: string[] = [];
		const events: string[] = [];
		session.subscribe((message) => {
			events.push(message.type);
		});
		disposals.push(async () => {
			await session.extensionRunner.emit({
				type: "session_shutdown",
				reason: "quit",
			});
			session.dispose();
		});
		await session.bindExtensions({
			mode: "print",
			uiContext: {
				...session.extensionRunner.getUIContext(),
				notify: (message) => {
					notices.push(message);
				},
			},
		});
		expect(await modelRuntime.listCredentials()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual([]);
		await session.prompt("Explain this image", {
			images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
		});
		const sent = fixture.requests.find((request) =>
			request.url.pathname.endsWith("/prompt"),
		);
		expect(sent?.body).toMatchObject({
			text: "Explain this image",
			delivery: "steer",
			files: [{ name: "image-1.png", uri: "data:image/png;base64,aGVsbG8=" }],
		});
		expect(transcript(session.extensionRunner)).toContain("Explain this image");
		fixture.state.promptFailures = 1;
		await session.prompt("A failed request still cannot run locally");
		expect(notices.join("\n")).toContain("503");
		expect(events).not.toContain("agent_start");
		expect(events).not.toContain("tool_execution_start");
		expect(session.agent.state.messages).toEqual([]);
		expect(session.isStreaming).toBe(false);
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/prompt"),
			),
		).toHaveLength(2);
	}, 15000);

	test("startup leaves the normal composer empty without opening a picker or creating a remote session", async () => {
		const fixture = serverFixture();
		const runner = await load();
		fixture.configure(runner);
		const widgets: string[][] = [];
		runner.setUIContext(
			{
				...runner.getUIContext(),
				select: async () => {
					throw new Error("Startup must not open a picker");
				},
				setWidget: (_key, value) => {
					if (typeof value === "function")
						widgets.push(value({} as never, {} as never).render(120));
				},
			},
			"tui",
		);
		await runner.emit({ type: "session_start", reason: "startup" });
		await eventually(() =>
			widgets.some((lines) =>
				lines.some((line) => line.includes("Standalone")),
			),
		);
		expect(widgets.flat().join("\n")).toContain("New Leverage session");
		expect(fixture.requests.every((request) => request.method === "GET")).toBe(
			true,
		);
		expect(
			sessionLink(runner.createContext().sessionManager.getBranch()),
		).toBeUndefined();
	});

	test("new sessions create a local draft without a remote task or prompt", async () => {
		const fixture = serverFixture();
		const runner = await load();
		fixture.configure(runner);
		let opened = false;
		commandActions(runner, {
			newSession: async () => {
				opened = true;
				await runner.emit({ type: "session_start", reason: "new" });
				return { cancelled: false };
			},
		});
		await command(runner, "new Explore the project");
		expect(opened).toBe(true);
		expect(fixture.sessions).toHaveLength(1);
		expect(fixture.requests.some((request) => request.method !== "GET")).toBe(
			false,
		);
		expect(
			sessionLink(runner.createContext().sessionManager.getBranch()),
		).toBeUndefined();
	});

	test("two clients share prompts, streamed answers, and tool progress without starting local agents", async () => {
		const fixture = serverFixture([
			user("msg_existing", "Alex: Existing shared history"),
		]);
		let localPrompts = 0;
		const first = await load({
			onPrompt: () => {
				localPrompts++;
			},
		});
		const second = await load({
			onPrompt: () => {
				localPrompts++;
			},
		});
		const notices: string[] = [];
		for (const runner of [first, second])
			runner.setUIContext({
				...runner.getUIContext(),
				notify: (message) => {
					notices.push(message);
				},
			});
		for (const runner of [first, second]) {
			fixture.configure(runner, sharedSession.id);
			await runner.emit({ type: "session_start", reason: "startup" });
		}
		await eventually(() => fixture.streams.size === 2);
		expect(transcript(first)).toContain("Alex: Existing shared history");
		await first.emitInput("Jordan: I fixed the test", undefined, "interactive");
		await eventually(() =>
			transcript(second).includes("Jordan: I fixed the test"),
		);
		fixture.publish(
			event("session.step.started", {
				sessionID: sharedSession.id,
				assistantMessageID: "msg_reply",
				agent: "remote",
				model: { providerID: "leverage", id: "remote" },
				started: 2,
			}),
		);
		fixture.publish(
			event("session.text.delta", {
				sessionID: sharedSession.id,
				assistantMessageID: "msg_reply",
				ordinal: 0,
				delta: "Checking the project",
			}),
		);
		const ref = {
			sessionID: sharedSession.id,
			assistantMessageID: "msg_reply",
			id: "tool_check",
		};
		fixture.publish(
			event("session.tool.input.started", { ...ref, name: "bash" }),
		);
		fixture.publish(
			event("session.tool.called", {
				...ref,
				input: { command: "bun test" },
				executed: true,
			}),
		);
		fixture.publish(
			event("session.tool.progress", {
				...ref,
				metadata: { output: "Tests are running" },
			}),
		);
		await eventually(
			() =>
				transcript(first).includes("Tests are running") &&
				transcript(second).includes("Tests are running"),
		);
		const duplicate = event("session.text.ended", {
			sessionID: sharedSession.id,
			assistantMessageID: "msg_reply",
			ordinal: 0,
			text: "The project passes.",
		});
		fixture.publish(duplicate);
		fixture.publish(duplicate);
		fixture.publish(
			event("session.tool.success", {
				...ref,
				executed: true,
				content: [{ type: "text", text: "All tests passed" }],
			}),
		);
		await eventually(() =>
			transcript(second).includes("All tests passed"),
		).catch(() => {
			throw new Error(`${notices.join("\n")}\n${transcript(second)}`);
		});
		for (const runner of [first, second]) {
			expect(historyRows(runner)).toHaveLength(3);
			expect(transcript(runner)).toContain("The project passes.");
			expect(transcript(runner)).toContain("✓ bash bun test");
			expect(
				runner
					.createContext()
					.sessionManager.getBranch()
					.some((entry) => entry.type === "message"),
			).toBe(false);
		}
		expect(localPrompts).toBe(0);
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/prompt"),
			),
		).toHaveLength(1);
	});

	test("queue, explicit retry, and stop use the shared session API without duplicate messages", async () => {
		const fixture = serverFixture();
		const runner = await load();
		fixture.configure(runner, sharedSession.id);
		commandActions(runner);
		await runner.emit({ type: "session_start", reason: "startup" });
		await command(runner, "queue Check this after the current task");
		expect(transcript(runner)).toContain("Queued");
		fixture.state.promptFailures = 1;
		await runner.emitInput(
			"Try exactly once until I ask",
			undefined,
			"interactive",
		);
		await command(runner, "retry");
		const prompts = fixture.requests.filter((request) =>
			request.url.pathname.endsWith("/prompt"),
		);
		expect(prompts).toHaveLength(3);
		expect(prompts[0]?.body).toMatchObject({ delivery: "queue" });
		expect(prompts[1]?.body).toEqual(prompts[2]?.body);
		expect(historyRows(runner)).toHaveLength(2);
		await command(runner, "stop");
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/interrupt"),
			),
		).toHaveLength(1);
		await runner.emit({ type: "session_shutdown", reason: "quit" });
		await eventually(() => fixture.streams.size === 0);
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/interrupt"),
			),
		).toHaveLength(1);
	});

	test("switching views restores each server transcript and closes the previous subscription", async () => {
		const fixture = serverFixture([user("msg_first", "First shared task")]);
		const other = { ...sharedSession, id: "ses_second", title: "Second task" };
		fixture.sessions.push(other);
		fixture.histories.set(other.id, [user("msg_other", "Second shared task")]);
		const first = await load();
		fixture.configure(first, sharedSession.id);
		await first.emit({ type: "session_start", reason: "startup" });
		const replacement = SessionManager.inMemory(first.createContext().cwd);
		commandActions(first, {
			newSession: async (options) => {
				await options?.setup?.(replacement);
				await first.emit({ type: "session_shutdown", reason: "quit" });
				return { cancelled: false };
			},
		});
		await command(first, `open ${other.id}`);
		expect(sessionLink(replacement.getBranch())?.sessionId).toBe(other.id);
		const second = await load({ manager: replacement });
		fixture.configure(second);
		await second.emit({ type: "session_start", reason: "new" });
		await eventually(() => fixture.streams.size === 1);
		expect(transcript(second)).toContain("Second shared task");
		expect(transcript(second)).not.toContain("First shared task");
		commandActions(second, {
			newSession: async () => {
				throw new Error("Same session must keep its view");
			},
		});
		await command(second, `open ${other.id}`);
		expect(historyRows(second)).toHaveLength(1);
		expect(fixture.streams.size).toBe(1);
		expect(
			fixture.requests.some((request) =>
				request.url.pathname.endsWith("/interrupt"),
			),
		).toBe(false);
	});

	test("reports one failed startup read and accepts prompts after reconnecting", async () => {
		const fixture = serverFixture();
		let failHistory = () => {};
		fixture.state.historyFailure = new Promise<void>((resolve) => {
			failHistory = resolve;
		});
		const runner = await load();
		fixture.configure(runner, sharedSession.id);
		const notices: string[] = [];
		let live = false;
		runner.setUIContext({
			...runner.getUIContext(),
			notify: (message) => notices.push(message),
			setStatus: (_key, value) => {
				live ||= value?.endsWith(" · live") ?? false;
			},
		});
		const startup = runner.emit({ type: "session_start", reason: "startup" });
		await eventually(() => live);
		failHistory();
		await startup;
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("503");

		fixture.state.historyFailure = undefined;
		fixture.histories.set(sharedSession.id, [
			user("msg_recovered", "Recovered"),
		]);
		fixture.publish({
			id: "evt_reconnected",
			type: "server.connected",
			location: { directory: "/demo" },
			data: {},
		});
		await eventually(() => transcript(runner).includes("Recovered"));
		await eventually(() =>
			fixture.requests.some((request) =>
				request.url.pathname.endsWith("/view"),
			),
		);
		expect(
			await runner.emitInput(
				"Continue after recovery",
				undefined,
				"interactive",
			),
		).toEqual({ action: "handled" });
		const prompts = fixture.requests.filter((request) =>
			request.url.pathname.endsWith("/prompt"),
		);
		expect(prompts).toHaveLength(1);
		expect(prompts[0]?.body).toMatchObject({ text: "Continue after recovery" });
		expect(fixture.inputs.get(sharedSession.id)).toHaveLength(1);
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/view"),
			),
		).toHaveLength(1);
		expect(notices).toHaveLength(1);
	});

	test("delayed first SSE connection repairs the initial snapshot and resumed markers do not duplicate rows", async () => {
		const messages = [user("msg_before", "Before connecting")];
		const fixture = serverFixture(messages, false);
		const manager = SessionManager.inMemory(temporaryDirectory());
		manager.appendCustomEntry(LINK_ENTRY, {
			version: 1,
			host: fixture.origin,
			workspace: "demo",
			sessionId: sharedSession.id,
		});
		manager.appendCustomEntry(HISTORY_ENTRY, {
			sessionId: sharedSession.id,
			id: "msg_before",
		});
		const runner = await load({ manager });
		fixture.configure(runner, sharedSession.id);
		await runner.emit({ type: "session_start", reason: "startup" });
		messages.push(user("msg_between", "Written during connection setup", 2));
		await eventually(() => fixture.streams.size === 1);
		fixture.publish({
			id: "evt_first_connected",
			type: "server.connected",
			location: { directory: "/demo" },
			data: {},
		});
		await eventually(() =>
			transcript(runner).includes("Written during connection setup"),
		);
		expect(historyRows(runner)).toHaveLength(2);
		expect(transcript(runner)).toContain("Before connecting");
		expect(
			fixture.requests.filter((request) =>
				request.url.pathname.endsWith("/message"),
			).length,
		).toBeGreaterThanOrEqual(2);
	});
});
