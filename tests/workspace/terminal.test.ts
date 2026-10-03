import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { exampleSession, workspaceFixture } from "./fixture";

const disposals: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) {
    await dispose();
  }
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
// Pi reloads a custom theme when its file changes, so rewriting it switches themes.
async function writeTheme(directory: string, base: "light" | "dark") {
  const builtIn = resolve(
    "node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme",
    `${base}.json`,
  );
  const colors = JSON.parse(await readFile(builtIn, "utf8"));
  await mkdir(join(directory, "themes"), { recursive: true });
  await writeFile(
    join(directory, "themes", "probe.json"),
    JSON.stringify({ ...colors, name: "probe" }),
  );
}

async function terminal(columns: number, theme?: "light" | "dark") {
  const f = workspaceFixture();
  disposals.push(() => f.close());
  const directory = await mkdtemp(join(tmpdir(), "pi-workspace-terminal-"));
  disposals.push(() => rm(directory, { recursive: true, force: true }));
  if (theme) {
    await writeTheme(directory, theme);
  }
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
      ...(theme ? ["--use-theme", "probe"] : []),
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
  // Everything Pi wrote, colors included.
  let raw = "";
  child.stdout.on("data", (data) => {
    raw += String(data);
    output += stripVTControlCharacters(String(data));
  });
  child.stderr.on("data", (data) => {
    output += String(data);
  });
  disposals.push(async () => {
    child.stdin.end();
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) {
        return resolve();
      }
      child.once("close", () => resolve());
    });
  });
  const wait = async (text: string, timeout = 10000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (output.includes(text)) {
        return;
      }
      if (child.exitCode !== null) {
        break;
      }
      await Bun.sleep(20);
    }
    throw new Error(`Terminal did not show ${text}: ${output.slice(-4000)}`);
  };
  const key = async (text: string) => {
    output = "";
    child.stdin.write(text);
    await Bun.sleep(80);
  };
  // Pi starts as itself. /leverage new opens a Leverage draft in it.
  // Pi refuses commands until its startup finishes and keeps the text.
  await wait("─", 30000);
  await key("/leverage new");
  const deadline = Date.now() + 30000;
  while (!output.includes("Standalone · Default model")) {
    if (Date.now() > deadline) {
      throw new Error(`Pi did not open a draft: ${output.slice(-4000)}`);
    }
    await key("\r");
    await Bun.sleep(400);
  }
  return { f, wait, key, output: () => output, raw: () => raw, directory };
}

test("the lines above the composer take the new colors when the theme changes", async () => {
  const ui = await terminal(120, "light");
  // The color Pi last set before the draft's model, in output written after `from`.
  const color = (from: number) => {
    const at = ui.raw().lastIndexOf("Default model");
    return at < from
      ? undefined
      : ui
          .raw()
          .slice(from, at)
          .match(/\u001b\[[0-9;]*m/g)
          ?.at(-1);
  };
  const light = color(0);
  expect(light).toBeDefined();
  const from = ui.raw().length;
  await writeTheme(ui.directory, "dark");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && [undefined, light].includes(color(from))) {
    await Bun.sleep(50);
  }
  expect(color(from)).toBeDefined();
  expect(color(from)).not.toBe(light);
}, 45000);

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

test("a running session shows Pi's working indicator in the composer divider", async () => {
  const ui = await terminal(120);
  // Leverage reports a session with a turn in progress as active.
  ui.f.update({ title: "Busy session", status: "active", turnId: "turn_1" });
  await ui.key("\x1bOR");
  await ui.wait("Leverage sessions");
  await ui.key("Busy session\r");
  await ui.wait(" Working ─");
  expect(ui.output()).toMatch(/── \S Working ─/);
}, 45000);

test("the session selector names each session's place, and switching restores each composer draft", async () => {
  const second = "22222222-2222-4222-8222-222222222222";
  const ui = await terminal(120);
  Object.assign(ui.f.session, {
    title: "First session",
    channelId: "general",
  });
  ui.f.sessions.push({
    ...exampleSession(),
    id: second,
    title: "Second session",
    repo: { fullName: "team/project" },
    requestedBranch: "main",
  });
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
  expect(ui.f.frames.some((frame) => frame.type === "session.message")).toBe(
    false,
  );
}, 45000);

