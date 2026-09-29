/**
 * A local stand-in for Leverage, used to record the tutorial videos.
 *
 * It speaks the same native HTTP routes and workspace socket frames as
 * production, with a made-up workspace called Acme. A scripted agent answers
 * each message, so the videos show real plugin behavior without real data.
 *
 * Run it with `bun run demo`, then start Pi with:
 *   LEVERAGE_HOST=http://127.0.0.1:4545 LEVERAGE_WORKSPACE=acme LEVERAGE_TOKEN=demo pi
 */
import { randomUUID } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import {
  type ClientFrame,
  clientFrameSchema,
  type HostedModel,
  type Invocation,
  type SessionInput,
  type TranscriptRow,
  type WorkspaceSession,
} from "../../src/workspace/schema";

// What Pi sends when someone approves or denies a tool call.
const decisionSchema = z.object({ action: z.enum(["approve", "deny"]) });

type Session = {
  head: WorkspaceSession;
  events: TranscriptRow[];
  inputs: SessionInput[];
  approvals: Invocation[];
  version: number;
  stopped: boolean;
};

const PORT = Number(process.env.DEMO_PORT ?? 4545);
const ME = { id: "sam", name: "Sam Rivera" };
const MEMBERS = [
  ME,
  { id: "ada", name: "Ada Lovelace" },
  { id: "grace", name: "Grace Hopper" },
];
const CHANNELS = [
  { id: "engineering", name: "engineering", kind: "channel" },
  { id: "design", name: "design", kind: "channel" },
];
const MODELS: HostedModel[] = [
  {
    id: "sonnet",
    label: "Claude Sonnet",
    description: "Fast and capable",
    family: "claude_code",
    legacy: false,
    reasoningEfforts: ["low", "medium", "high"],
    defaultReasoningEffort: "medium",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's coding model",
    family: "codex",
    legacy: false,
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  },
];

const sessions = new Map<string, Session>();
const sockets = new Set<ServerWebSocket<unknown>>();
const decisions = new Map<string, (approved: boolean) => void>();
let sequence = 0;
let cursor = 0;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function broadcast(frame: Record<string, unknown>): void {
  const text = JSON.stringify({
    _topic: "session",
    cursor: ++cursor,
    ...frame,
  });
  for (const socket of sockets) {
    socket.send(text);
  }
}

function addSession(options: {
  title: string;
  channelId?: string;
  repo?: string;
  model?: string;
  effort?: string;
  updated: number;
}): Session {
  const session: Session = {
    head: {
      id: randomUUID(),
      title: options.title,
      channelId: options.channelId ?? null,
      providerFamily: options.model === "codex" ? "codex" : "claude_code",
      model: options.model ?? "sonnet",
      reasoningEffort: options.effort ?? "medium",
      status: "idle",
      turnId: null,
      updatedAt: minutesAgo(options.updated),
      ...(options.repo
        ? { repo: { fullName: options.repo }, requestedBranch: "main" }
        : {}),
    },
    events: [],
    inputs: [],
    approvals: [],
    version: 0,
    stopped: false,
  };
  sessions.set(session.head.id, session);
  return session;
}

// Appends a transcript row and sends it live, like the control plane does.
function emit(
  session: Session,
  kind: string,
  data: Record<string, unknown>,
  extra: Partial<TranscriptRow> = {},
): TranscriptRow {
  const event: TranscriptRow = {
    id: randomUUID(),
    sessionId: session.head.id,
    kind,
    data,
    createdAt: new Date().toISOString(),
    transcriptSeq: ++sequence,
    ...extra,
  };
  session.events.push(event);
  broadcast({ type: "session.event", sessionId: session.head.id, event });
  return event;
}

