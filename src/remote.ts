import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { type LeverageConnection, SessionClient } from "./api";

export type RemoteConnection = LeverageConnection & { sessionId: string };

export function createRemoteBashOperations(
	getRemote: () => Pick<RemoteWorkspace, "exec">,
): BashOperations {
	return {
		async exec(command, _cwd, { onData, signal, timeout }) {
			const decoder = new TextDecoder();
			let bytes = 0;
			let lines = 0;
			let truncated = false;
			const forward = (text: string) => {
				if (!text) return;
				let data = Buffer.from(text, "utf8");
				let end = Math.min(data.length, Math.max(0, 32 * 1024 - bytes));
				while (end > 0 && end < data.length && (data[end] & 0xc0) === 0x80)
					end--;
				for (let index = 0; index < end; index++) {
					if (lines >= 1000) {
						end = index;
						break;
					}
					if (data[index] === 10) lines++;
				}
				truncated ||= end < data.length;
				data = data.subarray(0, end);
				bytes += data.length;
				if (data.length) onData(data);
			};
			try {
				const result = await getRemote().exec(command, {
					signal,
					timeout,
					maxBytes: DEFAULT_MAX_BYTES,
					onData: (chunk) => forward(decoder.decode(chunk, { stream: true })),
				});
				return { exitCode: result.exitCode };
			} finally {
				forward(decoder.decode());
				if (truncated)
					onData(
						Buffer.from(
							"\n[Output truncated. Redirect larger output to a remote file.]\n",
						),
					);
			}
		},
	};
}

type ExecOptions = {
	signal?: AbortSignal;
	/** Seconds, including connection setup. */
	timeout?: number;
	onData?: (chunk: Buffer) => void;
	maxBytes?: number;
};

