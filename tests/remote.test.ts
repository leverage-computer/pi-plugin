import { afterEach, describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { Buffer } from "node:buffer";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersistentPty } from "@opencode/schema";
import type { ServerWebSocket } from "bun";
import { SessionClient } from "../src/api";
import { createRemoteBashOperations, RemoteWorkspace } from "../src/remote";

// A real pseudo-terminal exercises shell startup, raw bytes, and the input size limit.
const PTY_PROXY = `import os, pty, select, signal, sys
pid, master = pty.fork()
if pid == 0:
    os.execvp('bash', ['bash', '--noprofile', '--norc'])
try:
    while True:
        ready, _, _ = select.select([master, sys.stdin.fileno()], [], [])
        if sys.stdin.fileno() in ready:
            data = os.read(sys.stdin.fileno(), 65536)
            if not data:
                break
            while data:
                written = os.write(master, data)
                data = data[written:]
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
finally:
    try:
        os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    os.close(master)
    os.waitpid(pid, 0)
`;

type FixtureOptions = {
	cwd?: string;
	denied?: boolean;
	invalidTicket?: boolean;
	disconnect?: boolean;
	fragment?: boolean;
	expired?: boolean;
	noRefresh?: boolean;
	failedRefresh?: boolean;
	alwaysUnauthorized?: boolean;
	refreshGate?: Promise<void>;
};

type SocketData = { id: string; process?: ChildProcessWithoutNullStreams };

function serverFixture(options: FixtureOptions = {}) {
	const requests: Array<{
		method: string;
		path: string;
		authorization: string | null;
		workspace: string | null;
	}> = [];
	const refreshes: unknown[] = [];
	let refreshed: () => void = () => {};
	const refreshStarted = new Promise<void>((resolve) => {
		refreshed = resolve;
	});
	const deleted: string[] = [];
	const processes: ChildProcessWithoutNullStreams[] = [];
	const finished: Promise<void>[] = [];
	const sockets = new Set<ServerWebSocket<SocketData>>();
	let sequence = 0;
	const server = Bun.serve<SocketData>({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request, server) {
			const url = new URL(request.url);
			requests.push({
				method: request.method,
				path: url.pathname,
				authorization: request.headers.get("authorization"),
				workspace: request.headers.get("x-leverage-workspace"),
			});
			if (url.pathname === "/api/cli/auth/refresh") {
				refreshes.push(await request.json());
				refreshed();
				await options.refreshGate;
				return options.failedRefresh
					? Response.json({ error: "invalid_refresh_token" }, { status: 401 })
					: Response.json({ access_token: "lev_at_refreshed" });
			}
			if (!url.pathname.startsWith("/api/opencode/api/experimental/"))
				return new Response(null, { status: 404 });
			if (url.pathname.endsWith("/connect")) {
				if (options.disconnect) return new Response(null, { status: 503 });
				if (url.searchParams.get("ticket") !== "test-ticket")
					return new Response(null, { status: 403 });
				if (
					server.upgrade(request, {
						data: { id: url.pathname.split("/").at(-2) ?? "" },
					})
				)
					return;
				return new Response(null, { status: 400 });
			}
			if (
				options.expired &&
				(options.alwaysUnauthorized ||
					request.headers.get("authorization") !== "Bearer lev_at_refreshed")
			) {
				return Response.json({ error: "expired" }, { status: 401 });
			}
			if (request.headers.get("x-leverage-workspace") !== "test-workspace")
				return new Response(null, { status: 403 });
			if (options.denied)
				return Response.json({ message: "read-only session" }, { status: 403 });
			if (request.method === "DELETE") {
				deleted.push(url.pathname.split("/").at(-1) ?? "");
				return new Response(null, { status: 204 });
			}
			if (url.pathname.endsWith("/connect-token")) {
				if (request.headers.get("x-opencode-ticket") !== "1")
					return new Response(null, { status: 403 });
				return Response.json({
					data: options.invalidTicket ? {} : { ticket: "test-ticket" },
				});
			}
			if (url.pathname.endsWith("/terminal")) {
				const info: typeof PersistentPty.Info.Encoded = {
					id: `pty_${++sequence}`,
					sessionID: "ses_test",
					title: "Pi tool",
					command: "/bin/sh",
					args: [],
					cwd: "",
					status: "running",
					pid: 0,
					foregroundProcess: null,
					size: { cols: 120, rows: 40 },
					output: { head: 0, tail: 0 },
				};
				return Response.json({ data: info });
			}
			return new Response(null, { status: 404 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				const process = spawn("python3", ["-u", "-c", PTY_PROXY]);
				processes.push(process);
				socket.data.process = process;
				finished.push(
					new Promise((resolve) => process.once("close", () => resolve())),
				);
				process.stdout.on("data", (chunk: Buffer) => {
					if (options.fragment) {
						for (const byte of chunk) socket.send(Buffer.from([byte]));
					} else {
						socket.send(chunk);
					}
				});
				process.on("close", () => socket.close());
				socket.send(
					JSON.stringify({
						type: "attached",
						inputProtocol: 1,
						role: "controller",
					}),
				);
				socket.send(JSON.stringify({ type: "replay_complete" }));
			},
			message(socket, message) {
				if (typeof message === "string")
					throw new Error("Input must use binary frames");
				const frame = Buffer.from(message);
				if (
					frame[0] !== 1 ||
					frame.readUInt16BE(1) === 0 ||
					frame.readUInt16BE(3) === 0
				) {
					throw new Error("Invalid input frame");
				}
				socket.data.process?.stdin.write(frame.subarray(5));
			},
			close(socket) {
				socket.data.process?.stdin.end();
			},
		},
	});
	const client = new SessionClient({
		host: server.url.origin,
		workspace: "test-workspace",
		token: "lev_at_test",
		...(options.noRefresh ? {} : { refreshToken: "lev_rt_test" }),
	});
	const remote = new RemoteWorkspace(
		client,
		"11111111-1111-4111-8111-111111111111",
		options.cwd,
	);
	return {
		server,
		remote,
		requests,
		refreshes,
		refreshStarted,
		deleted,
		async close() {
			remote.close();
			client.close();
			for (const process of processes) process.stdin.end();
			for (const socket of sockets) socket.terminate();
			await server.stop(true);
			await Promise.all(finished);
		},
	};
}

