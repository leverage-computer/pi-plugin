import { Match } from "effect";
import { z } from "zod";
import { type HistoryEntry, SharedHistory } from "../history";
import { workspace } from "./api";
import type {
  Invocation,
  SessionInput,
  TranscriptEvent,
  WorkspaceEvent,
  WorkspaceMember,
  WorkspaceSession,
} from "./schema";
import type { SocketState, WorkspaceSocket } from "./socket";

const POLL_MS = 30_000;

// A 403 or 404 on the session means access is gone rather than the server.
const accessLost = z.object({
  status: z.union([z.literal(403), z.literal(404)]),
});

// Statuses in which the agent is busy with a turn.
const RUNNING = new Set(["active", "preparing", "stopping"]);

export interface SharedSessionHooks {
  // The session changed. `entries` are the conversation cards that changed.
  changed(entries: HistoryEntry[]): void;
  failed(error: unknown): void;
  // Leverage removed this person's access to the session.
  denied(): void;
}

/**
 * One shared Leverage session as this client knows it: its state, its
 * conversation, and what waits for a person. The workspace socket keeps it
 * live, and a fresh read repairs anything a dropped connection missed.
 */
export class SharedSession {
  session?: WorkspaceSession;
  canWrite = false;
  revoked = false;
  version = -1;
  members: WorkspaceMember[] = [];
  readonly history: SharedHistory;
  private readonly inputs = new Map<string, SessionInput>();
  private readonly approvals = new Map<string, Invocation>();
  // Counts live approval frames, so a read that overlaps one keeps them.
  private approvalFrames = 0;
  private readonly asks = new Map<string, TranscriptEvent>();
  private socket?: WorkspaceSocket;
  private readonly lifetime = new AbortController();
  private disposals: Array<() => void> = [];
  private refreshing?: Promise<void>;
  private refreshAgain = false;

  constructor(
    readonly id: string,
    private readonly hooks: SharedSessionHooks,
  ) {
    this.history = new SharedHistory(id);
  }

  get userId(): string | undefined {
    return this.socket?.userId;
  }

  get closed(): boolean {
    return this.lifetime.signal.aborted;
  }

  get running(): boolean {
    return RUNNING.has(this.session?.status ?? "idle");
  }

  /** The live connection's state, as the footer names it. */
  get connection(): SocketState {
    return this.socket?.connection ?? "connecting";
  }

  /** A person's message as this client last saw it. */
  input(uuid: string): SessionInput | undefined {
    return this.inputs.get(uuid);
  }

  /** Tool calls waiting for someone to approve or deny them. */
  pendingApprovals(): Invocation[] {
    return [...this.approvals.values()];
  }

  /** Questions the agent asked that nobody has answered yet. */
  pendingQuestions(): TranscriptEvent[] {
    return [...this.asks.values()];
  }

  /** Messages waiting for their own turn, in queue order. */
  queued(): SessionInput[] {
    return [...this.inputs.values()]
      .filter((input) => input.status === "queued")
      .sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  }

  async start(signal: AbortSignal): Promise<void> {
    signal.addEventListener("abort", () => this.close(), { once: true });
    if (signal.aborted) {
      this.close();
      return;
    }
    this.socket = await workspace.socket(this.lifetime.signal);
    // A reconnect reads again. A read already running reports its own failure.
    const repair = () => {
      if (!this.refreshing) {
        void this.refresh().catch(this.hooks.failed);
      }
    };
    const poll = setInterval(repair, POLL_MS);
    this.disposals.push(
      () => clearInterval(poll),
      this.socket.onEvent((event) => this.apply(event)),
      this.socket.onState((state) => {
        if (state === "live") {
          repair();
        }
        this.hooks.changed([]);
      }),
    );
    await Promise.all([this.socket.connect(), this.refresh()]);
  }

