import type { ServerWebSocket } from "bun";
import { type ModelInfo, SessionClient } from "../src/api";
import { WorkspaceClient } from "../src/workspace-api";
import type { SessionGrant, WorkspaceSession } from "../src/workspace-schema";

export const SESSION = "11111111-1111-4111-8111-111111111111";
export const MEMBER = "member";
export const hostedModel: ModelInfo = {
	id: "hosted-model",
	modelID: "hosted-model",
	providerID: "leverage",
	name: "Hosted model",
	family: "claude_code",
	capabilities: { tools: true, input: ["text"], output: ["text"] },
	variants: [{ id: "low" }, { id: "high" }],
	time: { released: 0 },
	cost: [],
	status: "active",
	enabled: true,
	limit: { context: 200000, output: 64000 },
};
export function exampleSession(): WorkspaceSession {
	return {
		id: SESSION,
		title: "Shared work",
		channelId: null,
		visibility: "private",
		ownerId: "owner",
		providerFamily: "claude_code",
		model: "hosted-model",
		reasoningEffort: "high",
		mode: "yolo",
		status: "idle",
	};
}

export function workspaceFixture(
	extra?: (
		request: Request,
	) => Response | undefined | Promise<Response | undefined>,
) {
	const session = exampleSession();
	const grants: SessionGrant[] = [];
	const requests: Array<{
		path: string;
		method: string;
		body: Record<string, unknown>;
		user: string;
	}> = [];
	const frames: Array<Record<string, unknown>> = [];
	const connections = new Set<ServerWebSocket<{ user: string }>>();
	const clients: WorkspaceClient[] = [];
	const state = {
		visibilityFailures: 0,
		dropCreated: false,
		createCount: 0,
		refreshCount: 0,
		version: 0,
		readDelay: undefined as Promise<void> | undefined,
		nativeMessages: [] as unknown[],
		channelMessages: [] as Record<string, unknown>[],
	};
	const created = new Set<string>();
	const messageIds = new Set<string>();
	const canRead = (user: string) =>
		user === "owner" ||
		session.visibility === "workspace" ||
		grants.some((g) => g.principalId === user);
	const canWrite = (user: string) =>
		user === "owner" ||
		grants.some((g) => g.principalId === user && g.role === "collaborator");
	const publish = (event: Record<string, unknown>) => {
		for (const connection of connections)
			connection.send(JSON.stringify(event));
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
				if (server.upgrade(request, { data: { user } })) return;
				return new Response(null, { status: 400 });
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
			if (user === "expired")
				return Response.json({ error: "expired" }, { status: 401 });
			const custom = await extra?.(request);
			if (custom) return custom;
			if (path === "/api/workspaces")
				return Response.json([{ id: "workspace", slug: "test" }]);
			if (path === "/api/users")
				return Response.json([
					{ id: "owner", name: "Alice" },
					{ id: MEMBER, name: "Bob" },
				]);
			if (path === "/api/channels")
				return Response.json([
					{
						id: "general",
						name: "general",
						kind: "channel",
						visibility: "public",
						defaultProviderFamily: "claude_code",
					},
				]);
			if (path === "/api/read-state/channels")
				return Response.json([{ channelId: "general", unreadCount: 2 }]);
			if (path === "/api/sessions")
				return Response.json(canRead(user) ? [session] : []);
			if (path.endsWith("/provider-family-settings"))
				return Response.json({
					settings: [
						{
							providerFamily: "claude_code",
							defaultModel: hostedModel.id,
							defaultReasoningEffort: "high",
						},
					],
				});
			if (path.endsWith("/provider-access/availability"))
				return Response.json({ claude_code: true, codex: false });
			if (path.endsWith("/session-sharing-defaults"))
				return Response.json({ defaultVisibility: "workspace" });
			if (path.endsWith("/github/repos"))
				return Response.json({
					repos: [
						{
							id: "repo",
							fullName: "team/project",
							connectionStatus: "connected",
							defaultBranch: "main",
						},
					],
				});
			if (path.endsWith("/branches"))
				return Response.json({
					branches: [
						{ name: "main", isDefault: true },
						{ name: "feature", isDefault: false },
					],
				});
			if (path === "/api/opencode/api/model")
				return Response.json({ data: [hostedModel] });
			if (path.endsWith("/bootstrap")) {
				if (state.readDelay) await state.readDelay;
				return canRead(user)
					? Response.json({
							session,
							messages: state.nativeMessages,
							version: state.version,
							lastCursorIncluded: 0,
							viewerCanWrite: canWrite(user),
						})
					: Response.json({ error: "Forbidden" }, { status: 403 });
			}
			if (path.endsWith("/visibility")) {
				if (state.visibilityFailures-- > 0)
					return Response.json({ error: "Unavailable" }, { status: 503 });
				session.visibility = body.visibility as WorkspaceSession["visibility"];
				return Response.json({ visibility: session.visibility });
			}
			if (path.endsWith("/members")) {
				if (request.method === "POST") {
					const grant = body as unknown as SessionGrant;
					const index = grants.findIndex(
						(g) =>
							g.principalId === grant.principalId &&
							g.principalType === grant.principalType,
					);
					if (index >= 0) grants.splice(index, 1);
					grants.push(grant);
				}
				return Response.json({
					ownerId: "owner",
					visibility: session.visibility,
					members: grants,
					includePersonalKnowledge: false,
				});
			}
			if (path.includes("/members/") && request.method === "DELETE") {
				const principal = decodeURIComponent(path.split("/").at(-1)!);
				grants.splice(
					grants.findIndex((g) => g.principalId === principal),
					1,
				);
				return Response.json({ ok: true });
			}
			if (path.endsWith("/timeline"))
				return Response.json({
					messages: state.channelMessages.filter((m) => !m.parentMessageId),
					hasMoreOlder: false,
					nextBeforeSeq: null,
					lastCursorIncluded: 0,
				});
			if (path.endsWith("/thread"))
				return Response.json(
					state.channelMessages.filter(
						(m) => m.parentMessageId === path.split("/").at(-2),
					),
				);
			if (path.endsWith("/read")) return Response.json({ ok: true });
			if (path.endsWith("/file-sources"))
				return Response.json({ sources: [], working: false });
			if (path.endsWith("/live-file-status"))
				return Response.json({ available: true, files: [] });
			if (path.endsWith("/session-preview"))
				return Response.json({ resources: [] });
			if (
				path.startsWith("/api/opencode/api/session/") &&
				request.method === "PATCH"
			) {
				session.title = String(body.title);
				return new Response(null, { status: 204 });
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
				const event = JSON.parse(String(raw)) as Record<string, unknown>;
				frames.push(event);
				if (event.type === "session.create") {
					if (!created.has(String(event.clientRequestId))) {
						created.add(String(event.clientRequestId));
						state.createCount++;
					}
					if (state.dropCreated) {
						state.dropCreated = false;
						return;
					}
					ws.send(
						JSON.stringify({
							type: "session.created",
							session,
							clientRequestId: event.clientRequestId,
						}),
					);
				}
				if (event.type === "session.subscribe")
					ws.send(
						JSON.stringify({
							type: "session.presence.snapshot",
							sessionId: SESSION,
							viewers: [
								{ userId: "owner", userName: "Alice" },
								{ userId: MEMBER, userName: "Bob" },
							],
						}),
					);
				if (event.type === "message.send") {
					let message = state.channelMessages.find(
						(m) => m.clientMessageId === event.clientMessageId,
					);
					if (!messageIds.has(String(event.clientMessageId))) {
						message = {
							id: crypto.randomUUID(),
							channelId: event.channelId,
							content: event.content,
							authorId: ws.data.user,
							authorName: ws.data.user === "owner" ? "Alice" : "Bob",
							createdAt: new Date().toISOString(),
							clientMessageId: event.clientMessageId,
							parentMessageId: event.parentMessageId ?? null,
							topLevelSeq: state.channelMessages.length + 1,
						};
						state.channelMessages.push(message);
						messageIds.add(String(event.clientMessageId));
					}
					publish({ type: "message.created", message });
				}
			},
		},
	});
	return {
		session,
		grants,
		requests,
		frames,
		connections,
		state,
		publish,
		server,
		client(user = "owner") {
			const connection = {
				host: server.url.origin,
				workspace: "test",
				token: user,
				refreshToken: "refresh-fixture",
			};
			const transport = new SessionClient(connection);
			const client = new WorkspaceClient(transport, connection);
			clients.push(client);
			return client;
		},
		async close() {
			for (const client of clients) {
				client.close();
				client.transport.close();
			}
			await server.stop(true);
		},
	};
}

export async function eventually(
	check: () => boolean | Promise<boolean>,
): Promise<void> {
	for (let n = 0; n < 200; n++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("Expected state did not arrive");
}
