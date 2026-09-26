import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import {
	OpenCodeEvent,
	type OpenCodeEventEncoded,
} from "@opencode/protocol/groups/event";
import {
	Form,
	Model,
	Permission,
	PromptInput,
	SessionMessage as ProtocolMessage,
	Session,
	SessionInbox,
} from "@opencode/schema";
import Ajv2020 from "ajv/dist/2020.js";
import { Schema } from "effect";

export type LeverageConnection = {
	host: string;
	workspace: string;
	token: string;
	refreshToken?: string;
	sessionId?: string;
	cwd?: string;
	directory?: string;
};
export type SessionInfo = typeof Session.Info.Encoded;
export type SessionMessage = typeof ProtocolMessage.Info.Encoded;
export type SessionEvent = OpenCodeEventEncoded;
export type PromptFile = typeof PromptInput.FileAttachment.Encoded;
export type InboxItem = typeof SessionInbox.Info.Encoded;
export type PromptRequest = Pick<
	typeof PromptInput.Prompt.Encoded,
	"text" | "files"
> & {
	id: InboxItem["id"];
	delivery?: InboxItem["delivery"];
};
export type ModelInfo = typeof Model.Info.Encoded;
export type ModelRef = typeof Model.Ref.Encoded;
export type PermissionRequest = typeof Permission.Request.Encoded;
export type PermissionDecision = typeof Permission.Reply.Encoded;
export type SessionForm = typeof Form.Info.Encoded;
export type FormAnswer = typeof Form.Answer.Encoded;
export type Page<T> = { data: T[]; cursor: { next?: string } };
type Paging = { cursor?: string; limit?: number; signal?: AbortSignal };
type TokenRefresh = {
	controller: AbortController;
	promise: Promise<void>;
	waiters: number;
};

const API_PREFIX = "/api/opencode";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;

export class ApiError extends Error {
	constructor(
		readonly status: number,
		action = "request",
		details?: { request: string; message?: string; correlationId?: string },
	) {
		super(
			`Leverage ${action} failed (${status})${details?.message ? `: ${details.message}` : ""}` +
				(details
					? `\n${details.request}${details.correlationId ? `\nRequest ID: ${details.correlationId}` : ""}`
					: ""),
		);
	}
}
class ProtocolError extends Error {}

