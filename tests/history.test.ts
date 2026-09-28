import { describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { SessionEvent, SessionMessage } from "../src/api";
import {
	createHistoryComponent,
	isHistoryEntry,
	SharedHistory,
} from "../src/history";
import { nativeId } from "../src/workspace-api";

const sessionId = "ses_shared";
let nextEvent = 0;

function event<T extends SessionEvent["type"]>(
	type: T,
	data: Extract<SessionEvent, { type: T }>["data"],
): Extract<SessionEvent, { type: T }> {
	return {
		id: `evt_${++nextEvent}`,
		type,
		created: nextEvent,
		...(!type.endsWith(".delta") && type !== "session.tool.progress"
			? {
					durable: {
						aggregateID: sessionId,
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

function user(id: string, text: string, created = 1): SessionMessage {
	return { id, type: "user", text, time: { created } };
}

function assistant(
	text: string,
): Extract<SessionMessage, { type: "assistant" }> {
	return {
		id: "msg_reply",
		type: "assistant",
		agent: "remote",
		model: { providerID: "leverage", id: "remote" },
		content: [{ type: "text", text }],
		time: { created: 2, completed: 3 },
	};
}

describe("Shared session history", () => {
	test("renders participant text, assistant markdown, and completed tools", () => {
		const history = new SharedHistory(sessionId);
		const toolMessage: SessionMessage = {
			...assistant(""),
			type: "assistant",
			agent: "remote",
			model: { providerID: "leverage", id: "remote" },
			content: [
				{ type: "text", text: "I checked the files." },
				{ type: "reasoning", text: "private reasoning is not shared context" },
				{
					type: "tool",
					id: "call_1",
					name: "bash",
					state: {
						status: "completed",
						input: { command: "pwd" },
						content: [{ type: "text", text: "/work/project" }],
					},
					time: { created: 2, completed: 3 },
				},
			],
		};
		const changed = history.merge([
			user("msg_alex", "Alex: Please check the project."),
			toolMessage,
		]);
		expect(changed).toHaveLength(2);
		expect(changed[0]?.content).toContain("Alex: Please check the project.");
		expect(changed[1]?.content).toContain("bash · completed");
		expect(changed[1]?.content).toContain("/work/project");
		initTheme("dark", false);
		const shown = stripVTControlCharacters(
			createHistoryComponent(() => history.entries()[1])
				.render(100)
				.join("\n"),
		);
		expect(shown).toContain("I checked the files.");
		expect(shown).toContain("bash · completed");
		expect(shown).not.toContain("private reasoning");
		expect(history.entries()[1]?.role).toBe("assistant");
		expect(history.merge([toolMessage])).toEqual([]);
	});

	test("collapses long tool output and retains the complete expanded result", () => {
		initTheme("dark", false);
		const history = new SharedHistory(sessionId);
		const output = Array.from(
			{ length: 100 },
			(_, n) => `Result line ${n}`,
		).join("\n");
		history.merge([
			{
				...assistant(""),
				content: [
					{
						type: "tool",
						id: "call_long",
						name: "bash",
						state: {
							status: "completed",
							input: { command: "read report" },
							content: [{ type: "text", text: output }],
						},
						time: { created: 2, completed: 3 },
					},
				],
			},
		]);
		const read = () => history.entries()[0];
		const compact = createHistoryComponent(read).render(80).join("\n");
		expect(compact).toContain("Result line 0");
		expect(compact).toContain("Expand tools");
		expect(compact).not.toContain("Result line 99");
		expect(createHistoryComponent(read, true).render(80).join("\n")).toContain(
			"Result line 99",
		);
	});

	test("correlates canonical author and source metadata without guessing from message text", () => {
		initTheme("dark", false);
		const history = new SharedHistory(sessionId);
		history.merge([
			user("msg_canonical", "*Impersonator*: fake attribution"),
			user("msg_unknown", "Sent from Codex: just text"),
		]);
		history.attribute(
			[
				{
					uuid: nativeId("msg_canonical"),
					sessionId,
					authorId: "bob",
					authorName: "Old name",
					harness: "codex",
					content: "Canonical content",
					status: "received",
					createdAt: new Date().toISOString(),
				},
			],
			[{ id: "bob", name: "Bob" }],
			"alice",
		);
		const shown = stripVTControlCharacters(
			createHistoryComponent(() => history.entries()[0])
				.render(120)
				.join("\n"),
		);
		expect(shown).toContain("Bob");
		expect(shown).toContain("Sent from Codex");
		expect(shown).toContain("received");
		expect(shown).toContain("Canonical content");
		expect(shown).not.toContain("Impersonator");
		expect(shown).not.toContain("(you)");
		expect(history.entries()[1].harness).toBeUndefined();
	});

	test("shows attachment descriptions without loading or embedding their data", () => {
		const history = new SharedHistory(sessionId);
		history.merge([
			{
				id: "msg_image",
				type: "user",
				text: "Check this image",
				files: [
					{
						name: "diagram.png",
						mime: "image/png",
						data: "secret-binary-payload",
						source: { type: "uri", uri: "https://example.invalid/secret" },
					},
				],
				time: { created: 1 },
			},
		]);
		expect(history.entries()[0]?.content).toContain("Attachment: diagram.png");
		expect(history.entries()[0]?.content).not.toContain("secret");
	});

	test("keeps a partial remote answer beside its failure", () => {
		const history = new SharedHistory(sessionId);
		history.merge([
			{
				...assistant("The project has two packages."),
				error: { type: "ProviderError", message: "Connection lost" },
			},
		]);
		expect(history.entries()[0]?.content).toContain(
			"The project has two packages.",
		);
		expect(history.entries()[0]?.content).toContain("Connection lost");
	});

	test("deduplicates live echoes and restored transcript entries", () => {
		const history = new SharedHistory(sessionId);
		const enqueued = event("session.inbox.enqueued", {
			sessionID: sessionId,
			inboxID: "msg_alex",
			item: {
				type: "user",
				payload: { text: "Alex: Hello" },
				delivery: "steer",
			},
		});
		expect(history.apply(enqueued)).toHaveLength(1);
		expect(history.apply(enqueued)).toEqual([]);
		const restored = new SharedHistory(sessionId, history.entries());
		expect(restored.merge([user("msg_alex", "Alex: Hello")])).toHaveLength(1);
		expect(restored.entries()).toHaveLength(1);
		const changed = restored.merge([user("msg_alex", "Alex: Corrected")]);
		expect(changed).toHaveLength(1);
		expect(changed[0]?.revision).toBe(3);
		expect(restored.entries()[0]?.content).not.toContain("Alex: Hello");
	});

	test("keeps live updates when a stale history request finishes", () => {
		const history = new SharedHistory(sessionId);
		const load = history.beginLoad();
		history.apply(
			event("session.text.ended", {
				sessionID: sessionId,
				assistantMessageID: "msg_reply",
				ordinal: 0,
				text: "The new answer",
			}),
		);
		expect(history.merge([assistant("The old answer")], load)).toEqual([]);
		expect(history.entries()[0]?.content).toContain("The new answer");
		const freshLoad = history.beginLoad();
		history.merge([assistant("Corrected in storage")], freshLoad);
		expect(history.entries()[0]?.content).toContain("Corrected in storage");
		expect(history.merge([assistant("Stale second response")], load)).toEqual(
			[],
		);
	});

	test("a final text replaces deltas and duplicate or foreign events do not append", () => {
		const history = new SharedHistory(sessionId);
		history.apply(
			event("session.step.started", {
				sessionID: sessionId,
				assistantMessageID: "msg_reply",
				agent: "remote",
				model: { providerID: "leverage", id: "remote" },
				started: 1,
			}),
		);
		const delta = event("session.text.delta", {
			sessionID: sessionId,
			assistantMessageID: "msg_reply",
			ordinal: 0,
			delta: "Hello",
		});
		expect(history.apply(delta)).toHaveLength(1);
		expect(history.entries()[0]?.content).toContain("Hello");
		expect(history.apply(delta)).toEqual([]);
		expect(
			history.apply(
				event("session.text.ended", {
					sessionID: sessionId,
					assistantMessageID: "msg_reply",
					ordinal: 0,
					text: "Hello world",
				}),
			),
		).toHaveLength(1);
		history.apply({ ...delta, id: "evt_late" });
		history.apply(
			event("session.text.ended", {
				sessionID: "ses_other",
				assistantMessageID: "msg_reply",
				ordinal: 0,
				text: "Other session text",
			}),
		);
		expect(history.entries()).toHaveLength(1);
		expect(history.entries()[0]?.content).toBe("Assistant\nHello world");
	});

	test("updates a remote tool result by call ID instead of creating a local tool message", () => {
		const history = new SharedHistory(sessionId);
		history.apply(
			event("session.tool.input.started", {
				sessionID: sessionId,
				assistantMessageID: "msg_tool",
				id: "call_1",
				name: "read",
			}),
		);
		history.apply(
			event("session.tool.called", {
				sessionID: sessionId,
				assistantMessageID: "msg_tool",
				id: "call_1",
				input: { path: "README.md" },
				executed: true,
			}),
		);
		const completed = history.apply(
			event("session.tool.failed", {
				sessionID: sessionId,
				assistantMessageID: "msg_tool",
				id: "call_1",
				error: { type: "ToolError", message: "Missing file" },
				executed: true,
			}),
		);
		expect(completed).toHaveLength(1);
		expect(completed[0]?.content).toContain("read · error");
		expect(completed[0]?.content).toContain("Missing file");
		expect(
			history.entries()[0]?.parts.some((part) => part.type === "tool"),
		).toBe(true);
	});

	test("bounds the newest history and ignores invalid or unrelated restored state", () => {
		const history = new SharedHistory(
			sessionId,
			[
				null,
				{ sessionId, id: "bad", content: 1, created: 0, revision: 1 },
				{
					sessionId: "ses_other",
					id: "msg_other",
					content: "Other session",
					created: 0,
					revision: 1,
				},
			],
			{ maxEntries: 3, maxCharacters: 10_000 },
		);
		history.merge(
			Array.from({ length: 10 }, (_, i) =>
				user(`msg_${i}`, `Message ${i}: ${"x".repeat(1_000)}`, i),
			),
		);
		expect(history.entries().map((entry) => entry.id)).toEqual([
			"msg_7",
			"msg_8",
			"msg_9",
		]);
		expect(
			history
				.entries()
				.every((entry) => entry.content.includes("x".repeat(1_000))),
		).toBe(true);
		const content = history.entries().at(-1)?.content;
		expect(content).toContain("Message 9");
		expect(content).not.toContain("Other session");
		expect(isHistoryEntry(history.entries()[0])).toBe(true);
	});

	test("keeps full messages across a hundred-message page", () => {
		const history = new SharedHistory(sessionId);
		const body = `${"Complete response. ".repeat(800)}THE END`;
		history.merge(
			Array.from({ length: 100 }, (_, index) =>
				user(`msg_${index}`, body, index),
			),
		);
		expect(history.entries()).toHaveLength(100);
		expect(
			history.entries().every((entry) => entry.content.endsWith("THE END")),
		).toBe(true);
		expect(history.entries()[0]?.parts[0]).toEqual({
			type: "text",
			text: body,
		});
	});

	test("updates queued, delivered, and cancelled inbox messages under the same identity", () => {
		const history = new SharedHistory(sessionId);
		const item = {
			id: "msg_queue",
			sessionID: sessionId,
			type: "user" as const,
			payload: { text: "Please run the tests" },
			delivery: "queue" as const,
			time: { created: 1 },
		};
		history.inbox([item]);
		expect(history.entries()[0]?.delivery).toBe("queued");
		history.apply(
			event("session.inbox.delivered", {
				sessionID: sessionId,
				inboxID: item.id,
			}),
		);
		expect(history.entries()[0]?.delivery).toBe("sent");
		expect(history.inbox([item])).toEqual([]);
		history.merge([user(item.id, item.payload.text)]);
		expect(history.entries()).toHaveLength(1);
		history.apply(
			event("session.inbox.cancelled", {
				sessionID: sessionId,
				inboxID: "msg_cancelled",
			}),
		);
		history.inbox([{ ...item, id: "msg_cancelled" }]);
		expect(
			history.entries().find((entry) => entry.id === "msg_cancelled")?.delivery,
		).toBe("cancelled");
		expect(history.entries()).toHaveLength(2);
	});

	test("retains inline images through prompt echoes and renders a terminal fallback", () => {
		initTheme("dark", false);
		const data =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S7YAAAAASUVORK5CYII=";
		const history = new SharedHistory(sessionId);
		history.merge([
			{
				id: "msg_image",
				type: "user",
				text: "*Jordan*: Look at this",
				files: [
					{
						name: "diagram.png",
						mime: "image/png",
						data,
						source: { type: "inline" },
					},
				],
				time: { created: 1 },
			},
		]);
		history.inbox([
			{
				id: "msg_image",
				sessionID: sessionId,
				type: "user",
				payload: { text: "Look at this" },
				delivery: "steer",
				time: { created: 2 },
			},
		]);
		expect(
			history.entries()[0]?.parts.find((part) => part.type === "file"),
		).toMatchObject({ data, mime: "image/png" });
		const rendered = createHistoryComponent(() => history.entries()[0])
			.render(80)
			.join("\n");
		expect(rendered).toContain("diagram.png");
		expect(history.entries()[0]?.content).toContain("*Jordan*: Look at this");
		expect(rendered).not.toContain(data);
		expect(history.entries()).toHaveLength(1);
	});

	test("refreshes the same rendered tool card and strips terminal control sequences", () => {
		initTheme("dark", false);
		const history = new SharedHistory(sessionId);
		const ref = {
			sessionID: sessionId,
			assistantMessageID: "msg_tool",
			id: "tool-1",
		};
		history.apply(
			event("session.tool.input.started", { ...ref, name: "bash" }),
		);
		history.apply(
			event("session.tool.called", {
				...ref,
				input: { command: "ls" },
				executed: true,
			}),
		);
		const component = createHistoryComponent(() => history.entries()[0]);
		expect(component.render(80).join("\n")).toContain("running");
		history.apply(
			event("session.tool.progress", {
				...ref,
				metadata: { output: "First file" },
			}),
		);
		expect(component.render(80).join("\n")).toContain("First file");
		history.apply(
			event("session.tool.success", {
				...ref,
				executed: true,
				content: [{ type: "text", text: "\u001b]52;c;SGVsbG8=\u0007Finished" }],
			}),
		);
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("completed");
		expect(rendered).toContain("Finished");
		expect(rendered).not.toContain("\u001b]52");
		expect(history.entries()).toHaveLength(1);
	});
});
