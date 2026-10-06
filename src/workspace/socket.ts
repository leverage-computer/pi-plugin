import { Match } from "effect";
import WebSocket from "ws";
import { api } from "../api";
import { StateError } from "../errors";
import {
  type ClientFrame,
  clientFrameSchema,
  eventSchema,
  type PresenceEntry,
  type SessionViewer,
  type ViewerState,
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
const REQUEST_MS = 30_000;

/** How often the person's presence is reported, and when they count as away. */
export interface PresenceTiming {
  heartbeatMs: number;
  idleMs: number;
}

// The web app's rhythm: a heartbeat a minute, and away after 4.5 quiet minutes.
export const PRESENCE_TIMING: PresenceTiming = {
  heartbeatMs: 60_000,
  idleMs: 4.5 * 60 * 1000,
};

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
  // When the person last did something here, and whether that was long ago.
  private lastActivity = Date.now();
  private idle = false;
  userId?: string;
  /** Who is online in the workspace, from the server's presence frames. */
  readonly presence = new Map<string, PresenceEntry>();
  // Who has each subscribed session open, and who is typing to it. The
  // socket keeps them, so a view that attaches later still sees them.
  readonly viewers = new Map<string, Map<string, SessionViewer>>();
  readonly typing = new Map<string, Set<string>>();

  get connection(): SocketState {
    return this.status;
  }

  constructor(
    private readonly workspaceId: string,
    private readonly timing: PresenceTiming = PRESENCE_TIMING,
  ) {}
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
                  state: this.viewerState,
                });
              }
              clearInterval(this.heartbeat);
              this.heartbeat = setInterval(
                () => this.tick(),
                this.timing.heartbeatMs,
              );
              this.state("live");
              resolve();
              return true;
            }),
            Match.when({ type: "presence.snapshot" }, ({ entries }) => {
              this.presence.clear();
              for (const entry of entries) {
                this.presence.set(entry.userId, entry);
              }
              return true;
            }),
            Match.when({ type: "presence.update" }, (entry) => {
              this.presence.set(entry.userId, entry);
              return true;
            }),
            Match.when(
              { type: "session.presence.snapshot", sessionId: subscribed },
              ({ sessionId, viewers }) => {
                this.viewers.set(
                  sessionId,
                  new Map(viewers.map((one) => [one.userId, one])),
                );
                return true;
              },
            ),
            Match.when(
              { type: "session.presence.update", sessionId: subscribed },
              ({ sessionId, viewer, active, state }) => {
                const viewers = this.viewers.get(sessionId) ?? new Map();
                this.viewers.set(sessionId, viewers);
                if (active) {
                  viewers.set(viewer.userId, { ...viewer, state });
                } else {
                  viewers.delete(viewer.userId);
                  this.typing.get(sessionId)?.delete(viewer.userId);
                }
                return true;
              },
            ),
            Match.when(
              { type: "session.typing.snapshot", sessionId: subscribed },
              ({ sessionId, users }) => {
                this.typing.set(
                  sessionId,
                  new Set(users.map((one) => one.userId)),
                );
                return true;
              },
            ),
            Match.when(
              { type: "session.typing.update", sessionId: subscribed },
              ({ sessionId, userId, active }) => {
                const typing = this.typing.get(sessionId) ?? new Set();
                this.typing.set(sessionId, typing);
                if (active) {
                  typing.add(userId);
                } else {
                  typing.delete(userId);
                }
                return true;
              },
            ),
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
      state: this.viewerState,
    });
  }

  private get viewerState(): ViewerState {
    return this.idle ? "idle" : "active";
  }

  /**
   * The person did something: typed, sent, or answered. Only that keeps them
   * online, so an open but untouched Pi lets them go away like other apps.
   */
  active(): void {
    this.lastActivity = Date.now();
    if (!this.idle) {
      return;
    }
    this.idle = false;
    this.send({ type: "presence.heartbeat" });
    this.watch("active");
  }

  // Reports presence while the person is around. Going quiet tells the server
  // once that they stopped watching, and then nothing until they are back.
  private tick(): void {
    if (Date.now() - this.lastActivity < this.timing.idleMs) {
      this.send({ type: "presence.heartbeat" });
      return;
    }
    if (!this.idle) {
      this.idle = true;
      this.watch("idle");
    }
  }

  private watch(state: ViewerState): void {
    for (const sessionId of this.sessions.keys()) {
      this.send({ type: "session.presence.set", sessionId, state });
    }
  }

  unsubscribe(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.viewers.delete(sessionId);
    this.typing.delete(sessionId);
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