async function requestError(
	response: Response,
	method: string,
	url: URL,
	action = "request",
): Promise<ApiError> {
	let message: string | undefined;
	const reader = response.body?.getReader();
	try {
		if (reader && response.headers.get("content-type")?.includes("json")) {
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) {
					const body = record(
						JSON.parse(Buffer.concat(chunks).toString("utf8")),
					);
					const detail =
						body.message ?? record(body.error).message ?? body.error;
					if (typeof detail === "string")
						message = stripVTControlCharacters(detail)
							.replace(/\p{Cc}/gu, " ")
							.replace(/\s+/g, " ")
							.trim()
							.slice(0, 512);
					break;
				}
				size += chunk.value.byteLength;
				if (size > 16 * 1024) break;
				chunks.push(chunk.value);
			}
		}
	} catch {
		// The HTTP status remains useful when the error body cannot be read.
	} finally {
		await reader?.cancel().catch(() => undefined);
		reader?.releaseLock();
	}
	const correlationId = response.headers.get("x-leverage-correlation-id");
	return new ApiError(response.status, action, {
		request: `${method} ${url.origin}${url.pathname}`,
		message,
		...(correlationId && /^[a-zA-Z0-9._:-]{1,128}$/.test(correlationId)
			? { correlationId }
			: {}),
	});
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}
function failure(reason: unknown): Error {
	return reason instanceof Error
		? reason
		: new Error("Leverage request cancelled");
}
function sessionId(id: string): string {
	if (!/^(?:ses_)?[a-zA-Z0-9_-]+$/.test(id))
		throw new Error("Invalid Leverage session ID");
	return id.startsWith("ses_") ? id : `ses_${id}`;
}
function sessionTitle(title: string): string {
	const normalized = title.trim().replace(/\s+/g, " ");
	if (normalized.length < 1 || normalized.length > 80)
		throw new Error("Leverage session titles must contain 1 to 80 characters");
	return normalized;
}
function page<T>(value: unknown, valid: (one: unknown) => boolean): Page<T> {
	const body = record(value);
	const next = record(body.cursor).next;
	if (
		!Array.isArray(body.data) ||
		!body.data.every(valid) ||
		(next !== undefined && typeof next !== "string")
	) {
		throw new ProtocolError("Leverage returned an invalid page");
	}
	return {
		data: body.data as T[],
		cursor: typeof next === "string" ? { next } : {},
	};
}
// JSON Schema validation works across separate Effect module instances.
const validator = new Ajv2020({ strict: false, validateFormats: false });
function encodedValidator<T>(schema: Schema.Constraint) {
	const document = Schema.toJsonSchemaDocument(schema);
	return validator.compile<T>({
		...document.schema,
		$defs: document.definitions,
	});
}
const validSession = encodedValidator<SessionInfo>(Session.Info);
const validMessage = encodedValidator<SessionMessage>(ProtocolMessage.Info);
const validEvent = encodedValidator<SessionEvent>(OpenCodeEvent);
const validModel = encodedValidator<ModelInfo>(Model.Info);
const validModelRef = encodedValidator<ModelRef>(Model.Ref);
const validInbox = encodedValidator<InboxItem>(SessionInbox.Info);
const validPermission = encodedValidator<PermissionRequest>(Permission.Request);
const validDecision = encodedValidator<PermissionDecision>(Permission.Reply);
const validForm = encodedValidator<SessionForm>(Form.Info);
const validAnswer = encodedValidator<FormAnswer>(Form.Answer);
const validPrompt = encodedValidator<typeof PromptInput.Prompt.Encoded>(
	PromptInput.Prompt,
);

function wireId(id: string, prefix: string): string {
	if (
		!id.startsWith(prefix) ||
		id.length === prefix.length ||
		/\p{Cc}/u.test(id)
	)
		throw new Error(`Invalid Leverage ${prefix.slice(0, -1)} ID`);
	return encodeURIComponent(id);
}
function list<T>(body: unknown, valid: (item: unknown) => item is T): T[] {
	const values = record(body).data;
	if (!Array.isArray(values) || !values.every(valid))
		throw new ProtocolError("Leverage returned an invalid list");
	return values;
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const abort = () => {
			clearTimeout(timer);
			reject(failure(signal.reason));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", abort);
			resolve();
		}, milliseconds);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
	});
}

/** Shares one device credential across session reads and remote tools. */
export class SessionClient {
	private readonly origin: string;
	private readonly workspace: string;
	private token: string;
	private readonly refreshToken?: string;
	private refreshing?: TokenRefresh;
	private readonly lifetime = new AbortController();

	constructor(connection: LeverageConnection) {
		const host = new URL(connection.host);
		if (
			!["http:", "https:"].includes(host.protocol) ||
			host.username ||
			host.password ||
			host.search ||
			host.hash ||
			host.pathname !== "/"
		) {
			throw new Error("Leverage host must be an HTTP or HTTPS origin");
		}
		if (!/^[a-zA-Z0-9_-]+$/.test(connection.workspace))
			throw new Error("A Leverage workspace slug is required");
		if (!connection.token || /[\s:]/.test(connection.token))
			throw new Error("A Leverage device token is required");
		this.origin = host.origin;
		this.workspace = connection.workspace;
		this.token = connection.token;
		this.refreshToken = connection.refreshToken;
	}

	url(path: string): URL {
		if (!path.startsWith("/api/")) throw new Error("Invalid Leverage API path");
		return new URL(`${API_PREFIX}${path}`, this.origin);
	}

