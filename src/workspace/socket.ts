import WebSocket from "ws";
import type { SessionClient } from "../api";
import { eventSchema, type WorkspaceEvent } from "./schema";

export class WorkspaceSocket {
	private socket?: WebSocket;
	private connecting?: Promise<void>;
	private readonly lifetime = new AbortController();
	private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
	private readonly states = new Set<(state: string) => void>();
	private readonly sessions = new Map<string, number>();
	private heartbeat?: ReturnType<typeof setInterval>;
	private retry?: ReturnType<typeof setTimeout>;
	private attempt = 0;
	private status = "disconnected";
	userId?: string;
	constructor(
		private readonly api: SessionClient,
		private readonly host: string,
		private readonly workspaceId: string,
	) {}
	onEvent(listener: (event: WorkspaceEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	onState(listener: (state: string) => void): () => void {
		this.states.add(listener);
		return () => this.states.delete(listener);
	}
	private state(value: string): void {
		this.status = value;
		for (const listener of this.states) listener(value);
	}
	connect(): Promise<void> {
		if (this.lifetime.signal.aborted)
			return Promise.reject(new Error("Workspace connection closed"));
		if (this.status === "live") return Promise.resolve();
		if (this.connecting) return this.connecting;
		clearTimeout(this.retry);
		this.connecting = this.dial().finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}
	private async dial(): Promise<void> {
		this.state(this.attempt ? "reconnecting" : "connecting");
		const authorization = this.api.authorization();
		const url = new URL("/ws", this.host);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		url.search = new URLSearchParams({
			workspaceId: this.workspaceId,
			client: "terminal",
		}).toString();
		try {
			await new Promise<void>((resolve, reject) => {
				let ready = false;
				const ws = new WebSocket(url, {
					headers: { authorization },
					maxPayload: 2 * 1024 * 1024,
					handshakeTimeout: 10_000,
				});
				this.socket = ws;
				const timer = setTimeout(() => {
					reject(new Error("Workspace handshake timed out"));
					ws.terminate();
				}, 15_000);
				const abort = () => {
					reject(new Error("Workspace connection closed"));
					ws.terminate();
				};
				this.lifetime.signal.addEventListener("abort", abort, { once: true });
				ws.on("message", (data) => {
					let value: unknown;
					try {
						value = JSON.parse(data.toString());
					} catch {
						return;
					}
					const parsed = eventSchema.safeParse(value);
					if (!parsed.success) return;
					const event = parsed.data;
					if (event.type === "connection.ready") {
						ready = true;
						clearTimeout(timer);
						this.attempt = 0;
						this.userId = event.userId;
						for (const [sessionId, afterCursor] of this.sessions)
							ws.send(
								JSON.stringify({
									type: "session.subscribe",
									sessionId,
									afterCursor,
								}),
							);
						clearInterval(this.heartbeat);
						this.heartbeat = setInterval(
							() => this.sendIfOpen({ type: "presence.heartbeat" }),
							20_000,
						);
						this.state("live");
						resolve();
					}
					if (
						event._topic === "session" &&
						"sessionId" in event &&
						typeof event.cursor === "number" &&
						this.sessions.has(event.sessionId)
					) {
						if (event.cursor <= this.sessions.get(event.sessionId)!) return;
						this.sessions.set(event.sessionId, event.cursor);
					}
					for (const listener of [...this.listeners]) listener(event);
				});
				ws.on("error", () => {
					if (!ready) reject(new Error("Workspace connection failed"));
				});
				ws.on("close", () => {
					clearTimeout(timer);
					clearInterval(this.heartbeat);
					this.lifetime.signal.removeEventListener("abort", abort);
					if (!ready)
						reject(new Error("Workspace connection closed during handshake"));
					else this.reconnect();
				});
			});
		} catch (error) {
			this.socket?.terminate();
			if (!this.lifetime.signal.aborted) {
				try {
					await this.api.refreshCredential(authorization, this.lifetime.signal);
				} catch {
					/* The next request reports the authentication error. */
				}
				this.reconnect();
			}
			throw error;
		}
	}
	private reconnect(): void {
		if (this.lifetime.signal.aborted) return;
		this.state("reconnecting");
		clearTimeout(this.retry);
		this.retry = setTimeout(
			() => {
				void this.connect().catch(() => {});
			},
			Math.min(500 * 2 ** this.attempt++, 10_000),
		);
	}
	subscribe(sessionId: string, cursor = 0): void {
		const subscribed = this.sessions.has(sessionId);
		this.sessions.set(
			sessionId,
			Math.max(cursor, this.sessions.get(sessionId) ?? 0),
		);
		if (subscribed) return;
		this.sendIfOpen({
			type: "session.subscribe",
			sessionId,
			afterCursor: this.sessions.get(sessionId),
		});
	}
	unsubscribe(sessionId: string): void {
		this.sessions.delete(sessionId);
		this.sendIfOpen({ type: "session.unsubscribe", sessionId });
	}
	private sendIfOpen(event: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN)
			this.socket.send(JSON.stringify(event));
	}
	async request(
		event: Record<string, unknown>,
		matches: (reply: WorkspaceEvent) => boolean,
		signal: AbortSignal,
	): Promise<WorkspaceEvent> {
		await this.connect();
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const combined = AbortSignal.any([
				signal,
				this.lifetime.signal,
				AbortSignal.timeout(30_000),
			]);
			const stop = this.onEvent((reply) => {
				if (!matches(reply)) return;
				cleanup();
				if (reply.type === "error") reject(new Error(reply.message));
				else resolve(reply);
			});
			const abort = () => {
				cleanup();
				reject(
					new Error("Send not confirmed. Retry to check the same request."),
				);
			};
			const cleanup = () => {
				stop();
				combined.removeEventListener("abort", abort);
			};
			combined.addEventListener("abort", abort, { once: true });
			if (combined.aborted) {
				abort();
				return;
			}
			this.sendIfOpen(event);
		});
	}
	close(): void {
		this.lifetime.abort();
		clearTimeout(this.retry);
		clearInterval(this.heartbeat);
		this.socket?.close();
		this.state("disconnected");
		this.listeners.clear();
		this.states.clear();
	}
}
