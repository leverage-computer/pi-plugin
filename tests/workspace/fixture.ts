import type { ServerWebSocket } from "bun";
import { api } from "../../src/api";
import { workspace } from "../../src/workspace/api";
import type {
  Channel,
  HostedModel,
  Invocation,
  SessionInput,
  TranscriptRow,
  WorkspaceSession,
} from "../../src/workspace/schema";

export const SESSION = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "member";

export const hostedModel: HostedModel = {
  id: "hosted-model",
  label: "Hosted model",
  description: null,
  family: "claude_code",
  legacy: false,
  reasoningEfforts: ["low", "high"],
  defaultReasoningEffort: "low",
};

// The fixture server decides read access from the session's visibility.
export function exampleSession(): WorkspaceSession & { visibility: string } {
  return {
    id: SESSION,
    title: "Shared work",
    channelId: null,
    visibility: "private",
    providerFamily: "claude_code",
    model: "hosted-model",
    reasoningEffort: "high",
    status: "idle",
    turnId: null,
    ownerId: "owner",
  };
}

/** A person's message as the native API reports it. */
export function input(
  content: string,
  overrides: Partial<SessionInput> = {},
): SessionInput {
  return {
    uuid: crypto.randomUUID(),
    sessionId: SESSION,
    authorId: "owner",
    authorName: "Alice",
    harness: null,
    content,
    status: "received",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A governed tool call waiting for a decision. */
export function invocation(overrides: Partial<Invocation> = {}): Invocation {
  return {
    id: crypto.randomUUID(),
    sessionId: SESSION,
    toolUseId: "toolu_1",
    tool: "bash",
    toolDisplayName: "Run a command",
    originalArguments: { command: "bun test" },
    effectiveArguments: null,
    state: "pending_approval",
    actingUserName: "Alice",
    connectorName: null,
    ...overrides,
  };
}

type Extra = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;

/**
 * A local Leverage that speaks the same native HTTP routes and socket frames
 * as production. Tests publish transcript rows and frames through it.
 */
export function workspaceFixture(extra?: Extra) {
  const session = exampleSession();
  const sessions: Array<WorkspaceSession & { visibility: string }> = [session];
  const channels: Channel[] = [
    {
      id: "general",
      name: "general",
      kind: "channel",
      defaultProviderFamily: "claude_code",
    },
  ];
  const grants: Array<{
    principalType: "user" | "channel";
    principalId: string;
    role: "viewer" | "collaborator";
  }> = [];
  const requests: Array<{
    path: string;
    method: string;
    body: Record<string, unknown>;
    user: string;
  }> = [];
  const frames: Array<Record<string, unknown>> = [];
  const connections = new Set<ServerWebSocket<{ user: string }>>();
  const events = new Map<string, TranscriptRow[]>();
  const approvals: Invocation[] = [];
  const uploads: Array<{ id: string; bytes: number; completed: boolean }> = [];
  let opened = false;
  let sequence = 0;
  let cursor = 0;
  const state = {
    dropCreated: false,
    dropMessageAck: false,
    createCount: 0,
    refreshCount: 0,
    version: 0,
    readDelay: undefined as Promise<void> | undefined,
    // The session's outputs folder, by resource-relative path.
    outputs: {
      "report.md": "# Report\nAll checks pass.",
      "logs/run.txt": "run 1 ok",
    } as Record<string, string>,
    nativeMessages: [] as SessionInput[],
    queue: [] as SessionInput[],
    catalog: [hostedModel] as HostedModel[],
    preferences: {} as Record<string, unknown>,
  };
  const created = new Set<string>();
  const canRead = (user: string) =>
    user === "owner" ||
    session.visibility === "workspace" ||
    grants.some((g) => g.principalId === user);
  const canWrite = (user: string) =>
    user === "owner" ||
    grants.some((g) => g.principalId === user && g.role === "collaborator");
  const publish = (frame: Record<string, unknown>) => {
    for (const connection of connections) {
      connection.send(JSON.stringify(frame));
    }
  };
  // Appends a transcript row and sends it live, like the control plane does.
  const emit = (
    kind: string,
    data: Record<string, unknown>,
    options: Partial<TranscriptRow> = {},
  ): TranscriptRow => {
    const sessionId = options.sessionId ?? SESSION;
    const event: TranscriptRow = {
      id: options.id ?? crypto.randomUUID(),
      sessionId,
      kind,
      data,
      createdAt: new Date().toISOString(),
      transcriptSeq: ++sequence,
      ...options,
    };
    const list = events.get(sessionId) ?? [];
    list.push(event);
    events.set(sessionId, list);
    publish({
      type: "session.event",
      _topic: "session",
      cursor: ++cursor,
      sessionId,
      event,
    });
    return event;
  };
  // Changes the session head and broadcasts it.
  const update = (patch: Partial<WorkspaceSession>) => {
    Object.assign(session, patch);
    state.version++;
    publish({
      type: "session.updated",
      _topic: "session",
      cursor: ++cursor,
      sessionId: session.id,
      title: session.title ?? undefined,
      status: session.status,
      awaitingReason: session.awaitingReason ?? null,
      model: session.model,
      reasoningEffort: session.reasoningEffort ?? null,
      queuedCount: 0,
      turnId: session.turnId ?? null,
      version: state.version,
      archivedAt: session.archivedAt ?? null,
    });
  };
  const server = Bun.serve<{ user: string }>({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request, server) {
      const url = new URL(request.url);
      const path = url.pathname;
      const user =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (path === "/ws") {
        if (server.upgrade(request, { data: { user } })) {
          return;
        }
        return new Response(null, { status: 400 });
      }
      if (path.startsWith("/upload/")) {
        const bytes = (await request.arrayBuffer()).byteLength;
        const upload = uploads.find((one) => path.endsWith(one.id));
        if (upload) {
          upload.bytes = bytes;
        }
        return new Response(null, { status: 200 });
      }
      const body =
        request.method === "GET"
          ? {}
          : ((await request
              .clone()
              .json()
              .catch(() => ({}))) as Record<string, unknown>);
      requests.push({ path, method: request.method, body, user });
      if (path === "/api/cli/auth/refresh") {
        state.refreshCount++;
        return Response.json({ access_token: "owner" });
      }
      if (user === "expired") {
        return Response.json({ error: "expired" }, { status: 401 });
      }
      const custom = await extra?.(request);
      if (custom) {
        return custom;
      }
      if (path === "/api/workspaces") {
        return Response.json([{ id: "workspace", slug: "test" }]);
      }
      if (path === "/api/users") {
        return Response.json([
          { id: "owner", name: "Alice" },
          { id: MEMBER, name: "Bob" },
        ]);
      }
      if (path === "/api/channels") {
        return Response.json(channels);
      }
      if (path === "/api/user/preferences") {
        return Response.json(state.preferences);
      }
      if (path === "/api/sessions") {
        return Response.json(canRead(user) ? sessions : []);
      }
      if (path === "/api/sessions/archived") {
        return Response.json([]);
      }
      if (path.endsWith("/provider-access/availability")) {
        return Response.json({ claude_code: true, codex: false });
      }
      if (path.endsWith("/provider-models")) {
        return Response.json({ models: state.catalog });
      }
      const id = path.match(/^\/api\/sessions\/([^/]+)/)?.[1];
      const target = sessions.find((one) => one.id === id);
      if (path.endsWith("/bootstrap")) {
        if (state.readDelay) {
          await state.readDelay;
        }
        if (!target || !canRead(user)) {
          return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        return Response.json({
          session: target,
          events: events.get(target.id) ?? [],
          messages: state.nativeMessages,
          version: state.version,
          lastCursorIncluded: cursor,
          toolApprovals: approvals,
          viewerCanWrite: canWrite(user),
        });
      }
      if (path.endsWith("/events/history")) {
        const before = Number(url.searchParams.get("beforeTranscriptSeq"));
        const limit = Number(url.searchParams.get("limit") ?? 500);
        const older = (events.get(id ?? "") ?? []).filter(
          (one) => (one.transcriptSeq ?? 0) < before,
        );
        const page = older.slice(-limit);
        return Response.json({
          events: page,
          hasOlderEvents: older.length > page.length,
          oldestTranscriptSeq: page[0]?.transcriptSeq ?? null,
        });
      }
      if (path.endsWith("/queue")) {
        return Response.json({
          sessionId: id,
          queuedCount: state.queue.length,
          queueHold: null,
          messages: state.queue,
        });
      }
      if (path.endsWith("/files/resources")) {
        return Response.json({
          basis: "active_runtime",
          policyRevision: 1,
          inputRevisionDigest: "d",
          resources: [
            {
              resourceId: "state:1",
              stableId: "1",
              version: 1,
              kind: "task_workspace",
              access: "rw",
              source: "session",
              mountPath: "/work/outputs",
              isAnchor: false,
              isWorkingRoot: true,
            },
            {
              resourceId: "cache:1",
              stableId: "2",
              version: 1,
              kind: "workspace_cache",
              access: "rw",
              source: "cache",
              mountPath: "/work/.cache",
              isAnchor: false,
              isWorkingRoot: false,
            },
          ],
        });
      }
      const folder = url.searchParams.get("path") ?? "";
      if (path.endsWith("/files/tree")) {
        const inside = Object.keys(state.outputs)
          .filter((file) => !folder || file.startsWith(`${folder}/`))
          .map((file) => file.slice(folder ? folder.length + 1 : 0));
        const names = [...new Set(inside.map((file) => file.split("/")[0]!))];
        return Response.json({
          path: folder,
          entries: names.map((name) => {
            const full = folder ? `${folder}/${name}` : name;
            const text = state.outputs[full];
            return {
              name,
              path: full,
              type: text === undefined ? "dir" : "file",
              size: text?.length ?? null,
              modifiedAt: null,
            };
          }),
        });
      }
      if (path.endsWith("/files/read")) {
        const text = state.outputs[folder] ?? "";
        return Response.json({
          path: folder,
          name: folder.split("/").pop(),
          byteSize: text.length,
          encoding: "utf-8",
          isBinary: false,
          tooLarge: false,
          modifiedAt: null,
          downloadOnly: false,
          content: text,
        });
      }
      if (path.endsWith("/files/search")) {
        const query = url.searchParams.get("q") ?? "";
        return Response.json({
          entries: Object.keys(state.outputs)
            .filter((file) => file.includes(query))
            .map((file) => ({
              name: file.split("/").pop(),
              path: file,
              type: "file",
              size: state.outputs[file]!.length,
              modifiedAt: null,
              score: 1,
            })),
          truncated: false,
          visited: Object.keys(state.outputs).length,
        });
      }
      if (path.endsWith("/files/download")) {
        return new Response(state.outputs[folder] ?? "");
      }
      if (path.endsWith("/file-sources")) {
        return Response.json({
          working: false,
          sources: [
            {
              id: "checkout:1",
              resourceId: "checkout:1",
              kind: "repository",
              label: "acme/storefront",
              mountPath: "/work/storefront",
              branch: "leverage/fix-checkout",
              changes: [
                {
                  path: "tests/checkout.test.ts",
                  state: "modified",
                  additions: 1,
                  deletions: 1,
                },
              ],
              updates: [],
              unpublished: 1,
              publication: {
                number: 42,
                url: "https://github.com/acme/storefront/pull/42",
                headCommit: "abc",
                branch: "leverage/fix-checkout",
                state: "open",
              },
            },
          ],
        });
      }
      if (path.endsWith("/connectors")) {
        return Response.json({
          connectors: [
            {
              id: "c1",
              name: "linear",
              namespace: "linear",
              label: "Linear",
              scope: "workspace",
              disabled: false,
              runtimeStatus: "runtime_verified",
              catalogToolCount: 12,
              description: "Issues and projects",
            },
          ],
        });
      }
      if (path.endsWith("/pending-approvals")) {
        return Response.json({
          invocations: approvals.filter(
            (one) => one.state === "pending_approval",
          ),
        });
      }
      if (path.endsWith("/read")) {
        return Response.json({ readState: {} });
      }
      const decided = path.match(/^\/api\/tool-invocations\/([^/]+)\/decide$/);
      if (decided) {
        const found = approvals.find((one) => one.id === decided[1]);
        if (!found) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        found.state = body.action === "deny" ? "denied" : "approved";
        publish({
          type: "session.approval.updated",
          _topic: "session",
          cursor: ++cursor,
          sessionId: found.sessionId,
          invocation: found,
        });
        return Response.json(found);
      }
      if (path === "/api/uploads/init") {
        const upload = { id: crypto.randomUUID(), bytes: 0, completed: false };
        uploads.push(upload);
        return Response.json({
          attachmentId: upload.id,
          mode: "single",
          url: `${url.origin}/upload/${upload.id}`,
        });
      }
      const completed = path.match(/^\/api\/uploads\/([^/]+)\/complete$/);
      if (completed) {
        const upload = uploads.find((one) => one.id === completed[1]);
        if (upload) {
          upload.completed = true;
        }
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    },
    websocket: {
      open(ws) {
        connections.add(ws);
        ws.send(
          JSON.stringify({ type: "connection.ready", userId: ws.data.user }),
        );
      },
      close(ws) {
        connections.delete(ws);
      },
      message(ws, raw) {
        const frame = JSON.parse(String(raw)) as Record<string, unknown>;
        frames.push(frame);
        const reply = (value: Record<string, unknown>) =>
          ws.send(JSON.stringify(value));
        switch (frame.type) {
          case "session.create": {
            if (!created.has(String(frame.clientRequestId))) {
              created.add(String(frame.clientRequestId));
              state.createCount++;
              if (typeof frame.title === "string") {
                session.title = frame.title;
              }
            }
            if (state.dropCreated) {
              state.dropCreated = false;
              return;
            }
            reply({
              type: "session.created",
              session,
              clientRequestId: frame.clientRequestId,
            });
            return;
          }
          case "session.message": {
            if (state.dropMessageAck) {
              return;
            }
            const message = input(String(frame.content), {
              uuid: String(frame.clientRequestId),
              sessionId: String(frame.sessionId),
              authorId: ws.data.user,
              authorName: ws.data.user === "owner" ? "Alice" : "Bob",
              harness: String(frame.harness),
              status: frame.delivery === "queue" ? "queued" : "received",
            });
            state.nativeMessages = [
              ...state.nativeMessages.filter(
                (one) => one.uuid !== message.uuid,
              ),
              message,
            ];
            state.version++;
            reply({
              type: "session.message.received",
              sessionId: frame.sessionId,
              clientRequestId: frame.clientRequestId,
              message,
            });
            publish({
              type: "session.messages.updated",
              _topic: "session",
              cursor: ++cursor,
              sessionId: frame.sessionId,
              version: state.version,
              messages: [message],
            });
            return;
          }
          case "session.stop":
            reply({
              type: "session.stop.accepted",
              sessionId: frame.sessionId,
              clientRequestId: frame.clientRequestId,
            });
            return;
          case "session.rename":
            session.title = String(frame.title);
            reply({
              type: "session.rename.accepted",
              sessionId: frame.sessionId,
              title: frame.title,
              clientRequestId: frame.clientRequestId,
            });
            update({ title: session.title });
            return;
          case "session.answer":
            reply({
              type: "session.answer.received",
              sessionId: frame.sessionId,
              toolUseId: frame.toolUseId,
              clientRequestId: frame.clientRequestId,
            });
            return;
          // Leverage confirms these only through the session update.
          case "session.archive":
          case "session.unarchive":
            if (!canWrite(ws.data.user)) {
              reply({ type: "error", message: "Only writers can archive" });
              return;
            }
            update({
              archivedAt:
                frame.type === "session.archive"
                  ? new Date().toISOString()
                  : null,
            });
            return;
          default:
            return;
        }
      },
    },
  });
  return {
    session,
    sessions,
    channels,
    grants,
    requests,
    frames,
    connections,
    events,
    approvals,
    uploads,
    state,
    publish,
    emit,
    update,
    server,
    client(user = "owner") {
      api.connect({
        host: server.url.origin,
        workspace: "test",
        token: user,
        refreshToken: "refresh-fixture",
      });
      workspace.open();
      opened = true;
      return workspace;
    },
    async close() {
      if (opened) {
        workspace.close();
        api.close();
      }
      await server.stop(true);
    },
  };
}

export async function eventually(
  check: () => boolean | Promise<boolean>,
): Promise<void> {
  for (let n = 0; n < 200; n++) {
    if (await check()) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("Expected state did not arrive");
}