test("the session picker shows new sessions live and offers a session's actions", async () => {
  const ui = await terminal(120);
  await ui.key("\x1bOR");
  await ui.wait("Leverage sessions");
  await ui.wait("tab actions");
  const late = "33333333-3333-4333-8333-333333333333";
  ui.f.sessions.push({
    ...exampleSession(),
    id: late,
    title: "Started elsewhere",
  });
  ui.f.publish({ type: "session.list.changed", sessionId: late });
  await ui.wait("Started elsewhere");
  await ui.key("Started elsewhere");
  await ui.key("\t");
  await ui.wait("Rename");
  await ui.wait("Archive");
}, 45000);

test("files, changes and connections open from the session like in the web app", async () => {
  const ui = await terminal(120);
  await ui.key("\x1bOR");
  await ui.wait("Leverage sessions");
  await ui.key("Shared work\r");
  await ui.wait("• Shared work");
  await ui.key("/leverage outputs\r");
  await ui.wait("report.md");
  await ui.wait("logs/");
  await ui.key("report.md\r");
  await ui.wait("All checks pass.");
  await ui.key("\x1b");
  await ui.wait("report.md");
  // Tab saves the highlighted file in the folder Pi runs in.
  await ui.key("report.md\t");
  await ui.wait("Saved");
  expect(await readFile(join(ui.directory, "report.md"), "utf8")).toContain(
    "All checks pass.",
  );
  await ui.key("\x1b");
  await ui.key("/leverage changes\r");
  await ui.wait("Pull request #42 (open)");
  await ui.wait("tests/checkout.test.ts  +1 -1");
  await ui.key("\x1b");
  await ui.key("/leverage connectors\r");
  await ui.wait("Linear");
  await ui.wait("12 tools");
}, 60000);

test("Pi leaves out the channels excluded in Leverage Settings and reads the choice each time a list opens", async () => {
  const ui = await terminal(120);
  ui.f.channels.push({ id: "private", name: "private", kind: "channel" });
  ui.f.sessions.push({
    ...exampleSession(),
    id: "22222222-2222-4222-8222-222222222222",
    title: "Private plans",
    channelId: "private",
  });
  // With no choice saved, every channel and its sessions are listed.
  await ui.key("\x1bOR");
  await ui.wait("Private plans #private");
  await ui.key("\x1b");
  await ui.key("\x1bOP");
  await ui.wait("#private");
  await ui.key("\x1b");
  ui.f.state.preferences = { piExcludedChannelIds: ["private"] };
  await ui.key("\x1bOR");
  await ui.wait("Shared work");
  await ui.key("Private plans");
  await ui.wait("No matching items");
  await ui.key("\x1b");
  await ui.key("\x1bOP");
  await ui.wait("#general");
  await ui.key("private");
  await ui.wait("No matching items");
}, 45000);

test("Pi lists standalone and shared sessions only when Leverage Settings shows them", async () => {
  const ui = await terminal(120);
  ui.f.sessions.push(
    {
      ...exampleSession(),
      id: "22222222-2222-4222-8222-222222222222",
      title: "Bob's private notes",
      channelId: "general",
      ownerId: "bob",
      visibility: "private",
    },
    {
      ...exampleSession(),
      id: "33333333-3333-4333-8333-333333333333",
      title: "Bob's channel work",
      channelId: "general",
      ownerId: "bob",
      visibility: "channel",
    },
  );
  // With no choice saved, every session is listed.
  await ui.key("\x1bOR");
  await ui.wait("Shared work Standalone");
  await ui.wait("Bob's private notes #general");
  await ui.wait("Bob's channel work #general");
  await ui.key("\x1b");
  ui.f.state.preferences = { piShowStandaloneSessions: false };
  await ui.key("\x1bOR");
  await ui.wait("Bob's private notes #general");
  await ui.key("Shared work");
  await ui.wait("No matching items");
  await ui.key("\x1b");
  // A session someone else owns stays listed when its channel shows it.
  ui.f.state.preferences = { piShowSharedSessions: false };
  await ui.key("\x1bOR");
  await ui.wait("Shared work Standalone");
  await ui.wait("Bob's channel work #general");
  await ui.key("private notes");
  await ui.wait("No matching items");
}, 45000);
