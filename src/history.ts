import {
	getMarkdownTheme,
	keyHint,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	Image,
	Markdown,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import type {
	SessionMessage as ProtocolMessage,
	SessionInbox,
} from "@opencode/schema";
import type { SessionEvent, SessionMessage } from "./api";
import { clean } from "./drawers";
import { nativeId } from "./workspace/api";
import type { SessionInput, WorkspaceMember } from "./workspace/schema";

export const HISTORY_ENTRY = "leverage-history";

export interface HistoryFile {
	type: "file";
	name: string;
	mime: string;
	data?: string;
	uri?: string;
}
interface TextPart {
	type: "text" | "reasoning";
	text: string;
}
interface ToolPart {
	type: "tool";
	id: string;
	name: string;
	status: string;
	input: string;
	output: string;
	files: HistoryFile[];
}
export type HistoryPart = TextPart | ToolPart | HistoryFile;
type Delivery = "queued" | "sent" | "cancelled";
export interface HistoryEntry {
	author?: string;
	harness?: string | null;
	status?: string;
	sessionId: string;
	id: string;
	role: "user" | "assistant" | "system";
	parts: HistoryPart[];
	delivery?: Delivery;
	content: string;
	created: number;
	revision: number;
}
interface RecordState {
	id: string;
	created: number;
	role: HistoryEntry["role"];
	parts: Map<string, HistoryPart>;
	completed: Set<string>;
	delivery?: Delivery;
	changed: number;
}
interface HistoryLimits {
	maxEntries?: number;
	maxCharacters?: number;
}
const PROJECTED_EVENTS = [
	"session.inbox.enqueued",
	"session.inbox.delivered",
	"session.inbox.cancelled",
	"session.step.started",
	"session.step.failed",
	"session.step.ended",
	"session.text.started",
	"session.text.delta",
	"session.text.ended",
	"session.reasoning.started",
	"session.reasoning.delta",
	"session.reasoning.ended",
	"session.tool.input.started",
	"session.tool.input.delta",
	"session.tool.input.ended",
	"session.tool.called",
	"session.tool.progress",
	"session.tool.success",
	"session.tool.failed",
] as const;
function isProjectedEvent(
	event: SessionEvent,
): event is Extract<SessionEvent, { type: (typeof PROJECTED_EVENTS)[number] }> {
	return PROJECTED_EVENTS.some((type) => type === event.type);
}
function filePart(
	file: NonNullable<(typeof ProtocolMessage.User.Encoded)["files"]>[number],
): HistoryFile {
	return {
		type: "file",
		name: file.name ?? "Attachment",
		mime: file.mime,
		...(file.source.type === "inline"
			? { data: file.data }
			: { uri: file.source.uri }),
	};
}
function toolContent(
	content:
		| (typeof ProtocolMessage.ToolStateCompleted.Encoded)["content"]
		| undefined,
): { output: string; files: HistoryFile[] } {
	return {
		output: (content ?? [])
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n"),
		files: (content ?? []).flatMap((part) =>
			part.type === "file"
				? [
						{
							type: "file" as const,
							name: part.name ?? "File",
							mime: part.mime,
							uri: part.uri,
						},
					]
				: [],
		),
	};
}
function stateOf(message: SessionMessage): RecordState {
	const state: RecordState = {
		id: message.id,
		created: message.time.created,
		role: "system",
		parts: new Map(),
		completed: new Set(),
		changed: 0,
	};
	const text = (value: string) =>
		state.parts.set("text:0", { type: "text", text: value });
	switch (message.type) {
		case "user":
			state.role = "user";
			state.delivery = "sent";
			text(message.text);
			for (const [index, file] of (message.files ?? []).entries())
				state.parts.set(`file:${index}`, filePart(file));
			break;
		case "assistant":
			state.role = "assistant";
			for (const [index, part] of message.content.entries()) {
				if (part.type === "text" || part.type === "reasoning") {
					const key = `${part.type}:${index}`;
					state.parts.set(key, { type: part.type, text: part.text });
					if (message.time.completed !== undefined) state.completed.add(key);
				} else {
					const result = toolContent(
						part.state.status === "completed" || part.state.status === "error"
							? part.state.content
							: undefined,
					);
					state.parts.set(`tool:${part.id}`, {
						type: "tool",
						id: part.id,
						name: part.name,
						status: part.state.status,
						input:
							typeof part.state.input === "string"
								? part.state.input
								: JSON.stringify(part.state.input, null, 2),
						output:
							part.state.status === "error"
								? [part.state.error.message, result.output]
										.filter(Boolean)
										.join("\n")
								: result.output,
						files: result.files,
					});
				}
			}
			if (message.error)
				state.parts.set("error", {
					type: "text",
					text: `Error: ${message.error.message}`,
				});
			break;
		case "system":
		case "synthetic":
			text(message.text);
			break;
		case "skill":
			text(`Skill: ${message.name}\n${message.text}`);
			break;
		case "shell":
			text(
				`Shell: ${message.status}\n${message.command}\n${message.output?.output ?? ""}`,
			);
			break;
		case "compaction":
			text(
				message.status === "failed"
					? `Compaction failed: ${message.error.message}`
					: `Compaction: ${message.status}\n${message.summary}`,
			);
			break;
		case "idle":
			if (message.outcome !== "succeeded") text(`Turn ${message.outcome}`);
			break;
		case "agent-switched":
			text(`Agent: ${message.agent}`);
			break;
		case "model-switched":
			text(`Model: ${message.model.id}`);
			break;
		case "location-switched":
			text(`Folder: ${message.location.directory}`);
			break;
	}
	return state;
}
function partText(part: HistoryPart): string {
	switch (part.type) {
		case "text":
			return part.text;
		case "reasoning":
			return `Thinking\n${part.text}`;
		case "file":
			return `[Attachment: ${part.name} (${part.mime})]`;
		case "tool":
			return [
				`${part.name} · ${part.status}`,
				part.input,
				part.output,
				...part.files.map(partText),
			]
				.filter(Boolean)
				.join("\n");
	}
}
// Server delivery states, in the words a person expects.
const DELIVERY: Record<string, [string, ThemeColor]> = {
	queued: ["Queued", "warning"],
	releasing: ["Sending…", "muted"],
	sending: ["Sending…", "muted"],
	received: ["Delivered", "muted"],
	rejected: ["Not delivered", "error"],
	withdrawn: ["Withdrawn", "muted"],
	cancelled: ["Cancelled", "muted"],
	unknown: ["Delivery unknown", "warning"],
};
const SUMMARY_KEYS = [
	"command",
	"file_path",
	"path",
	"pattern",
	"query",
	"url",
	"name",
	"description",
];
// The argument that says what a tool call does, such as a path or command.
function toolSummary(input: string): string {
	try {
		const value = JSON.parse(input) as Record<string, unknown>;
		const found = SUMMARY_KEYS.map((key) => value[key]).find(
			(one) => typeof one === "string" && one.trim(),
		);
		return typeof found === "string" ? found.trim().split("\n")[0] : "";
	} catch {
		return "";
	}
}
// Leverage tools report failures as JSON with an error field.
function toolError(output: string): string {
	try {
		const value = JSON.parse(output) as { error?: unknown };
		return typeof value.error === "string" ? value.error : output;
	} catch {
		return output;
	}
}

export function createHistoryComponent(
	read: () => HistoryEntry | undefined,
	expanded: boolean,
	theme: Theme,
): Component {
	let previous: HistoryEntry | undefined;
	let rendered: Container | undefined;
	const files = (
		parent: { addChild(component: Component): void },
		attachments: HistoryFile[],
	) => {
		for (const file of attachments) {
			parent.addChild(
				new Text(
					theme.fg("muted", clean(`▸ ${file.name} · ${file.mime}`)),
					0,
					0,
				),
			);
			if (
				file.data &&
				/^image\/(png|jpeg|gif|webp)$/.test(file.mime) &&
				/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
			)
				parent.addChild(
					new Image(
						file.data,
						file.mime,
						{ fallbackColor: (text) => text },
						{
							filename: clean(file.name),
							maxWidthCells: 70,
							maxHeightCells: 25,
						},
					),
				);
		}
	};
	// Pi previews ten lines of tool output until tools are expanded.
	const preview = (value: string, color: ThemeColor): Component => {
		const body = new Text(theme.fg(color, clean(value)), 0, 0);
		return {
			invalidate: () => body.invalidate(),
			render(width) {
				const lines = body.render(width);
				return expanded || lines.length <= 10
					? lines
					: [
							...lines.slice(0, 10),
							...new Text(
								`${theme.fg("muted", `... (${lines.length - 10} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
								0,
								0,
							).render(width),
						];
			},
		};
	};
	const tool = (part: ToolPart): Component => {
		const failed = part.status === "error";
		const done = part.status === "completed";
		const card = new Box(1, 1, (text) =>
			theme.bg(
				failed ? "toolErrorBg" : done ? "toolSuccessBg" : "toolPendingBg",
				text,
			),
		);
		const summary = clean(toolSummary(part.input));
		// Pi titles a shell call as its command and other calls as name and target.
		card.addChild(
			new Text(
				part.name === "bash" && summary
					? theme.fg("toolTitle", theme.bold(`$ ${summary}`))
					: `${theme.fg("toolTitle", theme.bold(clean(part.name)))}${summary ? ` ${theme.fg("accent", summary)}` : ""}`,
				0,
				0,
			),
		);
		if (expanded && part.input)
			card.addChild(new Text(theme.fg("muted", clean(part.input)), 0, 0));
		const output = failed ? toolError(part.output) : part.output;
		if (output) card.addChild(preview(output, failed ? "error" : "toolOutput"));
		files(card, part.files);
		return card;
	};
	// People get Pi's own message card, with a name line for shared sessions.
	const person = (entry: HistoryEntry): Component => {
		const card = new Box(1, 1, (text) => theme.bg("userMessageBg", text));
		const author = clean(entry.author ?? "User");
		const own = author.endsWith(" (you)");
		const [state, tone] = DELIVERY[entry.status ?? entry.delivery ?? ""] ?? [];
		card.addChild(
			new Text(
				[
					theme.bold(
						theme.fg("userMessageText", author.replace(/ \(you\)$/, "")),
					),
					own ? theme.fg("muted", " (you)") : "",
					entry.created
						? theme.fg(
								"muted",
								`  ${new Date(entry.created).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
							)
						: "",
					entry.harness === "codex" || entry.harness === "claude"
						? theme.fg(
								"muted",
								` · Sent from ${entry.harness === "codex" ? "Codex" : "Claude"}`,
							)
						: "",
					state && tone ? theme.fg(tone, ` · ${state}`) : "",
				].join(""),
				0,
				0,
			),
		);
		for (const part of entry.parts)
			if (part.type === "file") files(card, [part]);
			else if (part.type === "text")
				card.addChild(
					new Markdown(clean(part.text), 0, 0, getMarkdownTheme(), {
						color: (text) => theme.fg("userMessageText", text),
					}),
				);
		return card;
	};
	return {
		invalidate() {
			rendered?.invalidate();
		},
		render(width) {
			const entry = read();
			if (!entry) return [];
			if (entry !== previous || !rendered) {
				previous = entry;
				rendered = new Container();
				rendered.addChild(new Spacer(1));
				if (entry.role === "user") rendered.addChild(person(entry));
				else
					for (const [index, part] of entry.parts.entries()) {
						if (index) rendered.addChild(new Spacer(1));
						if (part.type === "text")
							rendered.addChild(
								entry.role === "system"
									? new Text(
											theme.italic(theme.fg("dim", clean(part.text))),
											1,
											0,
										)
									: new Markdown(clean(part.text), 1, 0, getMarkdownTheme()),
							);
						else if (part.type === "reasoning")
							rendered.addChild(
								expanded
									? new Markdown(clean(part.text), 1, 0, getMarkdownTheme(), {
											color: (text) => theme.fg("thinkingText", text),
											italic: true,
										})
									: new Text(
											theme.italic(theme.fg("thinkingText", "Thinking...")),
											1,
											0,
										),
							);
						else if (part.type === "file") files(rendered, [part]);
						else if (part.type === "tool") rendered.addChild(tool(part));
					}
			}
			return rendered.render(width);
		},
	};
}

export class SharedHistory {
	private readonly authors = new Map<string, SessionInput>();
	private members: readonly WorkspaceMember[] = [];
	private viewerId?: string;
	private readonly records = new Map<string, RecordState>();
	private readonly displayed = new Map<string, HistoryEntry>();
	private readonly eventIds = new Set<string>();
	private readonly delivery = new Map<string, Delivery>();
	private readonly maxEntries: number;
	private readonly maxCharacters: number;
	private clock = 0;
	private latestLoad = 0;
	constructor(
		readonly sessionId: string,
		limits: HistoryLimits = {},
	) {
		this.maxEntries = limits.maxEntries ?? 200;
		this.maxCharacters = limits.maxCharacters ?? 32 * 1024 * 1024;
	}
	beginLoad(): number {
		this.latestLoad = ++this.clock;
		return this.latestLoad;
	}
	attribute(
		inputs: Iterable<SessionInput>,
		members: readonly WorkspaceMember[],
		viewerId?: string,
	): HistoryEntry[] {
		this.members = members;
		this.viewerId = viewerId;
		for (const input of inputs) this.authors.set(input.uuid, input);
		while (this.authors.size > 1000)
			this.authors.delete(this.authors.keys().next().value!);
		return [...this.records.values()].flatMap((record) =>
			record.role === "user" ? this.publish(record) : [],
		);
	}
	merge(
		messages: readonly SessionMessage[],
		load = this.latestLoad,
	): HistoryEntry[] {
		if (load < this.latestLoad) return [];
		const changes: HistoryEntry[] = [];
		for (const message of messages) {
			const existing = this.records.get(message.id);
			// Events received during the request own the newer value.
			if (existing && existing.changed > load) continue;
			const state = stateOf(message);
			state.changed = load;
			if (state.delivery) {
				if (this.delivery.get(state.id) === "cancelled")
					state.delivery = "cancelled";
				this.delivery.set(state.id, state.delivery);
			}
			this.records.set(message.id, state);
			changes.push(...this.publish(state));
		}
		this.trim();
		return changes.filter((entry) => this.displayed.has(entry.id));
	}
	inbox(items: readonly (typeof SessionInbox.Info.Encoded)[]): HistoryEntry[] {
		const changes: HistoryEntry[] = [];
		for (const item of items) {
			if (
				item.sessionID !== this.sessionId ||
				(item.type !== "user" && item.type !== "synthetic")
			)
				continue;
			const state = stateOf({
				id: item.id,
				type: item.type,
				text: item.payload.text,
				...(item.type === "user" ? { files: item.payload.files } : {}),
				time: item.time,
			});
			const existing = this.records.get(item.id);
			if (existing) {
				state.created = existing.created;
				for (const [key, part] of existing.parts)
					if (
						(part.type === "file" && !state.parts.has(key)) ||
						(part.type === "text" && existing.delivery === "sent")
					)
						state.parts.set(key, part);
			}
			state.delivery = this.delivery.get(item.id) ?? "queued";
			state.changed = ++this.clock;
			this.records.set(item.id, state);
			changes.push(...this.publish(state));
		}
		this.trim();
		return changes.filter((entry) => this.displayed.has(entry.id));
	}
	apply(event: SessionEvent): HistoryEntry[] {
		if (
			!isProjectedEvent(event) ||
			event.data.sessionID !== this.sessionId ||
			this.eventIds.has(event.id)
		)
			return [];
		this.eventIds.add(event.id);
		if (this.eventIds.size > 2_000)
			this.eventIds.delete(this.eventIds.values().next().value!);
		const changed = ++this.clock;
		const at = "created" in event ? event.created : 0;
		const assistant = (id: string) => {
			let state = this.records.get(id);
			if (!state) {
				state = {
					id,
					created: at,
					role: "assistant",
					parts: new Map(),
					completed: new Set(),
					changed,
				};
				this.records.set(id, state);
			}
			state.changed = changed;
			return state;
		};
		const tool = (messageId: string, id: string) => {
			const state = assistant(messageId);
			const key = `tool:${id}`;
			let part = state.parts.get(key);
			if (part?.type !== "tool") {
				part = {
					type: "tool",
					id,
					name: "Tool",
					status: "streaming",
					input: "",
					output: "",
					files: [],
				};
				state.parts.set(key, part);
			}
			return { state, part };
		};
		let state: RecordState;
		switch (event.type) {
			case "session.inbox.enqueued":
				return this.inbox([
					{
						id: event.data.inboxID,
						sessionID: this.sessionId,
						...event.data.item,
						time: { created: at },
					},
				]);
			case "session.inbox.delivered":
			case "session.inbox.cancelled": {
				const id = event.data.inboxID;
				const delivery =
					event.type === "session.inbox.cancelled" ? "cancelled" : "sent";
				this.delivery.set(id, delivery);
				const existing = this.records.get(id);
				if (!existing) return [];
				state = existing;
				state.delivery = delivery;
				state.changed = changed;
				break;
			}
			case "session.step.started":
				state = assistant(event.data.assistantMessageID);
				state.created = event.data.started;
				this.trim();
				return [];
			case "session.step.ended":
				state = assistant(event.data.assistantMessageID);
				for (const key of state.parts.keys())
					if (!key.startsWith("tool:")) state.completed.add(key);
				break;
			case "session.text.started":
			case "session.reasoning.started": {
				state = assistant(event.data.assistantMessageID);
				const type =
					event.type === "session.text.started" ? "text" : "reasoning";
				const key = `${type}:${event.data.ordinal}`;
				if (!state.parts.has(key)) state.parts.set(key, { type, text: "" });
				break;
			}
			case "session.text.delta":
			case "session.reasoning.delta": {
				state = assistant(event.data.assistantMessageID);
				const type = event.type === "session.text.delta" ? "text" : "reasoning";
				const key = `${type}:${event.data.ordinal}`;
				const previous = state.parts.get(key);
				if (!state.completed.has(key))
					state.parts.set(key, {
						type,
						text:
							(previous &&
							(previous.type === "text" || previous.type === "reasoning")
								? previous.text
								: "") + event.data.delta,
					});
				break;
			}
			case "session.text.ended":
			case "session.reasoning.ended": {
				state = assistant(event.data.assistantMessageID);
				const type = event.type === "session.text.ended" ? "text" : "reasoning";
				const key = `${type}:${event.data.ordinal}`;
				state.parts.set(key, { type, text: event.data.text });
				state.completed.add(key);
				break;
			}
			case "session.tool.input.started": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				value.part.name = event.data.name;
				break;
			}
			case "session.tool.input.delta": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				if (value.part.status === "streaming")
					value.part.input += event.data.delta;
				break;
			}
			case "session.tool.input.ended": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				if (value.part.status === "streaming")
					value.part.input = event.data.text;
				break;
			}
			case "session.tool.called": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				if (value.part.status === "streaming") {
					value.part.input = JSON.stringify(event.data.input, null, 2);
					value.part.status = "running";
				}
				break;
			}
			case "session.tool.progress": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				if (value.part.status === "running") {
					const output =
						event.data.metadata.output ?? event.data.metadata.progress;
					if (typeof output === "string") value.part.output = output;
				}
				break;
			}
			case "session.tool.success":
			case "session.tool.failed": {
				const value = tool(event.data.assistantMessageID, event.data.id);
				state = value.state;
				const result = toolContent(event.data.content);
				value.part.status =
					event.type === "session.tool.success" ? "completed" : "error";
				value.part.output =
					event.type === "session.tool.failed"
						? [event.data.error.message, result.output]
								.filter(Boolean)
								.join("\n")
						: result.output;
				value.part.files = result.files;
				break;
			}
			case "session.step.failed":
				state = assistant(event.data.assistantMessageID);
				state.parts.set("error", {
					type: "text",
					text: `Error: ${event.data.error.message}`,
				});
				break;
		}
		const result = this.publish(state);
		this.trim();
		return result.filter((entry) => this.displayed.has(entry.id));
	}
	entries(): HistoryEntry[] {
		return [...this.displayed.values()].sort((a, b) => a.created - b.created);
	}
	entry(id: string): HistoryEntry | undefined {
		return this.displayed.get(id);
	}
	private publish(state: RecordState): HistoryEntry[] {
		const input =
			state.role === "user" ? this.authors.get(nativeId(state.id)) : undefined;
		const author = input
			? (this.members.find((one) => one.id === input.authorId)?.name ??
				input.authorName ??
				(input.authorId === null ? "Leverage" : "Unknown member"))
			: undefined;
		const authorLabel = author
			? `${author}${input?.authorId === this.viewerId ? " (you)" : ""}`
			: undefined;
		const parts = [...state.parts.values()].map((part) =>
			part.type === "tool" ? { ...part, files: [...part.files] } : { ...part },
		);
		if (input) {
			const texts = parts.filter((part) => part.type === "text");
			if (texts.length === 1 && texts[0].type === "text")
				texts[0].text = input.content;
		}
		const body = parts.map(partText).filter(Boolean).join("\n\n");
		if (!body) return [];
		const label =
			state.role === "user"
				? (authorLabel ?? "User")
				: state.role === "assistant"
					? "Assistant"
					: "Session";
		const content = `${label}${state.delivery && state.delivery !== "sent" ? ` · ${state.delivery}` : ""}\n${body}`;
		const prior = this.displayed.get(state.id);
		if (
			prior?.content === content &&
			JSON.stringify(prior.parts) === JSON.stringify(parts) &&
			prior.harness === input?.harness &&
			prior.status === input?.status
		)
			return [];
		const entry: HistoryEntry = {
			sessionId: this.sessionId,
			id: state.id,
			role: state.role,
			author: authorLabel,
			harness: input?.harness,
			status: input?.status,
			parts,
			delivery: state.delivery,
			created: state.created,
			content,
			revision: (prior?.revision ?? 0) + 1,
		};
		this.displayed.set(state.id, entry);
		return [entry];
	}
	private trim(): void {
		let characters = 0;
		let kept = 0;
		for (const entry of this.entries().reverse()) {
			const size =
				entry.content.length +
				entry.parts.reduce(
					(sum, part) =>
						sum +
						(part.type === "file"
							? (part.data?.length ?? 0)
							: part.type === "tool"
								? part.files.reduce(
										(total, file) => total + (file.data?.length ?? 0),
										0,
									)
								: 0),
					0,
				);
			characters += size;
			kept += 1;
			if (kept > this.maxEntries || characters > this.maxCharacters) {
				this.displayed.delete(entry.id);
				this.records.delete(entry.id);
			}
		}
		if (this.records.size > this.maxEntries * 2)
			for (const [id] of this.records) {
				if (this.records.size <= this.maxEntries * 2) break;
				if (!this.displayed.has(id)) this.records.delete(id);
			}
		if (this.delivery.size > 2_000)
			for (const [id] of this.delivery) {
				if (this.delivery.size <= 2_000) break;
				this.delivery.delete(id);
			}
	}
}
