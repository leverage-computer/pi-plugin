import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { exampleSession, SESSION, workspaceFixture } from "./fixture";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of disposals.splice(0).reverse()) await dispose();
});
const proxy = `import os, pty, select, signal, sys, fcntl, termios, struct
pid, master = pty.fork()
if pid == 0:
    os.execvp('node', ['node'] + sys.argv[2:])
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 36, int(sys.argv[1]), 0, 0))
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data: break
            os.write(master, data)
        if master in ready:
            try: data = os.read(master, 65536)
            except OSError: break
            if not data: break
            os.write(sys.stdout.fileno(), data)
finally:
    try: os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError: pass
    os.close(master)
    os.waitpid(pid, 0)
`;
async function terminal(
	columns: number,
	extra?: Parameters<typeof workspaceFixture>[0],
) {
	const f = workspaceFixture(extra);
	disposals.push(() => f.close());
	const directory = await mkdtemp(join(tmpdir(), "pi-workspace-terminal-"));
	disposals.push(() => rm(directory, { recursive: true, force: true }));
	const child = spawn(
		"python3",
		[
			"-u",
			"-c",
			proxy,
			String(columns),
			resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
			"--no-session",
			"--no-skills",
			"--no-prompt-templates",
			"-e",
			resolve("src/index.ts"),
		],
		{
			cwd: directory,
			env: {
				...process.env,
				TERM: "xterm-256color",
				PI_SKIP_VERSION_CHECK: "1",
				// Over SSH, Pi waits longer and reads Escape plus the next key as Alt.
				PI_TUI_ESC_TIMEOUT: "10",
				PI_CODING_AGENT_DIR: directory,
				LEVERAGE_HOST: f.server.url.origin,
				LEVERAGE_WORKSPACE: "test",
				LEVERAGE_TOKEN: "owner",
				LEVERAGE_CONFIG_DIR: directory,
			},
		},
	);
	let output = "";
	child.stdout.on("data", (data) => {
		output += stripVTControlCharacters(String(data));
	});
	child.stderr.on("data", (data) => {
		output += String(data);
	});
	disposals.push(async () => {
		child.stdin.end();
		await new Promise<void>((resolve) => {
			if (child.exitCode !== null) return resolve();
			child.once("close", () => resolve());
		});
	});
	const wait = async (text: string, timeout = 10000) => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (output.includes(text)) return;
			if (child.exitCode !== null) break;
			await Bun.sleep(20);
		}
		throw new Error(`Terminal did not show ${text}: ${output.slice(-4000)}`);
	};
	const key = async (text: string) => {
		output = "";
		child.stdin.write(text);
		await Bun.sleep(80);
	};
	await wait("Standalone · Default model", 30000);
	return { f, wait, key, output: () => output };
}

test("narrow Pi terminal sets the channel with F1 and the model with F2, keeping the draft and creating nothing", async () => {
	const ui = await terminal(64);
	await ui.key("Keep this draft /tmp/attachment.png");
	await ui.key("\x1bOP");
	await ui.wait("Session context");
	await ui.key("general\r");
	await ui.wait("#general · Default model");
	await ui.key("\x1bOQ");
	await ui.wait("Leverage model");
	await ui.key("Hosted\r");
	await ui.wait("Reasoning effort");
	await ui.key("high\r");
	await ui.wait("#general · hosted-model / high");
	// Typing redraws the composer line, which shows the kept draft.
	await ui.key("!");
	await ui.wait("Keep this draft /tmp/attachment.png!");
	expect(ui.f.state.createCount).toBe(0);
	expect(ui.f.requests.some((r) => r.method !== "GET")).toBe(false);
}, 45000);