type ExecResult = { exitCode: number; output: Buffer };
const SIZE = { cols: 120, rows: 40 };
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function quoted(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function failure(reason: unknown): Error {
	return reason instanceof Error
		? reason
		: new Error("Remote command cancelled");
}

function input(bytes: Uint8Array): Buffer {
	const frame = Buffer.allocUnsafe(5 + bytes.byteLength);
	frame[0] = 1;
	frame.writeUInt16BE(SIZE.cols, 1);
	frame.writeUInt16BE(SIZE.rows, 3);
	frame.set(bytes, 5);
	return frame;
}

// The short bootstrap disables terminal translation before it accepts a large command.
function bootstrap(nonce: string): string {
	const program = `import json, os, signal, subprocess, sys, tempfile
script = None
def stop(signum, frame):
    if script is not None:
        try:
            os.unlink(script)
        except FileNotFoundError:
            pass
    os.killpg(os.getpgrp(), signal.SIGKILL)
signal.signal(signal.SIGHUP, stop)
signal.signal(signal.SIGTERM, stop)
sys.stdout.buffer.write(b'\\x1e${nonce}:ready\\x1f')
sys.stdout.buffer.flush()
request = json.loads(sys.stdin.buffer.readline())
code = 1
try:
    with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', prefix='leverage-pi-', suffix='.sh', delete=False) as file:
        script = file.name
        file.write(request['command'])
    child = subprocess.Popen(['bash', script], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    while True:
        chunk = os.read(child.stdout.fileno(), 65536)
        if not chunk:
            break
        sys.stdout.buffer.write(chunk)
        sys.stdout.buffer.flush()
    code = child.wait()
    if code < 0:
        code = 128 - code
except Exception as error:
    sys.stdout.write(str(error) + '\\n')
finally:
    if script is not None:
        os.unlink(script)
sys.stdout.buffer.write(b'\\x1e${nonce}:exit:' + str(code).encode() + b'\\x1f')
sys.stdout.buffer.flush()
`;
	return `stty raw -echo && exec python3 -u -c ${quoted(program)}\n`;
}

/** Runs manual commands through the session's public terminal API. */
export class RemoteWorkspace {
	private readonly api: SessionClient;
	private readonly ownsApi: boolean;
	private readonly sessionId: string;
	private readonly cwd?: string;
	private readonly running = new Set<AbortController>();
	private closed = false;

	constructor(connection: RemoteConnection, api?: SessionClient) {
		if (!connection.sessionId) {
			throw new Error("A Leverage session is required");
		}
		this.api = api ?? new SessionClient(connection);
		this.ownsApi = api === undefined;
		this.sessionId = connection.sessionId.startsWith("ses_")
			? connection.sessionId
			: `ses_${connection.sessionId}`;
		this.cwd = connection.cwd;
	}

	async workingDirectory(): Promise<string> {
		const result = await this.exec("pwd -P", { maxBytes: 8192 });
		const cwd = result.output.toString("utf8").replace(/\n$/, "");
		if (result.exitCode !== 0 || !cwd.startsWith("/") || /\p{Cc}/u.test(cwd)) {
			throw new Error("The remote working directory could not be read");
		}
		return cwd;
	}

	async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
		if (this.closed) throw new Error("The remote workspace is closed");
		if (options.signal?.aborted) throw failure(options.signal.reason);
		const timeout = options.timeout ?? 120;
		const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		if (!Number.isFinite(timeout) || timeout <= 0) {
			throw new Error("Remote command timeout must be positive");
		}
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
			throw new Error("Remote output limit must be a non-negative integer");
		}
		const script = this.cwd
			? `cd -- ${quoted(this.cwd)} || exit $?\n${command}`
			: command;
		const payload = Buffer.from(`${JSON.stringify({ command: script })}\n`);
		if (payload.byteLength > MAX_COMMAND_BYTES) {
			throw new Error("Remote command exceeds the 16 MiB input limit");
		}
		const controller = new AbortController();
		const abort = () => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		const timer = setTimeout(
			() =>
				controller.abort(
					new Error(`Remote command timed out after ${timeout} seconds`),
				),
			timeout * 1000,
		);
		this.running.add(controller);
		let ptyId: string | undefined;
		try {
			const created = record(
				await this.api.json(
					`/api/experimental/session/${encodeURIComponent(this.sessionId)}/terminal`,
					"POST",
					controller.signal,
					{ title: "Pi tool", size: SIZE },
					timeout * 1000,
				),
			);
			const info = record(created.data);
			if (typeof info.id !== "string" || !info.id.startsWith("pty_")) {
				throw new Error("Leverage returned an invalid terminal");
			}
			ptyId = info.id;
			const connected = record(
				await this.api.json(
					`/api/experimental/persistent-pty/${encodeURIComponent(ptyId)}/connect-token`,
					"POST",
					controller.signal,
				),
			);
			const ticket = record(connected.data).ticket;
			if (typeof ticket !== "string" || !ticket) {
				throw new Error("Leverage returned an invalid terminal ticket");
			}
			const url = this.api.url(
				`/api/experimental/persistent-pty/${encodeURIComponent(ptyId)}/connect`,
			);
			url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
			url.searchParams.set("ticket", ticket);
			return await this.connectedCommand(
				url,
				payload,
				controller.signal,
				maxBytes,
				options.onData,
			);
		} finally {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (ptyId) {
				await this.api
					.json(
						`/api/experimental/persistent-pty/${encodeURIComponent(ptyId)}`,
						"DELETE",
						AbortSignal.timeout(5000),
					)
					.catch(() => undefined);
			}
			this.running.delete(controller);
			if (this.closed && this.ownsApi && this.running.size === 0)
				this.api.close();
		}
	}

	close(): void {
		this.closed = true;
		for (const controller of this.running) {
			controller.abort(new Error("The remote workspace was closed"));
		}
		if (this.ownsApi && this.running.size === 0) this.api.close();
	}

	private connectedCommand(
		url: URL,
		payload: Buffer,
		signal: AbortSignal,
		maxBytes: number,
		onData?: (chunk: Buffer) => void,
	): Promise<ExecResult> {
		if (signal.aborted) return Promise.reject(failure(signal.reason));
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(url);
			socket.binaryType = "arraybuffer";
			const nonce = randomUUID().replaceAll("-", "");
			const ready = Buffer.from(`\x1e${nonce}:ready\x1f`);
			const ended = Buffer.from(`\x1e${nonce}:exit:`);
			let attached = false;
			let started = false;
			let settled = false;
			let pending = Buffer.alloc(0);
			let size = 0;
			const chunks: Buffer[] = [];
			const finish = (error?: Error, exitCode = 0) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				socket.close();
				if (error) reject(error);
				else resolve({ exitCode, output: Buffer.concat(chunks, size) });
			};
			const abort = () => finish(failure(signal.reason));
			signal.addEventListener("abort", abort, { once: true });
			const emit = (chunk: Buffer) => {
				if (!chunk.length) return;
				if (size + chunk.length > maxBytes) {
					throw new Error(`Remote output exceeds the ${maxBytes} byte limit`);
				}
				size += chunk.length;
				chunks.push(chunk);
				onData?.(chunk);
			};
			const receive = (bytes: Buffer) => {
				pending = Buffer.concat([pending, bytes]);
				if (!started) {
					const marker = pending.indexOf(ready);
					if (marker < 0) {
						pending = pending.subarray(
							Math.max(0, pending.length - ready.length + 1),
						);
						return;
					}
					started = true;
					pending = pending.subarray(marker + ready.length);
					for (let offset = 0; offset < payload.length; offset += 65536) {
						socket.send(input(payload.subarray(offset, offset + 65536)));
					}
				}
				const marker = pending.indexOf(ended);
				if (marker < 0) {
					let held = Math.min(pending.length, ended.length - 1);
					while (
						held > 0 &&
						!pending
							.subarray(pending.length - held)
							.equals(ended.subarray(0, held))
					)
						held--;
					const available = pending.length - held;
					emit(pending.subarray(0, available));
					pending = pending.subarray(available);
					return;
				}
				emit(pending.subarray(0, marker));
				pending = pending.subarray(marker);
				const end = pending.indexOf(0x1f, ended.length);
				if (end < 0) {
					if (pending.length > ended.length + 12) {
						throw new Error(
							"The remote command returned an invalid exit status",
						);
					}
					return;
				}
				const code = pending.subarray(ended.length, end).toString("ascii");
				if (!/^\d{1,3}$/.test(code) || Number(code) > 255) {
					throw new Error("The remote command returned an invalid exit status");
				}
				finish(undefined, Number(code));
			};
			socket.addEventListener("message", (event) => {
				if (settled) return;
				try {
					if (typeof event.data === "string") {
						const frame = record(JSON.parse(event.data));
						if (frame.type === "attached") {
							if (
								attached ||
								frame.inputProtocol !== 1 ||
								frame.role !== "controller"
							) {
								throw new Error(
									"Leverage returned an unsupported terminal protocol",
								);
							}
							attached = true;
							socket.send(input(Buffer.from(bootstrap(nonce))));
						} else if (frame.type === "exited") {
							throw new Error(
								"The remote terminal exited before the command completed",
							);
						}
					} else if (event.data instanceof ArrayBuffer) {
						receive(Buffer.from(event.data));
					} else {
						throw new Error("Leverage returned invalid terminal output");
					}
				} catch (error) {
					finish(failure(error));
				}
			});
			socket.addEventListener("error", () =>
				finish(new Error("The remote terminal connection failed")),
			);
			socket.addEventListener("close", () =>
				finish(
					new Error(
						"The remote terminal disconnected before the command completed",
					),
				),
			);
		});
	}
}