	async list(
		options: Paging & { search?: string; directory?: string } = {},
	): Promise<Page<SessionInfo>> {
		const query = this.query(options);
		query.set("parentID", "null");
		if (options.search) query.set("search", options.search);
		if (options.directory) query.set("directory", options.directory);
		return page<SessionInfo>(
			await this.json(`/api/session?${query}`, "GET", options.signal),
			validSession,
		);
	}

	async active(
		signal?: AbortSignal,
	): Promise<Record<string, { type: "running" }>> {
		const body = record(await this.json("/api/session/active", "GET", signal));
		const active = record(body.data);
		if (
			!body.data ||
			Object.values(active).some((status) => record(status).type !== "running")
		)
			throw new ProtocolError("Leverage returned invalid session activity");
		return active as Record<string, { type: "running" }>;
	}

	async get(id: string, signal?: AbortSignal): Promise<SessionInfo> {
		const body = record(
			await this.json(`/api/session/${sessionId(id)}`, "GET", signal),
		);
		if (!validSession(body.data))
			throw new ProtocolError("Leverage returned an invalid session");
		return body.data as SessionInfo;
	}

	async create(
		options: { title?: string; directory?: string; signal?: AbortSignal } = {},
	): Promise<SessionInfo> {
		const title = options.title?.trim()
			? sessionTitle(options.title)
			: undefined;
		const id = `ses_${randomUUID()}`;
		const body = record(
			await this.json("/api/session", "POST", options.signal, {
				id,
				location: { directory: options.directory ?? `/${this.workspace}` },
			}),
		);
		if (!validSession(body.data))
			throw new ProtocolError("Leverage returned an invalid session");
		const created = body.data as SessionInfo;
		if (title) {
			try {
				await this.rename(created.id, title, options.signal);
			} catch (error) {
				throw new Error(
					`Created Leverage session ${created.id}, but its title could not be saved. Open that session to continue.`,
					{ cause: error },
				);
			}
			return { ...created, title };
		}
		return created;
	}

	async prompt(
		id: string,
		input: PromptRequest,
		signal?: AbortSignal,
	): Promise<InboxItem> {
		wireId(input.id, "msg_");
		const prompt = {
			text: input.text,
			...(input.files ? { files: input.files } : {}),
		};
		if (!validPrompt(prompt) || (!input.text.trim() && !input.files?.length))
			throw new Error("A Leverage prompt needs text or an attachment");
		if (input.files?.some((file) => !file.uri.startsWith("data:")))
			throw new Error("Leverage attachments must be inline data URLs");
		if (
			input.delivery !== undefined &&
			input.delivery !== "steer" &&
			input.delivery !== "queue"
		)
			throw new Error("Invalid Leverage prompt delivery");
		const body = {
			...prompt,
			id: input.id,
			delivery: input.delivery ?? "steer",
		};
		if (Buffer.byteLength(JSON.stringify(body)) > MAX_RESPONSE_BYTES)
			throw new Error("Leverage prompt exceeds the 16 MiB limit");
		const acknowledged = record(
			await this.json(
				`/api/session/${sessionId(id)}/prompt`,
				"POST",
				signal,
				body,
			),
		).data;
		if (
			!validInbox(acknowledged) ||
			acknowledged.type !== "user" ||
			acknowledged.id !== input.id ||
			acknowledged.sessionID !== sessionId(id)
		)
			throw new ProtocolError(
				"Leverage returned an invalid prompt acknowledgement",
			);
		return acknowledged;
	}

	async interrupt(id: string, signal?: AbortSignal): Promise<void> {
		const body = record(
			await this.json(
				`/api/session/${sessionId(id)}/interrupt`,
				"POST",
				signal,
			),
		);
		if (body.interrupted !== true)
			throw new ProtocolError(
				"Leverage returned an invalid stop acknowledgement",
			);
	}

	async compact(
		id: string,
		messageId: string,
		signal?: AbortSignal,
	): Promise<InboxItem> {
		wireId(messageId, "msg_");
		const data = record(
			await this.json(`/api/session/${sessionId(id)}/compact`, "POST", signal, {
				id: messageId,
			}),
		).data;
		if (
			!validInbox(data) ||
			data.id !== messageId ||
			data.sessionID !== sessionId(id) ||
			data.type !== "compaction"
		)
			throw new ProtocolError(
				"Leverage returned an invalid compaction acknowledgement",
			);
		return data;
	}

