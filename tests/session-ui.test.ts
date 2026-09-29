import { afterEach, describe, expect, test } from "bun:test";
import type {
	ExtensionContext,
	ExtensionUIContext,
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { SessionClient, type SessionInfo } from "../src/api";
import { viewRemoteHistory } from "../src/session-ui";

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

describe("Leverage history pages", () => {
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
					{
						fg: (_color: string, text: string) => text,
						bg: (_color: string, text: string) => text,
						bold: (text: string) => text,
						italic: (text: string) => text,
					} as Theme,
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