function update(session: Session, patch: Partial<WorkspaceSession>): void {
  Object.assign(session.head, patch, { updatedAt: new Date().toISOString() });
  session.version++;
  broadcast({
    type: "session.updated",
    sessionId: session.head.id,
    title: session.head.title ?? undefined,
    status: session.head.status,
    awaitingReason: session.head.awaitingReason ?? null,
    model: session.head.model,
    reasoningEffort: session.head.reasoningEffort ?? null,
    queuedCount: 0,
    turnId: session.head.turnId ?? null,
    version: session.version,
    archivedAt: session.head.archivedAt ?? null,
  });
}

// Streams assistant text word by word, then settles it as one finished row.
async function say(session: Session, text: string): Promise<void> {
  const eventId = randomUUID();
  const row = emit(session, "text", {
    role: "assistant",
    content: "",
    eventId,
  });
  let offset = 0;
  for (const word of text.split(/(?<= )/)) {
    broadcast({
      type: "session.event.delta",
      sessionId: session.head.id,
      delta: {
        kind: "text",
        streamId: eventId,
        eventId,
        rowId: row.id,
        delta: word,
        offset,
      },
    });
    offset += word.length;
    await sleep(45);
  }
  emit(
    session,
    "text",
    { role: "assistant", content: text, eventId, finalized: true },
    { id: row.id },
  );
}

// Runs a command, streaming its output while it runs.
async function run(session: Session, command: string, output: string) {
  const toolUseId = `toolu_${randomUUID()}`;
  emit(session, "tool_call", { toolUseId, name: "bash", input: { command } });
  let offset = 0;
  for (const line of output.split("\n")) {
    const chunk = `${line}\n`;
    broadcast({
      type: "session.event.delta",
      sessionId: session.head.id,
      delta: {
        kind: "command_output",
        streamId: toolUseId,
        toolUseId,
        delta: chunk,
        offset,
      },
    });
    offset += chunk.length;
    await sleep(220);
  }
  emit(session, "tool_result", { toolUseId, content: output });
}

// Asks for approval, then waits until someone decides in any client.
function ask(session: Session, command: string): Promise<boolean> {
  const invocation: Invocation = {
    id: randomUUID(),
    sessionId: session.head.id,
    toolUseId: `toolu_${randomUUID()}`,
    tool: "bash",
    toolDisplayName: "Run the staging deploy script",
    originalArguments: { command },
    effectiveArguments: null,
    state: "pending_approval",
    actingUserName: ME.name,
    connectorName: null,
  };
  session.approvals.push(invocation);
  update(session, {
    status: "awaiting_input",
    awaitingReason: { kind: "tool_approval", tool: "bash", count: 1 },
  });
  broadcast({
    type: "session.approval.pending",
    sessionId: session.head.id,
    invocation,
  });
  return new Promise((resolve) => {
    decisions.set(invocation.id, (approved) => {
      invocation.state = approved ? "approved" : "denied";
      session.approvals = session.approvals.filter(
        (one) => one.id !== invocation.id,
      );
      broadcast({
        type: "session.approval.updated",
        sessionId: session.head.id,
        invocation,
      });
      update(session, { status: "active", awaitingReason: null });
      resolve(approved);
    });
  });
}

// The scripted agent. A message about deploying asks for approval first.
async function answer(session: Session, prompt: string): Promise<void> {
  session.stopped = false;
  update(session, { status: "active", turnId: randomUUID() });
  if (/deploy|staging|release/i.test(prompt)) {
    await say(session, "I'll deploy the current branch to staging.");
    const approved = await ask(session, "./scripts/deploy.sh staging");
    if (approved) {
      await run(
        session,
        "./scripts/deploy.sh staging",
        "Building storefront…\nUploading 42 files…\nStaging is live at https://staging.acme.example",
      );
      await say(session, "Staging is live, and the health checks pass.");
    } else {
      await say(session, "Understood. I left staging as it was.");
    }
  } else {
    await say(session, "Let me run the checkout tests first.");
    await sleep(400);
    if (session.stopped) {
      return;
    }
    await run(
      session,
      "bun test tests/checkout.test.ts",
      "✓ adds an item to the cart\n✓ applies a discount code\n✓ charges the saved card\n\n 3 pass\n 0 fail",
    );
    await say(
      session,
      "All three checkout tests pass. This change does not touch payments, so it is safe to merge.",
    );
  }
  emit(session, "complete", {});
  update(session, { status: "idle", turnId: null });
}