	async markRead(id: string, signal?: AbortSignal): Promise<void> {
		await this.json(`/api/session/${sessionId(id)}/view`, "POST", signal);
	}

	async models(signal?: AbortSignal): Promise<ModelInfo[]> {
		return list(await this.json("/api/model", "GET", signal), validModel);
	}

	async selectModel(
		id: string,
		model: ModelRef,
		signal?: AbortSignal,
	): Promise<void> {
		if (!validModelRef(model) || model.providerID !== "leverage")
			throw new Error("Choose a model from the Leverage catalog");
		await this.json(`/api/session/${sessionId(id)}/model`, "POST", signal, {
			model,
		});
	}

	async inbox(id: string, signal?: AbortSignal): Promise<InboxItem[]> {
		return list(
			await this.json(`/api/session/${sessionId(id)}/inbox`, "GET", signal),
			validInbox,
		);
	}

	async cancelInput(
		id: string,
		inputId: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.json(
			`/api/session/${sessionId(id)}/inbox/${wireId(inputId, "msg_")}`,
			"DELETE",
			signal,
		);
	}

	async permissions(
		id: string,
		signal?: AbortSignal,
	): Promise<PermissionRequest[]> {
		return list(
			await this.json(
				`/api/session/${sessionId(id)}/permission`,
				"GET",
				signal,
			),
			validPermission,
		);
	}

	async decidePermission(
		id: string,
		requestId: string,
		decision: PermissionDecision,
		message?: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (!validDecision(decision))
			throw new Error("Invalid Leverage approval decision");
		await this.json(
			`/api/session/${sessionId(id)}/permission/${wireId(requestId, "per_")}/reply`,
			"POST",
			signal,
			{ decision, ...(message ? { message } : {}) },
		);
	}

	async forms(id: string, signal?: AbortSignal): Promise<SessionForm[]> {
		return list(
			await this.json(`/api/session/${sessionId(id)}/form`, "GET", signal),
			validForm,
		);
	}

	async answerForm(
		id: string,
		formId: string,
		answer: FormAnswer,
		signal?: AbortSignal,
	): Promise<void> {
		if (!validAnswer(answer))
			throw new Error("Invalid Leverage question answer");
		await this.json(
			`/api/session/${sessionId(id)}/form/${wireId(formId, "frm_")}/reply`,
			"POST",
			signal,
			{
				answer: Object.fromEntries(
					Object.entries(answer).map(([key, value]) => [
						key,
						typeof value === "number" || typeof value === "boolean"
							? String(value)
							: value,
					]),
				),
			},
		);
	}

	async cancelForm(
		id: string,
		formId: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.json(
			`/api/session/${sessionId(id)}/form/${wireId(formId, "frm_")}`,
			"DELETE",
			signal,
		);
	}

	async rename(id: string, title: string, signal?: AbortSignal): Promise<void> {
		await this.json(`/api/session/${sessionId(id)}`, "PATCH", signal, {
			title: sessionTitle(title),
		});
	}

	async archive(
		id: string,
		directory: string,
		signal?: AbortSignal,
	): Promise<void> {
		if (
			directory !== `/${this.workspace}` &&
			(!directory.startsWith(`/${this.workspace}/`) ||
				directory.split("/").includes(".."))
		)
			throw new Error("Choose a folder in this Leverage workspace");
		await this.json(`/api/session/${sessionId(id)}/move`, "POST", signal, {
			directory,
		});
	}

	async folders(signal?: AbortSignal): Promise<string[]> {
		const projects = await this.json("/api/project", "GET", signal);
		if (!Array.isArray(projects))
			throw new ProtocolError("Leverage returned invalid folders");
		const directories = new Set([`/${this.workspace}`]);
		for (const project of projects) {
			const sandboxes = record(project).sandboxes;
			if (
				!Array.isArray(sandboxes) ||
				sandboxes.some((value) => typeof value !== "string")
			)
				throw new ProtocolError("Leverage returned invalid folders");
			for (const directory of sandboxes as string[]) directories.add(directory);
		}
		return [...directories];
	}