  /** Reads the session again. Calls during a read share it and read once more after. */
  refresh(): Promise<void> {
    if (this.closed || this.revoked) {
      return Promise.resolve();
    }
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        try {
          await this.read();
        } catch (error) {
          if (this.closed) {
            return;
          }
          if (accessLost.safeParse(error).success) {
            this.revoke();
            return;
          }
          throw error;
        }
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** Records a message this client sent, before the socket echoes it. */
  remember(input: SessionInput): void {
    this.inputs.set(input.uuid, input);
    this.hooks.changed(this.history.messages([input]));
  }

  apply(event: WorkspaceEvent): void {
    if (this.revoked || this.closed) {
      return;
    }
    const mine = (sessionId: string) => sessionId === this.id;
    const changes = Match.value(event).pipe(
      Match.when({ type: "session.event", sessionId: mine }, ({ event }) =>
        this.transcript([event]),
      ),
      Match.when(
        { type: "session.event.delta", sessionId: mine },
        ({ delta }) => this.history.delta(delta),
      ),
      Match.when(
        {
          type: "session.updated",
          sessionId: mine,
          version: (version: number) => version >= this.version,
        },
        (update) => {
          this.version = update.version;
          if (this.session) {
            this.session = {
              ...this.session,
              ...(update.title !== undefined ? { title: update.title } : {}),
              status: update.status,
              awaitingReason: update.awaitingReason,
              model: update.model,
              reasoningEffort: update.reasoningEffort,
              queuedCount: update.queuedCount,
              turnId: update.turnId,
              archivedAt: update.archivedAt,
            };
          }
          return [];
        },
      ),
      // A message update older than one already applied is stale.
      Match.when(
        {
          type: "session.messages.updated",
          sessionId: mine,
          version: (version: number) => version >= this.version,
        },
        ({ messages, version }) => {
          this.version = version;
          return this.messages(messages);
        },
      ),
      Match.when(
        { type: "session.approval.pending", sessionId: mine },
        ({ invocation }) => {
          this.approvalFrames++;
          this.approvals.set(invocation.id, invocation);
          return [];
        },
      ),
      Match.when(
        { type: "session.approval.updated", sessionId: mine },
        ({ invocation }) => {
          this.approvalFrames++;
          if (invocation.state === "pending_approval") {
            this.approvals.set(invocation.id, invocation);
          } else {
            this.approvals.delete(invocation.id);
          }
          return [];
        },
      ),
      Match.when({ type: "session.access_revoked", sessionId: mine }, () => {
        this.revoke();
        return [];
      }),
      Match.when({ type: "session.list.changed", sessionId: mine }, () => {
        void this.refresh().catch(this.hooks.failed);
        return [];
      }),
      Match.orElse(() => undefined),
    );
    if (changes) {
      this.hooks.changed(changes);
    }
  }

  close(): void {
    this.lifetime.abort();
    for (const dispose of this.disposals.splice(0)) {
      dispose();
    }
    this.socket?.unsubscribe(this.id);
  }

  private async read(): Promise<void> {
    const approvalFrames = this.approvalFrames;
    const [snapshot, members] = await Promise.all([
      workspace.bootstrap(this.id, this.lifetime.signal),
      workspace.members(this.lifetime.signal),
    ]);
    if (this.closed || this.revoked) {
      return;
    }
    this.canWrite = snapshot.viewerCanWrite;
    this.members = members;
    // A read that started before a newer live update must not undo it.
    const current = snapshot.version >= this.version;
    if (current) {
      this.session = snapshot.session;
      this.version = snapshot.version;
    }
    // Approvals carry no version. A live frame during the read is newer.
    if (approvalFrames === this.approvalFrames) {
      this.approvals.clear();
      for (const invocation of snapshot.toolApprovals) {
        if (invocation.state === "pending_approval") {
          this.approvals.set(invocation.id, invocation);
        }
      }
    }
    const changes = [
      ...this.history.attribute(members, this.userId),
      ...(current ? this.messages(snapshot.messages) : []),
      ...this.transcript(snapshot.events),
    ];
    this.socket?.subscribe(this.id, snapshot.lastCursorIncluded);
    this.hooks.changed(changes);
  }

  private messages(inputs: readonly SessionInput[]): HistoryEntry[] {
    for (const input of inputs) {
      this.inputs.set(input.uuid, input);
    }
    while (this.inputs.size > 1000) {
      this.inputs.delete(this.inputs.keys().next().value!);
    }
    return this.history.messages(inputs);
  }

  // Questions stay open until the agent records the tool result that answers them.
  private transcript(events: readonly TranscriptEvent[]): HistoryEntry[] {
    for (const event of events) {
      const toolUseId = event.data.toolUseId;
      if (event.kind === "ask_user" && toolUseId) {
        this.asks.set(toolUseId, event);
      }
      if (event.kind === "tool_result") {
        this.asks.delete(toolUseId);
      }
    }
    return this.history.apply(events);
  }

  private revoke(): void {
    this.revoked = true;
    this.canWrite = false;
    this.inputs.clear();
    this.approvals.clear();
    this.asks.clear();
    this.close();
    this.hooks.denied();
  }
}