// A few sessions, so the session picker has something to show.
function seed(): void {
  const flaky = addSession({
    title: "Fix the flaky checkout test",
    channelId: "engineering",
    repo: "acme/storefront",
    updated: 95,
  });
  const asked = randomUUID();
  flaky.inputs.push({
    uuid: asked,
    sessionId: flaky.head.id,
    authorId: "grace",
    authorName: "Grace Hopper",
    harness: null,
    content:
      "The checkout test fails about one run in ten. Can you find out why?",
    status: "consumed",
    createdAt: minutesAgo(99),
  });
  emit(
    flaky,
    "user",
    {
      content:
        "The checkout test fails about one run in ten. Can you find out why?",
    },
    { authorId: "grace", sourceInputUuids: [asked], createdAt: minutesAgo(99) },
  );
  emit(
    flaky,
    "text",
    {
      role: "assistant",
      finalized: true,
      content:
        "The test waits a fixed 200 ms for the payment mock. Under load the mock answers later, so the check runs too early. I now wait for the mock's `ready` event instead, and 200 runs in a row pass.",
    },
    { createdAt: minutesAgo(97) },
  );
  addSession({
    title: "Draft the launch announcement",
    channelId: "design",
    updated: 240,
  });
  addSession({
    title: "Weekly dependency update",
    repo: "acme/storefront",
    model: "codex",
    updated: 60 * 26,
  });
}

function route(request: Request, url: URL, body: unknown) {
  const path = url.pathname;
  if (path === "/api/workspaces") {
    return Response.json([{ id: "acme", slug: "acme" }]);
  }
  if (path === "/api/users") {
    return Response.json(MEMBERS);
  }
  if (path === "/api/channels") {
    return Response.json(
      CHANNELS.map((one) => ({ ...one, defaultProviderFamily: "claude_code" })),
    );
  }
  if (path.endsWith("/provider-access/availability")) {
    return Response.json({ claude_code: true, codex: true });
  }
  if (path.endsWith("/provider-models")) {
    return Response.json({ models: MODELS });
  }
  if (path === "/api/sessions" || path === "/api/sessions/archived") {
    const archived = path.endsWith("/archived");
    const listed = [...sessions.values()].filter(
      (one) => Boolean(one.head.archivedAt) === archived,
    );
    return Response.json(listed.map((one) => one.head));
  }
  const decided = path.match(/^\/api\/tool-invocations\/([^/]+)\/decide$/);
  if (decided) {
    const decision = decisionSchema.safeParse(body);
    decisions.get(decided[1])?.(decision.data?.action === "approve");
    return Response.json({ ok: true });
  }
  const id = path.match(/^\/api\/sessions\/([^/]+)/)?.[1];
  const session = id ? sessions.get(id) : undefined;
  if (!session) {
    return undefined;
  }
  if (path.endsWith("/bootstrap")) {
    return Response.json({
      session: session.head,
      events: session.events,
      messages: session.inputs,
      version: session.version,
      lastCursorIncluded: cursor,
      toolApprovals: session.approvals,
      viewerCanWrite: true,
    });
  }
  if (path.endsWith("/events/history")) {
    const before = Number(url.searchParams.get("beforeTranscriptSeq"));
    const older = session.events.filter(
      (one) => (one.transcriptSeq ?? 0) < before,
    );
    return Response.json({
      events: older.slice(-50),
      hasOlderEvents: older.length > 50,
      oldestTranscriptSeq: older.slice(-50)[0]?.transcriptSeq ?? null,
    });
  }
  if (path.endsWith("/pending-approvals")) {
    return Response.json({ invocations: session.approvals });
  }
  if (path.endsWith("/queue")) {
    return Response.json({ queuedCount: 0, messages: [] });
  }
  if (path.endsWith("/read")) {
    return Response.json({ readState: {} });
  }
  void request;
  return undefined;
}