	async history(
		id: string,
		options: Paging & { order?: "asc" | "desc" } = {},
	): Promise<Page<SessionMessage>> {
		const query = this.query(options);
		query.set("order", options.order ?? "asc");
		return page<SessionMessage>(
			await this.json(
				`/api/session/${sessionId(id)}/message?${query}`,
				"GET",
				options.signal,
			),
			validMessage,
		);
	}

	async events(options: {
		signal: AbortSignal;
		onEvent: (event: SessionEvent) => void | Promise<void>;
		onConnection?: (state: "connected" | "reconnecting") => void;
	}): Promise<void> {
		const signal = AbortSignal.any([options.signal, this.lifetime.signal]);
		let delay = 500;
		while (!signal.aborted) {
			try {
				await this.readEvents(signal, async (event) => {
					if (event.type === "server.connected") {
						delay = 500;
						options.onConnection?.("connected");
					}
					await options.onEvent(event);
				});
			} catch (error) {
				if (signal.aborted) return;
				if (
					error instanceof ProtocolError ||
					(error instanceof ApiError &&
						error.status < 500 &&
						error.status !== 429)
				)
					throw error;
			}
			if (signal.aborted) return;
			options.onConnection?.("reconnecting");
			await wait(delay, signal).catch((error: unknown) => {
				if (!signal.aborted) throw error;
			});
			delay = Math.min(delay * 2, 10_000);
		}
	}

	close(): void {
		this.lifetime.abort(new Error("The Leverage connection was closed"));
		this.refreshing?.controller.abort(this.lifetime.signal.reason);
	}

	async json(
		path: string,
		method: string,
		signal?: AbortSignal,
		body?: unknown,
		timeoutMs = 30_000,
	): Promise<unknown> {
		const response = await this.request(
			path,
			method,
			signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs),
			body,
		);
		if (response.status === 204) return undefined;
		const reader = response.body?.getReader();
		if (!reader) throw new ProtocolError("Leverage returned an empty response");
		let size = 0;
		const chunks: Uint8Array[] = [];
		try {
			for (;;) {
				const read = await reader.read();
				if (read.done) break;
				size += read.value.byteLength;
				if (size > MAX_RESPONSE_BYTES)
					throw new ProtocolError("Leverage response exceeds the 16 MiB limit");
				chunks.push(read.value);
			}
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
		try {
			return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
		} catch {
			throw new ProtocolError("Leverage returned invalid JSON");
		}
	}

	private query(options: Paging): URLSearchParams {
		const limit = options.limit ?? 50;
		if (!Number.isInteger(limit) || limit < 1 || limit > 200)
			throw new Error("Leverage page size must be between 1 and 200");
		const query = new URLSearchParams({ limit: String(limit) });
		if (options.cursor) query.set("cursor", options.cursor);
		return query;
	}

