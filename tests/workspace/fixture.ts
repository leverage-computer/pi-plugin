import type { ServerWebSocket } from "bun";
import { type ModelInfo, SessionClient } from "../../src/api";
import { WorkspaceClient } from "../../src/workspace/api";
import type { WorkspaceSession } from "../../src/workspace/schema";

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
	};
}

export function workspaceFixture(
	extra?: (
		request: Request,
	) => Response | undefined | Promise<Response | undefined>,
) {
	const session = exampleSession();
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
	const clients: WorkspaceClient[] = [];
	const state = {
		dropCreated: false,
		createCount: 0,
		refreshCount: 0,
		version: 0,
		readDelay: undefined as Promise<void> | undefined,
		nativeMessages: [] as unknown[],
	};
	const created = new Set<string>();
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
			if (path === "/api/sessions")
				return Response.json(canRead(user) ? [session] : []);
			if (path.endsWith("/provider-access/availability"))
				return Response.json({ claude_code: true, codex: false });
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