// Serves these sessions through the native and OpenCode routes a Pi view reads.
function sessionRoutes(
	sessions: ReturnType<typeof exampleSession>[],
	running: string[] = [],
) {
	return (request: Request) => {
		const path = new URL(request.url).pathname;
		if (path === "/api/sessions") return Response.json(sessions);
		if (path.endsWith("/bootstrap"))
			return Response.json({
				session: sessions.find((s) => path.includes(s.id)),
				messages: [],
				version: 0,
				lastCursorIncluded: 0,
				viewerCanWrite: true,
			});
		if (path === "/api/opencode/api/event")
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(
							new TextEncoder().encode(
								`data: ${JSON.stringify({ id: "evt_connected", type: "server.connected", data: {}, location: { directory: "/test" } })}\n\n`,
							),
						);
					},
				}),
				{ headers: { "content-type": "text/event-stream" } },
			);
		if (path.endsWith("/active"))
			return Response.json({
				data: Object.fromEntries(
					running.map((id) => [`ses_${id}`, { type: "running" }]),
				),
			});
		if (path.endsWith("/message"))
			return Response.json({ data: [], cursor: {} });
		if (
			path.endsWith("/inbox") ||
			path.endsWith("/permission") ||
			path.endsWith("/form")
		)
			return Response.json({ data: [] });
		if (path.endsWith("/view")) return new Response(null, { status: 204 });
		if (path.startsWith("/api/opencode/api/session/ses_")) {
			const s = sessions.find((s) => path.includes(s.id))!;
			return Response.json({
				data: {
					id: `ses_${s.id}`,
					projectID: "prj_workspace",
					location: { directory: "/test" },
					title: s.title,
					cost: 0,
					tokens: {
						input: 0,
						output: 0,
						reasoning: 0,
						cache: { read: 0, write: 0 },
					},
					time: { created: 1, updated: 2 },
				},
			});
		}
	};
}

test("a running session shows Pi's working indicator in the composer divider", async () => {
	const session = { ...exampleSession(), title: "Busy session" };
	const ui = await terminal(120, sessionRoutes([session], [session.id]));
	await ui.key("\x1bOR");
	await ui.wait("Leverage sessions");
	await ui.key("Busy session\r");
	await ui.wait(" Working ─");
	expect(ui.output()).toMatch(/── \S Working ─/);
}, 45000);

test("the session selector names each session's place, and switching restores each composer draft", async () => {
	const second = "22222222-2222-4222-8222-222222222222";
	const sessions = [
		{ ...exampleSession(), title: "First session", channelId: "general" },
		{
			...exampleSession(),
			id: second,
			title: "Second session",
			repo: { fullName: "team/project" },
			requestedBranch: "main",
		},
	];
	const ui = await terminal(120, sessionRoutes(sessions));
	await ui.key("\x1bOR");
	await ui.wait("Leverage sessions");
	await ui.wait("First session #general");
	await ui.wait("Second session team/project / main");
	await ui.key("First session\r");
	await ui.wait("• First session");
	await ui.key("First unsent draft /tmp/attachment.png");
	await ui.key("\x1bOR");
	await ui.wait("Leverage sessions");
	await ui.key("Second session\r");
	await ui.wait("• Second session");
	await ui.key("Second unsent draft");
	await ui.key("\x1bOR");
	await ui.wait("Leverage sessions");
	await ui.key("First session\r");
	await ui.wait("• First session");
	// Typing redraws only the composer line, which must hold this session's draft.
	await ui.key("!");
	await ui.wait("First unsent draft /tmp/attachment.png!");
	expect(ui.output()).not.toContain("Second unsent draft");
	await ui.key("\x1bOR");
	await ui.wait("Leverage sessions");
	await ui.key("Second session\r");
	await ui.wait("• Second session");
	await ui.key("!");
	await ui.wait("Second unsent draft!");
	expect(ui.output()).not.toContain("First unsent draft");
	expect(ui.f.state.createCount).toBe(0);
	expect(
		ui.f.requests.some(
			(r) => r.path.includes(SESSION) && r.path.endsWith("/prompt"),
		),
	).toBe(false);
}, 45000);
