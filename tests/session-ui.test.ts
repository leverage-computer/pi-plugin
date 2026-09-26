import { afterEach, describe, expect, test } from "bun:test";
import type {
	ExtensionContext,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { SessionClient, type SessionInfo } from "../src/api";
import {
	newRemoteSession,
	pickRemoteSession,
	viewRemoteHistory,
} from "../src/session-ui";

const session: SessionInfo = {
	id: "ses_shared",
	projectID: "prj_workspace",
	location: { directory: "/demo/project" },
	title: "Shared project",
	cost: 0,
	tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
	time: { created: 1, updated: 2 },
};

const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});

function fixture(handler: (request: Request) => Response | Promise<Response>) {
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
	const client = new SessionClient({
		host: server.url.origin,
		workspace: "demo",
		token: "test-token",
	});
	const controller = new AbortController();
	disposals.push(async () => {
		controller.abort();
		client.close();
		await server.stop(true);
	});
	return { client, signal: controller.signal };
}

function context(
	ui: Partial<ExtensionUIContext>,
	mode: "tui" | "print" = "tui",
): ExtensionContext {
	return { hasUI: mode === "tui", mode, ui } as ExtensionContext;
}

describe("Leverage session picker", () => {
	test("searches, pages backward and forward, and opens archived sessions", async () => {
		const queries: URL[] = [];
		const { client, signal } = fixture((request) => {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/active")) return Response.json({ data: {} });
			queries.push(url);
			const archived = url.searchParams.get("directory")?.endsWith("/.archive");
			return Response.json({
				data: [
					{ ...session, title: archived ? "Archived work" : "Shared project" },
				],
				cursor: url.searchParams.has("cursor") ? {} : { next: "page-2" },
			});
		});
		const actions = [
			"Search sessions",
			"Next page",
			"Previous page",
			"Show archived sessions",
			"choose",
		];
		const selected = await pickRemoteSession(
			client,
			context({
				input: async () => "  shared work  ",
				select: async (_title, options) => {
					const action = actions.shift();
					if (action === "choose")
						return options.find((option) => option.includes("Archived work"));
					expect(options).toContain(action!);
					return action;
				},
			}),
			{ workspace: "demo", signal },
		);
		expect(selected?.title).toBe("Archived work");
		expect(queries).toHaveLength(5);
		expect(queries[1]?.searchParams.get("search")).toBe("shared work");
		expect(queries[2]?.searchParams.get("cursor")).toBe("page-2");
		expect(queries[3]?.searchParams.has("cursor")).toBe(false);
		expect(queries[4]?.searchParams.get("directory")).toBe("/demo/.archive");
	});

	test("cancelling the picker or a new title creates no remote task", async () => {
		const methods: string[] = [];
		const { client, signal } = fixture((request) => {
			methods.push(request.method);
			return Response.json(
				request.url.endsWith("/active")
					? { data: {} }
					: { data: [], cursor: {} },
			);
		});
		const ui = context({
			select: async () => undefined,
			input: async () => undefined,
		});
		expect(
			await pickRemoteSession(client, ui, { workspace: "demo", signal }),
		).toBeUndefined();
		expect(
			await newRemoteSession(client, ui, { workspace: "demo", signal }),
		).toBeUndefined();
		expect(methods.every((method) => method === "GET")).toBe(true);
	});

	test("creates a named task in the selected folder without a prompt", async () => {
		const writes: Array<{ method: string; path: string; body: unknown }> = [];
		const { client, signal } = fixture(async (request) => {
			const path = new URL(request.url).pathname;
			if (request.method === "GET")
				return Response.json([
					{ sandboxes: ["/demo/project", "/demo/design"] },
				]);
			const body: unknown = await request.json();
			writes.push({ method: request.method, path, body });
			if (request.method === "PATCH")
				return new Response(null, { status: 204 });
			const input = body as { id: string; location: { directory: string } };
			return Response.json({ data: { ...session, ...input } });
		});
		const created = await newRemoteSession(
			client,
			context({
				input: async () => "  Plan the changes  ",
				select: async (_title, options) => {
					expect(options).toContain("/demo/design");
					return "/demo/design";
				},
			}),
			{ workspace: "demo", signal },
		);
		expect(created?.title).toBe("Plan the changes");
		expect(created?.location.directory).toBe("/demo/design");
		expect(writes).toEqual([
			{
				method: "POST",
				path: "/api/opencode/api/session",
				body: { id: created?.id, location: { directory: "/demo/design" } },
			},
			{
				method: "PATCH",
				path: `/api/opencode/api/session/${created?.id}`,
				body: { title: "Plan the changes" },
			},
		]);
	});

	test("cancelling folder selection creates no remote task", async () => {
		const methods: string[] = [];
		const { client, signal } = fixture((request) => {
			methods.push(request.method);
			return Response.json([{ sandboxes: ["/demo/project"] }]);
		});
		expect(
			await newRemoteSession(
				client,
				context({ select: async () => undefined }),
				{ title: "Draft", workspace: "demo", signal },
			),
		).toBeUndefined();
		expect(methods).toEqual(["GET"]);
	});

	test("history viewer renders older and newer pages using its keyboard controls", async () => {
		const cursors: Array<string | null> = [];
		const { client, signal } = fixture((request) => {
			const cursor = new URL(request.url).searchParams.get("cursor");
			cursors.push(cursor);
			return Response.json({
				data: [
					{
						id: cursor ? "msg_old" : "msg_new",
						type: "user",
						text: cursor ? "Older context" : "Newest context",
						time: { created: cursor ? 1 : 2 },
					},
				],
				cursor: cursor ? {} : { next: "older-page" },
			});
		});
		const keys = ["n", "p", "\u001b"];
		const rendered: string[] = [];
		const ui: Partial<ExtensionUIContext> = {
			async custom<T>(
				factory: (
					tui: TUI,
					theme: Theme,
					keybindings: KeybindingsManager,
					done: (result: T) => void,
				) =>
					| (Component & { dispose?(): void })
					| Promise<Component & { dispose?(): void }>,
			): Promise<T> {
				let finish!: (value: T) => void;
				const completed = new Promise<T>((resolve) => {
					finish = resolve;
				});
				const component = await factory(
					{ requestRender() {} } as TUI,
					{ fg: (_color: string, text: string) => text } as Theme,
					{} as KeybindingsManager,
					finish,
				);
				rendered.push(component.render(100).join("\n"));
				component.handleInput?.(keys.shift()!);
				component.dispose?.();
				return completed;
			},
		};
		await viewRemoteHistory(client, context(ui), session, signal);
		expect(cursors).toEqual([null, "older-page", null]);
		expect(rendered[0]).toContain("Newest context");
		expect(rendered[1]).toContain("Older context");
		expect(rendered[2]).toContain("Newest context");
	});
});