// Handles one frame from Pi on the workspace socket.
function receive(socket: ServerWebSocket<unknown>, frame: ClientFrame) {
  const reply = (value: Record<string, unknown>) =>
    socket.send(JSON.stringify(value));
  const session =
    "sessionId" in frame ? sessions.get(frame.sessionId) : undefined;
  switch (frame.type) {
    case "session.create": {
      const created = addSession({
        title: frame.title ?? "New session",
        channelId:
          frame.context.type === "channel"
            ? frame.context.channelId
            : undefined,
        model: frame.model,
        effort: frame.reasoningEffort,
        updated: 0,
      });
      reply({
        type: "session.created",
        session: created.head,
        clientRequestId: frame.clientRequestId,
      });
      return;
    }
    case "session.message": {
      if (!session) {
        return;
      }
      const uuid = frame.clientRequestId;
      const message: SessionInput = {
        uuid,
        sessionId: session.head.id,
        authorId: ME.id,
        authorName: ME.name,
        harness: "leverage/cli",
        content: frame.content,
        status: "received",
        createdAt: new Date().toISOString(),
      };
      session.inputs.push(message);
      session.version++;
      reply({
        type: "session.message.received",
        sessionId: session.head.id,
        clientRequestId: uuid,
        message,
      });
      broadcast({
        type: "session.messages.updated",
        sessionId: session.head.id,
        version: session.version,
        messages: [message],
      });
      // The runner picks the message up a moment later, as a real one would.
      setTimeout(() => {
        message.status = "consumed";
        emit(
          session,
          "user",
          { content: message.content },
          { authorId: ME.id, sourceInputUuids: [uuid] },
        );
        void answer(session, message.content);
      }, 400);
      return;
    }
    case "session.rename": {
      if (session) {
        update(session, { title: frame.title });
      }
      reply({
        type: "session.rename.accepted",
        sessionId: frame.sessionId,
        title: frame.title,
        clientRequestId: frame.clientRequestId,
      });
      return;
    }
    case "session.stop": {
      if (session) {
        session.stopped = true;
        emit(
          session,
          "interrupted",
          { cause: "user_stop" },
          { authorId: ME.id },
        );
        update(session, { status: "idle", turnId: null });
      }
      reply({
        type: "session.stop.accepted",
        sessionId: frame.sessionId,
        clientRequestId: frame.clientRequestId,
      });
      return;
    }
    case "session.archive":
    case "session.unarchive":
      if (session) {
        update(session, {
          archivedAt:
            frame.type === "session.archive" ? new Date().toISOString() : null,
        });
      }
      return;
    // The demo shows none of these, so it ignores them.
    case "session.answer":
    case "session.compact":
    case "session.queue.cancel":
    case "session.queue.steer":
    case "session.subscribe":
    case "session.unsubscribe":
    case "presence.heartbeat":
      return;
  }
}

seed();

Bun.serve<unknown>({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      return server.upgrade(request, { data: {} })
        ? undefined
        : new Response(null, { status: 400 });
    }
    if (url.pathname === "/api/cli/auth/refresh") {
      return Response.json({ access_token: "demo" });
    }
    const body =
      request.method === "GET"
        ? {}
        : await request.json().catch(() => undefined);
    return (
      route(request, url, body) ??
      Response.json({ error: "Not found" }, { status: 404 })
    );
  },
  websocket: {
    open(socket) {
      sockets.add(socket);
      socket.send(JSON.stringify({ type: "connection.ready", userId: ME.id }));
    },
    close(socket) {
      sockets.delete(socket);
    },
    message(socket, raw) {
      const frame = clientFrameSchema.safeParse(JSON.parse(String(raw)));
      if (frame.success) {
        receive(socket, frame.data);
      }
    },
  },
});

console.log(`Demo Leverage is running at http://127.0.0.1:${PORT}`);