	private async request(
		path: string,
		method: string,
		signal: AbortSignal,
		body?: unknown,
	): Promise<Response> {
		const abort = AbortSignal.any([signal, this.lifetime.signal]);
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = this.token;
			const response = await fetch(this.url(path), {
				method,
				signal: abort,
				redirect: "error",
				headers: {
					authorization: `Bearer ${token}`,
					"x-leverage-workspace": this.workspace,
					"content-type": "application/json",
					"x-opencode-ticket": "1",
				},
				...(body !== undefined ? { body: JSON.stringify(body) } : {}),
			});
			if (
				response.status === 401 &&
				attempt === 0 &&
				this.refreshToken &&
				!abort.aborted
			) {
				await response.body?.cancel();
				await this.renewToken(token, abort);
				continue;
			}
			if (!response.ok) {
				throw await requestError(response, method, this.url(path));
			}
			return response;
		}
		throw new Error("Leverage authentication failed");
	}

	private async readEvents(
		signal: AbortSignal,
		emit: (event: SessionEvent) => Promise<void>,
	): Promise<void> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		const reset = () => {
			clearTimeout(timer);
			timer = setTimeout(
				() => controller.abort(new Error("Leverage event stream timed out")),
				45_000,
			);
		};
		reset();
		const combined = AbortSignal.any([signal, controller.signal]);
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const response = await this.request("/api/event", "GET", combined);
			if (
				!response.headers.get("content-type")?.includes("text/event-stream")
			) {
				await response.body?.cancel();
				throw new ProtocolError("Leverage returned an invalid event stream");
			}
			reader = response.body?.getReader();
			if (!reader)
				throw new ProtocolError("Leverage returned an empty event stream");
			const decoder = new TextDecoder();
			let pending = "";
			let data: string[] = [];
			let size = 0;
			for (;;) {
				const read = await reader.read();
				if (read.done) break;
				reset();
				pending += decoder.decode(read.value, { stream: true });
				if (Buffer.byteLength(pending) > MAX_EVENT_BYTES)
					throw new ProtocolError("Leverage event exceeds the 2 MiB limit");
				let newline: number;
				while ((newline = pending.indexOf("\n")) >= 0) {
					const line = pending.slice(0, newline).replace(/\r$/, "");
					pending = pending.slice(newline + 1);
					if (line.startsWith("data:")) {
						const value = line.slice(5).replace(/^ /, "");
						size += Buffer.byteLength(value);
						if (size > MAX_EVENT_BYTES)
							throw new ProtocolError("Leverage event exceeds the 2 MiB limit");
						data.push(value);
					} else if (line === "" && data.length) {
						let event: unknown;
						try {
							event = JSON.parse(data.join("\n"));
						} catch {
							throw new ProtocolError("Leverage returned an invalid event");
						}
						if (!validEvent(event))
							throw new ProtocolError("Leverage returned an invalid event");
						try {
							await emit(event);
						} catch (error) {
							throw new ProtocolError("Leverage event handler failed", {
								cause: error,
							});
						}
						data = [];
						size = 0;
					}
				}
			}
		} finally {
			clearTimeout(timer!);
			await reader?.cancel().catch(() => undefined);
			reader?.releaseLock();
		}
	}

	private async renewToken(
		previous: string,
		signal: AbortSignal,
	): Promise<void> {
		if (this.token !== previous) return;
		if (!this.refreshing) {
			const controller = new AbortController();
			this.refreshing = {
				controller,
				waiters: 0,
				promise: this.exchangeToken(
					AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
				)
					.then((token) => {
						this.token = token;
					})
					.finally(() => {
						if (this.refreshing?.controller === controller)
							this.refreshing = undefined;
					}),
			};
		}
		const pending = this.refreshing;
		pending.waiters++;
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				pending.waiters--;
				if (pending.waiters === 0 && this.refreshing === pending) {
					this.refreshing = undefined;
					pending.controller.abort(error);
				}
				if (error) reject(error);
				else resolve();
			};
			const abort = () => finish(failure(signal.reason));
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) abort();
			void pending.promise.then(
				() => finish(),
				(error: unknown) => finish(failure(error)),
			);
		});
	}

	private async exchangeToken(signal: AbortSignal): Promise<string> {
		const response = await fetch(
			new URL("/api/cli/auth/refresh", this.origin),
			{
				method: "POST",
				signal,
				redirect: "error",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refresh_token: this.refreshToken }),
			},
		);
		if (!response.ok) {
			throw await requestError(
				response,
				"POST",
				new URL("/api/cli/auth/refresh", this.origin),
				"token refresh",
			);
		}
		const body = record(
			await response.json().catch(() => {
				throw new ProtocolError("Leverage returned an invalid token response");
			}),
		);
		if (typeof body.access_token !== "string" || !body.access_token)
			throw new ProtocolError("Leverage returned an invalid access token");
		return body.access_token;
	}
}