const fixtures: ReturnType<typeof serverFixture>[] = [];
function fixture(options?: FixtureOptions) {
	const instance = serverFixture(options);
	fixtures.push(instance);
	return instance;
}

afterEach(async () => {
	for (const server of fixtures.splice(0)) await server.close();
});

describe("remote tool transport", () => {
	test("manual shell output stays bounded and cancellation stops remote execution", async () => {
		const { remote } = fixture();
		const operations = createRemoteBashOperations(() => remote);
		const chunks: Buffer[] = [];
		const result = await operations.exec(
			"python3 -c 'for i in range(10000): print(str(i) + chr(233)*100)'",
			"/local",
			{ onData: (chunk) => chunks.push(chunk) },
		);
		const output = Buffer.concat(chunks);
		expect(result.exitCode).toBe(0);
		expect(output.toString("utf8")).toContain("Output truncated");
		expect(output.byteLength).toBeLessThan(50 * 1024);
		expect(output.toString("utf8").split("\n").length).toBeLessThan(2000);
		const controller = new AbortController();
		await rejects(
			operations.exec("printf started; sleep 60", "/local", {
				signal: controller.signal,
				onData: () => controller.abort(),
			}),
			/aborted/,
		);
		await rejects(
			createRemoteBashOperations(() => {
				throw new Error("disconnected");
			}).exec("pwd", "/local", { onData() {} }),
			/disconnected/,
		);
	});
	test("runs a real shell, preserves binary output across split markers, and cleans up", async () => {
		const { remote, requests, deleted } = fixture({ fragment: true });
		const streamed: Buffer[] = [];
		const result = await remote.exec(
			"python3 -c 'import sys; sys.stdout.buffer.write(bytes([0,10,13,255,195,169]))'\nexit 7",
			{
				onData: (chunk) => streamed.push(chunk),
			},
		);
		expect(result.exitCode).toBe(7);
		expect(result.output).toEqual(Buffer.from([0, 10, 13, 255, 195, 169]));
		expect(Buffer.concat(streamed).equals(result.output)).toBe(true);
		expect(deleted).toEqual(["pty_1"]);
		const authorized = requests.filter(
			(request) => !request.path.endsWith("/connect"),
		);
		expect(
			authorized.every(
				(request) =>
					request.authorization === "Bearer lev_at_test" &&
					request.workspace === "test-workspace",
			),
		).toBe(true);
		expect(authorized[0]?.path).toBe(
			"/api/opencode/api/experimental/session/ses_11111111-1111-4111-8111-111111111111/terminal",
		);
	});

	test("renews an expired access token once for concurrent commands", async () => {
		let release: () => void = () => {};
		const refreshGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { remote, refreshStarted, refreshes, requests } = fixture({
			expired: true,
			refreshGate,
		});
		const commands = [remote.exec("printf one"), remote.exec("printf two")];
		await refreshStarted;
		release();
		const results = await Promise.all(commands);
		expect(results.map((result) => result.output.toString())).toEqual([
			"one",
			"two",
		]);
		expect(refreshes).toEqual([{ refresh_token: "lev_rt_test" }]);
		expect(
			requests.filter(
				(request) =>
					request.path.endsWith("/terminal") &&
					request.authorization === "Bearer lev_at_refreshed",
			),
		).toHaveLength(2);
		expect(
			requests
				.filter((request) => request.path === "/api/cli/auth/refresh")
				.every((request) => request.authorization === null),
		).toBe(true);
	});

	test("bounds authentication retries when credentials cannot renew access", async () => {
		const missing = fixture({ expired: true, noRefresh: true });
		const withoutRefresh = await missing.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((withoutRefresh as Error).message).toContain("401");
		expect(missing.refreshes).toHaveLength(0);
		expect(
			missing.requests.filter((request) => request.path.endsWith("/terminal")),
		).toHaveLength(1);
		const failed = fixture({ expired: true, failedRefresh: true });
		const failure = await failed.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((failure as Error).message).toContain("token refresh failed (401)");
		expect(failed.refreshes).toHaveLength(1);
		expect(
			failed.requests.filter((request) => request.path.endsWith("/terminal")),
		).toHaveLength(1);
		const refused = fixture({ expired: true, alwaysUnauthorized: true });
		const rejection = await refused.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((rejection as Error).message).toContain("401");
		expect(refused.refreshes).toHaveLength(1);
		expect(
			refused.requests.filter((request) => request.path.endsWith("/terminal")),
		).toHaveLength(2);
	});

	test("close cancels token renewal without starting a command", async () => {
		let release: () => void = () => {};
		const refreshGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { remote, refreshStarted, requests } = fixture({
			expired: true,
			refreshGate,
		});
		const command = remote
			.exec("printf must-not-run")
			.catch((error: unknown) => error);
		await refreshStarted;
		remote.close();
		try {
			const error = await command;
			expect((error as Error).message).toContain("closed");
			expect(
				requests.filter((request) => request.path.endsWith("/terminal")),
			).toHaveLength(1);
		} finally {
			release();
		}
	});

	test("accepts a command larger than terminal canonical input and process argv limits", async () => {
		const { remote } = fixture();
		const content = "x".repeat(300_000);
		const result = await remote.exec(`printf '%s' '${content}' | wc -c`);
		expect(result.exitCode).toBe(0);
		expect(result.output.toString().trim()).toBe("300000");
	});

	test("streams before completion and cancels the running terminal", async () => {
		const { remote, deleted } = fixture();
		const controller = new AbortController();
		let streamed = "";
		const error = await remote
			.exec("printf 'started'; sleep 30", {
				signal: controller.signal,
				onData: (chunk) => {
					streamed += chunk.toString();
					controller.abort(new Error("user cancelled"));
				},
			})
			.catch((error: unknown) => error);
		expect(streamed).toBe("started");
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("user cancelled");
		expect(deleted).toEqual(["pty_1"]);
	});

	test("enforces time and output bounds and never retries a command", async () => {
		const { remote, requests, deleted } = fixture();
		const tooLarge = await remote
			.exec("printf 'too much'", { maxBytes: 3 })
			.catch((error: unknown) => error);
		expect((tooLarge as Error).message).toContain("3 byte limit");
		const timedOut = await remote
			.exec("sleep 30", { timeout: 0.2 })
			.catch((error: unknown) => error);
		expect((timedOut as Error).message).toContain("timed out");
		expect(
			requests.filter((request) => request.path.endsWith("/terminal")),
		).toHaveLength(2);
		expect(deleted).toEqual(["pty_1", "pty_2"]);
	});

	test("reports permission, ticket, and connection failures", async () => {
		const denied = fixture({ denied: true });
		const permissionError = await denied.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((permissionError as Error).message).toContain("403");
		expect(denied.deleted).toEqual([]);
		expect(denied.refreshes).toHaveLength(0);
		const invalid = fixture({ invalidTicket: true });
		const ticketError = await invalid.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((ticketError as Error).message).toContain("invalid terminal ticket");
		expect(invalid.deleted).toEqual(["pty_1"]);
		const disconnected = fixture({ disconnect: true });
		const connectionError = await disconnected.remote
			.exec("true")
			.catch((error: unknown) => error);
		expect((connectionError as Error).message).toContain("connection failed");
		expect(disconnected.deleted).toEqual(["pty_1"]);
	});

	test("close cancels work and prevents later commands", async () => {
		const { remote, deleted } = fixture();
		const running = remote.exec("sleep 30");
		setTimeout(() => remote.close(), 100);
		const error = await running.catch((error: unknown) => error);
		expect((error as Error).message).toContain("closed");
		expect(deleted).toEqual(["pty_1"]);
		const later = await remote.exec("true").catch((error: unknown) => error);
		expect((later as Error).message).toContain("closed");
	});

	test("runs commands in a remote directory whose name needs shell quoting", async () => {
		const quoted = await mkdtemp(join(tmpdir(), "pi-'$(printf injected)-"));
		try {
			const { remote } = fixture({ cwd: quoted });
			const result = await remote.exec("pwd -P");
			expect(result.output.toString()).toBe(`${quoted}\n`);
		} finally {
			await rm(quoted, { recursive: true });
		}
	});
});
