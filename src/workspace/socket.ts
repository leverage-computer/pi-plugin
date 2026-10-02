import { Match } from "effect";
import WebSocket from "ws";
import { api } from "../api";
import { StateError } from "../errors";
import {
  type ClientFrame,
  clientFrameSchema,
  eventSchema,
  type WorkspaceEvent,
} from "./schema";

export type SocketState =
  | "disconnected"
  | "connecting"
  | "reconnecting"
  | "live";

const RETRY_FLOOR_MS = 500;
const RETRY_CEILING_MS = 10_000;
const HANDSHAKE_MS = 15_000;
const HEARTBEAT_MS = 20_000;
const REQUEST_MS = 30_000;

// Frames arrive as text. Anything that is not a known event is ignored.
function parseFrame(data: unknown): WorkspaceEvent | undefined {
  try {
    const parsed = eventSchema.safeParse(JSON.parse(String(data)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export class WorkspaceSocket {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private readonly lifetime = new AbortController();
  private readonly listeners = new Set<(event: WorkspaceEvent) => void>();
  private readonly states = new Set<(state: SocketState) => void>();
  // Subscribed sessions and the newest cursor seen for each.
  private readonly sessions = new Map<string, number>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private attempt = 0;
  private status: SocketState = "disconnected";
  userId?: string;

  get connection(): SocketState {
    return this.status;
  }

  constructor(private readonly workspaceId: string) {}
  onEvent(listener: (event: WorkspaceEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onState(listener: (state: SocketState) => void): () => void {
    this.states.add(listener);
    return () => this.states.delete(listener);
  }

  private state(value: SocketState): void {
    this.status = value;
    for (const listener of this.states) {
      listener(value);
    }
  }

  connect(): Promise<void> {
    if (this.lifetime.signal.aborted) {
      return Promise.reject(new StateError("Workspace connection closed"));
    }
    if (this.status === "live") {
      return Promise.resolve();
    }
    if (this.connecting) {
      return this.connecting;
    }
    clearTimeout(this.retry);
    this.connecting = this.dial().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private endpoint(): URL {
    const url = new URL("/ws", api.connection.host);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.search = new URLSearchParams({
      workspaceId: this.workspaceId,
      client: "terminal",
    }).toString();
    return url;
  }

  private async dial(): Promise<void> {
    this.state(this.attempt ? "reconnecting" : "connecting");
    const authorization = api.authorization();
    try {
      await new Promise<void>((resolve, reject) => {
        let ready = false;
        const ws = new WebSocket(this.endpoint(), {
          headers: { authorization },
          maxPayload: 2 * 1024 * 1024,
          handshakeTimeout: 10_000,
        });
        this.socket = ws;
        const timer = setTimeout(() => {
          reject(new StateError("Workspace handshake timed out"));
          ws.terminate();
        }, HANDSHAKE_MS);
        const abort = () => {
          reject(new StateError("Workspace connection closed"));
          ws.terminate();
        };
        this.lifetime.signal.addEventListener("abort", abort, { once: true });
        ws.on("message", (data) => {
          const event = parseFrame(data);
          if (!event) {
            return;
          }
          const subscribed = (sessionId: string) =>
            this.sessions.has(sessionId);
          const forward = Match.value(event).pipe(
            Match.when({ type: "connection.ready" }, ({ userId }) => {
              ready = true;
              clearTimeout(timer);
              this.attempt = 0;
              this.userId = userId;
              for (const [sessionId, afterCursor] of this.sessions) {
                this.send({
                  type: "session.subscribe",
                  sessionId,
                  afterCursor,
                });
              }
              clearInterval(this.heartbeat);
              this.heartbeat = setInterval(
                () => this.send({ type: "presence.heartbeat" }),
                HEARTBEAT_MS,
              );
              this.state("live");
              resolve();
              return true;
            }),
            // A replayed session frame is dropped once its cursor was seen.
            Match.when(
              {
                _topic: "session",
                sessionId: subscribed,
                cursor: Match.number,
              },
              ({ sessionId, cursor }) => {
                if (cursor <= this.sessions.get(sessionId)!) {
                  return false;
                }
                this.sessions.set(sessionId, cursor);
                return true;
              },
            ),
            Match.orElse(() => true),
          );
          if (forward) {
            for (const listener of [...this.listeners]) {
              listener(event);
            }
          }
        });
        ws.on("error", () => {
          if (!ready) {
            reject(new StateError("Workspace connection failed"));
          }
        });
        ws.on("close", () => {
          clearTimeout(timer);
          clearInterval(this.heartbeat);
          this.lifetime.signal.removeEventListener("abort", abort);
          if (!ready) {
            reject(
              new StateError("Workspace connection closed during handshake"),
            );
          } else {
            this.reconnect();
          }
        });
      });
    } catch (error) {
      this.socket?.terminate();
      if (!this.lifetime.signal.aborted) {
        try {
          await api.refreshCredential(authorization, this.lifetime.signal);
        } catch {
          /* The next request reports the authentication error. */
        }
        this.reconnect();
      }
      throw error;
    }
  }

  private reconnect(): void {
    if (this.lifetime.signal.aborted) {
      return;
    }
    this.state("reconnecting");
    clearTimeout(this.retry);
    this.retry = setTimeout(
      () => {
        void this.connect().catch(() => {});
      },
      Math.min(RETRY_FLOOR_MS * 2 ** this.attempt++, RETRY_CEILING_MS),
    );
  }

  subscribe(sessionId: string, cursor = 0): void {
    const subscribed = this.sessions.has(sessionId);
    this.sessions.set(
      sessionId,
      Math.max(cursor, this.sessions.get(sessionId) ?? 0),
    );
    if (subscribed) {
      return;
    }
    this.send({
      type: "session.subscribe",
      sessionId,
      afterCursor: this.sessions.get(sessionId),
    });
  }

  unsubscribe(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.send({ type: "session.unsubscribe", sessionId });
  }

  // Only well-formed frames leave, and only while the socket is open.
  private send(frame: ClientFrame): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(clientFrameSchema.parse(frame)));
    }
  }

  /** Sends a frame the server does not acknowledge. */
  async post(frame: ClientFrame): Promise<void> {
    await this.connect();
    if (this.socket?.readyState !== WebSocket.OPEN) {
      throw new StateError("The workspace connection is not open.");
    }
    this.send(frame);
  }

  async request(
    frame: ClientFrame,
    matches: (reply: WorkspaceEvent) => boolean,
    signal: AbortSignal,
  ): Promise<WorkspaceEvent> {
    await this.connect();
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const combined = AbortSignal.any([
        signal,
        this.lifetime.signal,
        AbortSignal.timeout(REQUEST_MS),
      ]);
      const stop = this.onEvent((reply) => {
        if (!matches(reply)) {
          return;
        }
        cleanup();
        if (reply.type === "error") {
          reject(new StateError(reply.message));
        } else {
          resolve(reply);
        }
      });
      const abort = () => {
        cleanup();
        reject(
          new StateError(
            "Send not confirmed. Retry to check the same request.",
          ),
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
      this.send(frame);
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
