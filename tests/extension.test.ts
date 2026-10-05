import { afterEach, describe, expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  createAgentSession,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  type ExtensionActions,
  type ExtensionCommandContextActions,
  ExtensionRunner,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { HISTORY_ENTRY, sessionLink } from "../src/session";
import {
  eventually,
  exampleSession,
  SESSION,
  workspaceFixture,
} from "./workspace/fixture";

// Terminal widgets and history rows draw with the active Pi theme.
initTheme("dark", false);
const directories: string[] = [];
const disposals: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) {
    await dispose();
  }
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "pi-extension-"));
  directories.push(directory);
  return directory;
}

function models(directory: string) {
  return ModelRuntime.create({
    authPath: join(directory, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(directory, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
    credentials: {
      read: async () => undefined,
      list: async () => [],
      modify: async (_provider, update) => update(undefined),
      delete: async () => {},
    },
  });
}

async function load(
  options: {
    manager?: SessionManager;
    onPrompt?: () => void;
    sendUserMessage?: ExtensionActions["sendUserMessage"];
    activeTools?: (tools: string[]) => void;
  } = {},
) {
  const directory = options.manager?.getCwd() ?? temporaryDirectory();
  const manager = options.manager ?? SessionManager.inMemory(directory);
  const loaded = await discoverAndLoadExtensions(
    [resolve(import.meta.dir, "..")],
    directory,
    directory,
  );
  expect(loaded.errors).toEqual([]);
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    directory,
    manager,
    new ModelRegistry(await models(directory)),
  );
  runner.bindCore(
    {
      ...loaded.runtime,
      appendEntry(type, data) {
        manager.appendCustomEntry(type, data);
      },
      setSessionName(name) {
        manager.appendSessionInfo(name);
      },
      getSessionName: () => manager.getSessionName(),
      setActiveTools(names) {
        options.activeTools?.(names);
      },
      getActiveTools: () => [],
      sendMessage() {
        options.onPrompt?.();
      },
      sendUserMessage(content, settings) {
        if (options.sendUserMessage) {
          options.sendUserMessage(content, settings);
        } else {
          options.onPrompt?.();
        }
      },
    },
    {
      getModel: () => undefined,
      getScopedModels: () => [],
      isIdle: () => true,
      isProjectTrusted: () => true,
      getSignal: () => undefined,
      abort() {},
      hasPendingMessages: () => false,
      shutdown() {},
      getContextUsage: () => undefined,
      compact() {},
      getSystemPrompt: () => "",
    },
  );
  disposals.push(async () => {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  });
  return runner;
}

// A local Leverage for one test. Pi reads the device token from the environment.
function leverage(extra?: Parameters<typeof workspaceFixture>[0]) {
  const f = workspaceFixture(extra);
  const previousToken = process.env.LEVERAGE_TOKEN;
  const previousConfig = process.env.LEVERAGE_CONFIG_DIR;
  // The fixture treats the token as the user, and the owner can write.
  process.env.LEVERAGE_TOKEN = "owner";
  // Remembered model picks stay in a scratch folder, not the real login's.
  process.env.LEVERAGE_CONFIG_DIR = temporaryDirectory();
  disposals.push(async () => {
    if (previousToken === undefined) {
      delete process.env.LEVERAGE_TOKEN;
    } else {
      process.env.LEVERAGE_TOKEN = previousToken;
    }
    if (previousConfig === undefined) {
      delete process.env.LEVERAGE_CONFIG_DIR;
    } else {
      process.env.LEVERAGE_CONFIG_DIR = previousConfig;
    }
    await f.close();
  });
  // The frames of one type that Pi sent on the workspace socket.
  const sent = (type: string) => f.frames.filter((one) => one.type === type);
  return {
    ...f,
    sent,
    configure(runner: ExtensionRunner, sessionId?: string) {
      runner.setFlagValue("leverage-host", f.server.url.origin);
      runner.setFlagValue("leverage-workspace", "test");
      if (sessionId) {
        runner.setFlagValue("leverage-session", sessionId);
      }
    },
    // Leverage refuses the message numbered `count` with an error frame.
    async refuse(count: number, message: string) {
      await eventually(() => sent("session.message").length >= count);
      f.publish({
        type: "error",
        message,
        clientRequestId: sent("session.message")[count - 1]?.clientRequestId,
      });
    },
  };
}

function commandActions(
  runner: ExtensionRunner,
  overrides: Partial<ExtensionCommandContextActions> = {},
) {
  runner.bindCommandContext({
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
    fork: async () => ({ cancelled: false }),
    navigateTree: async () => ({ cancelled: false }),
    switchSession: async () => ({ cancelled: false }),
    reload: async () => {},
    ...overrides,
  });
}

async function command(runner: ExtensionRunner, text: string) {
  const handler = runner.getCommand("leverage");
  if (!handler) {
    throw new Error("Missing Leverage command");
  }
  await handler.handler(text, runner.createCommandContext());
}

function transcript(runner: ExtensionRunner) {
  const renderer = runner.getEntryRenderer(HISTORY_ENTRY);
  if (!renderer) {
    throw new Error("Missing shared history renderer");
  }
  return stripVTControlCharacters(
    runner
      .createContext()
      .sessionManager.getBranch()
      .flatMap((entry) =>
        entry.type === "custom" && entry.customType === HISTORY_ENTRY
          ? (renderer(
              entry,
              { expanded: false },
              runner.getUIContext().theme,
            )?.render(120) ?? [])
          : [],
      )
      .join("\n"),
  );
}

function historyRows(runner: ExtensionRunner) {
  return runner
    .createContext()
    .sessionManager.getBranch()
    .filter(
      (entry) => entry.type === "custom" && entry.customType === HISTORY_ENTRY,
    );
}

describe("Pi hosted frontend", () => {
  test("opens history in chronological chat order", async () => {
    const f = leverage();
    f.emit("user", { content: "The earlier message" });
    f.emit("user", { content: "The later message" });
    // The transcript position orders rows, whatever order the server lists them in.
    f.events.get(SESSION)?.reverse();
    const runner = await load();
    f.configure(runner, SESSION);
    await runner.emit({ type: "session_start", reason: "startup" });
    const content = transcript(runner);
    expect(content).toContain("The later message");
    expect(content.indexOf("The earlier message")).toBeLessThan(
      content.indexOf("The later message"),
    );
  });

  test("loads through Pi, disables local tools, and keeps disconnected input handled", async () => {
    const f = leverage(() =>
      Response.json({ error: "Access denied" }, { status: 403 }),
    );
    const toolSelections: string[][] = [];
    const runner = await load({
      activeTools: (names) => toolSelections.push(names),
    });
    f.configure(runner, SESSION);
    const notices: string[] = [];
    runner.setUIContext({
      ...runner.getUIContext(),
      notify: (message) => {
        notices.push(message);
      },
    });
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(toolSelections).toEqual([[]]);
    expect(
      await runner.emitInput(
        "Read the local secrets",
        undefined,
        "interactive",
      ),
    ).toEqual({ action: "handled" });
    expect(notices.join("\n")).toContain("403");
    expect(f.requests.map((request) => request.path)).toEqual([
      `/api/sessions/${SESSION}/bootstrap`,
    ]);
    expect(f.frames).toEqual([]);
    expect(runner.createContext().sessionManager.getBranch()).toEqual([]);
  });

  test("manual shell commands in a Leverage view cannot fall back to the local machine", async () => {
    const f = leverage(() =>
      Response.json({ error: "Access denied" }, { status: 403 }),
    );
    const runner = await load();
    f.configure(runner, SESSION);
    runner.setUIContext({ ...runner.getUIContext(), notify: () => {} });
    await runner.emit({ type: "session_start", reason: "startup" });
    const directory = runner.createContext().cwd;
    const sentinel = join(directory, "should-not-exist");
    const shell = `touch '${sentinel}'`;
    const result = await runner.emitUserBash({
      type: "user_bash",
      command: shell,
      cwd: directory,
      excludeFromContext: false,
    });
    if (!result?.operations) {
      throw new Error("Missing remote shell operations");
    }
    await rejects(
      result.operations.exec(shell, directory, { onData() {} }),
      /leverage/i,
    );
    expect(existsSync(sentinel)).toBe(false);
  });

  test("the published AgentSession sends prompts and images without local model authentication or execution, including a refused send", async () => {
    const f = leverage();
    const directory = temporaryDirectory();
    const settingsManager = SettingsManager.inMemory();
    const modelRuntime = await models(directory);
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager,
      additionalExtensionPaths: [resolve(import.meta.dir, "..")],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(directory),
      settingsManager,
    });
    f.configure(session.extensionRunner, SESSION);
    const notices: string[] = [];
    const events: string[] = [];
    session.subscribe((message) => {
      events.push(message.type);
    });
    disposals.push(async () => {
      await session.extensionRunner.emit({
        type: "session_shutdown",
        reason: "quit",
      });
      session.dispose();
    });
    await session.bindExtensions({
      mode: "print",
      uiContext: {
        ...session.extensionRunner.getUIContext(),
        notify: (message) => {
          notices.push(message);
        },
      },
    });
    expect(await modelRuntime.listCredentials()).toEqual([]);
    expect(session.getActiveToolNames()).toEqual([]);
    await session.prompt("Explain this image", {
      images: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    });
    // The image is uploaded first, then the message names its attachment.
    expect(f.uploads).toEqual([
      { id: expect.any(String), bytes: 5, completed: true },
    ]);
    expect(f.sent("session.message")[0]).toMatchObject({
      sessionId: SESSION,
      content: "Explain this image",
      delivery: "queue",
      attachmentIds: [f.uploads[0]?.id],
    });
    expect(transcript(session.extensionRunner)).toContain("Explain this image");
    f.state.dropMessageAck = true;
    const refused = session.prompt("A failed request still cannot run locally");
    await f.refuse(2, "Runner unavailable");
    await refused;
    expect(notices.join("\n")).toContain("Runner unavailable");
    expect(events).not.toContain("agent_start");
    expect(events).not.toContain("tool_execution_start");
    expect(session.agent.state.messages).toEqual([]);
    expect(session.isStreaming).toBe(false);
    expect(f.sent("session.message")).toHaveLength(2);
  }, 15000);

  test("an attached image is read from Leverage and drawn in its card", async () => {
    const f = leverage((request) =>
      new URL(request.url).pathname === "/api/uploads/k1"
        ? new Response(Buffer.from("png-bytes"), {
            headers: { "content-type": "image/png" },
          })
        : undefined,
    );
    f.emit("user", {
      content: "See the screenshot",
      attachments: [
        {
          filename: "shot.png",
          contentType: "image/png",
          url: "/api/uploads/k1",
        },
      ],
    });
    const runner = await load();
    f.configure(runner, SESSION);
    await runner.emit({ type: "session_start", reason: "startup" });
    await eventually(() =>
      f.requests.some((request) => request.path === "/api/uploads/k1"),
    );
    expect(transcript(runner)).toContain("shot.png");
  });

  test("an image Pi pasted as a local path goes with the message", async () => {
    const f = leverage();
    const runner = await load();
    f.configure(runner, SESSION);
    await runner.emit({ type: "session_start", reason: "startup" });
    const image = join(temporaryDirectory(), "pi-clipboard-1.png");
    writeFileSync(image, Buffer.from("hello"));
    await runner.emitInput(
      `What is in ${image} and /tmp/missing-image.png?`,
      undefined,
      "interactive",
    );
    expect(f.uploads).toEqual([
      { id: expect.any(String), bytes: 5, completed: true },
    ]);
    expect(f.sent("session.message")[0]).toMatchObject({
      content: "What is in and /tmp/missing-image.png?",
      attachmentIds: [f.uploads[0]?.id],
    });
  });

  test("Pi stays itself until /leverage opens a view", async () => {
    const f = leverage();
    const manager = SessionManager.inMemory(temporaryDirectory());
    const toolSelections: string[][] = [];
    const runner = await load({
      manager,
      activeTools: (names) => toolSelections.push(names),
    });
    f.configure(runner);
    const widgets: string[][] = [];
    runner.setUIContext(
      {
        ...runner.getUIContext(),
        select: async () => {
          throw new Error("Startup must not open a picker");
        },
        setWidget: (_key, value) => {
          if (typeof value === "function") {
            widgets.push(value({} as never, {} as never).render(120));
          }
        },
      },
      "tui",
    );
    await runner.emit({ type: "session_start", reason: "startup" });
    expect(
      await runner.emitInput("Answer locally", undefined, "interactive"),
    ).toEqual({ action: "continue" });
    expect(
      await runner.emitUserBash({
        type: "user_bash",
        command: "ls",
        cwd: manager.getCwd(),
        excludeFromContext: false,
      }),
    ).toBeUndefined();
    expect(toolSelections).toEqual([]);
    expect(widgets).toEqual([]);
    expect(f.requests).toEqual([]);
    expect(f.connections.size).toBe(0);

    commandActions(runner, {
      newSession: async (options) => {
        await options?.setup?.(manager);
        await runner.emit({ type: "session_start", reason: "new" });
        return { cancelled: false };
      },
    });
    await command(runner, "new");
    await eventually(() =>
      widgets.some((lines) =>
        lines.some((line) => line.includes("Standalone")),
      ),
    );
    expect(widgets.flat().join("\n")).toContain("New Leverage session");
    expect(toolSelections).toEqual([[]]);
    expect(f.requests.every((request) => request.method === "GET")).toBe(true);
    expect(f.state.createCount).toBe(0);
    expect(f.sent("session.create")).toEqual([]);
    expect(sessionLink(manager.getBranch())).toBeUndefined();
    // The draft stays a Leverage view when Pi reloads it.
    await runner.emit({ type: "session_start", reason: "reload" });
    expect(toolSelections).toEqual([[], []]);
    expect(
      await runner.emitInput("Still remote", undefined, "interactive"),
    ).toEqual({ action: "handled" });
  });

  test("new sessions create a local draft without a remote task or prompt", async () => {
    const f = leverage();
    const runner = await load();
    f.configure(runner);
    let opened = false;
    commandActions(runner, {
      newSession: async () => {
        opened = true;
        await runner.emit({ type: "session_start", reason: "new" });
        return { cancelled: false };
      },
    });
    await command(runner, "new Explore the project");
    expect(opened).toBe(true);
    expect(f.state.createCount).toBe(0);
    expect(f.requests.some((request) => request.method !== "GET")).toBe(false);
    expect(
      f.frames.some(
        (frame) =>
          frame.type === "session.create" || frame.type === "session.message",
      ),
    ).toBe(false);
    expect(
      sessionLink(runner.createContext().sessionManager.getBranch()),
    ).toBeUndefined();
  });

  test("the first prompt creates the draft's session with its title, then sends the prompt", async () => {
    const f = leverage();
    const runner = await load();
    f.configure(runner);
    commandActions(runner, {
      newSession: async () => {
        await runner.emit({ type: "session_start", reason: "new" });
        return { cancelled: false };
      },
    });
    await command(runner, "new Explore the project");
    await runner.emitInput("Map the modules", undefined, "interactive");
    expect(f.state.createCount).toBe(1);
    expect(f.sent("session.create")).toEqual([
      expect.objectContaining({ title: "Explore the project", prompt: "" }),
    ]);
    expect(f.sent("session.message")).toEqual([
      expect.objectContaining({
        sessionId: SESSION,
        content: "Map the modules",
        delivery: "queue",
      }),
    ]);
    // The create frame goes out before the message that needs its session.
    expect(
      f.frames.findIndex((frame) => frame.type === "session.create"),
    ).toBeLessThan(
      f.frames.findIndex((frame) => frame.type === "session.message"),
    );
    expect(
      sessionLink(runner.createContext().sessionManager.getBranch())?.sessionId,
    ).toBe(SESSION);
    expect(transcript(runner)).toContain("Map the modules");
  });

  test("two clients share prompts, streamed answers, and tool progress without starting local agents", async () => {
    const f = leverage();
    f.emit("user", { content: "Alex: Existing shared history" });
    // A message sent while the agent works steers the running turn.
    f.update({ status: "active", turnId: "turn_1" });
    let localPrompts = 0;
    const first = await load({
      onPrompt: () => {
        localPrompts++;
      },
    });
    const second = await load({
      onPrompt: () => {
        localPrompts++;
      },
    });
    const notices: string[] = [];
    for (const runner of [first, second]) {
      runner.setUIContext({
        ...runner.getUIContext(),
        notify: (message) => {
          notices.push(message);
        },
      });
    }
    for (const runner of [first, second]) {
      f.configure(runner, SESSION);
      await runner.emit({ type: "session_start", reason: "startup" });
    }
    expect(transcript(first)).toContain("Alex: Existing shared history");
    await first.emitInput("Jordan: I fixed the test", undefined, "interactive");
    await eventually(() =>
      transcript(second).includes("Jordan: I fixed the test"),
    );
    f.publish({
      type: "session.event.delta",
      _topic: "session",
      sessionId: SESSION,
      delta: {
        kind: "text",
        streamId: "stream_reply",
        eventId: "evt_reply",
        rowId: "row_reply",
        delta: "Checking the project",
        offset: 0,
      },
    });
    f.emit("tool_call", {
      toolUseId: "toolu_check",
      name: "bash",
      input: { command: "bun test" },
    });
    f.publish({
      type: "session.event.delta",
      _topic: "session",
      sessionId: SESSION,
      delta: {
        kind: "tool_output",
        streamId: "stream_tool",
        toolUseId: "toolu_check",
        delta: "Tests are running",
        offset: 0,
      },
    });
    await eventually(
      () =>
        transcript(first).includes("Checking the project") &&
        transcript(first).includes("Tests are running") &&
        transcript(second).includes("Tests are running"),
    );
    // A replayed row must not add a second card.
    const answer = {
      content: "The project passes.",
      eventId: "evt_reply",
      finalized: true,
      role: "assistant",
    };
    f.emit("text", answer, { id: "row_reply" });
    f.emit("text", answer, { id: "row_reply" });
    f.emit("tool_result", {
      toolUseId: "toolu_check",
      content: "All tests passed",
    });
    await eventually(() =>
      transcript(second).includes("All tests passed"),
    ).catch(() => {
      throw new Error(`${notices.join("\n")}\n${transcript(second)}`);
    });
    for (const runner of [first, second]) {
      expect(historyRows(runner)).toHaveLength(4);
      expect(transcript(runner)).toContain("The project passes.");
      expect(transcript(runner)).not.toContain("Checking the project");
      expect(transcript(runner)).toContain("$ bun test");
      expect(
        runner
          .createContext()
          .sessionManager.getBranch()
          .some((entry) => entry.type === "message"),
      ).toBe(false);
    }
    expect(localPrompts).toBe(0);
    expect(f.sent("session.message")).toEqual([
      expect.objectContaining({
        content: "Jordan: I fixed the test",
        delivery: "send",
      }),
    ]);
  });

  test("queue, explicit retry, and stop use the shared session API without duplicate messages", async () => {
    const f = leverage();
    f.update({ status: "active", turnId: "turn_1" });
    const runner = await load();
    f.configure(runner, SESSION);
    commandActions(runner);
    await runner.emit({ type: "session_start", reason: "startup" });
    await command(runner, "queue Check this after the current task");
    expect(transcript(runner)).toContain("Queued");
    f.state.dropMessageAck = true;
    const refused = runner.emitInput(
      "Try exactly once until I ask",
      undefined,
      "interactive",
    );
    await f.refuse(2, "Runner unavailable");
    await refused;
    f.state.dropMessageAck = false;
    await command(runner, "retry");
    const messages = f.sent("session.message");
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      content: "Check this after the current task",
      delivery: "queue",
    });
    expect(messages[1]).toMatchObject({ delivery: "send" });
    // A retry resends the same request, so Leverage stores it once.
    expect(messages[2]).toEqual(messages[1]!);
    expect(historyRows(runner)).toHaveLength(2);
    await command(runner, "stop");
    expect(f.sent("session.stop")).toEqual([
      expect.objectContaining({ sessionId: SESSION, turnId: "turn_1" }),
    ]);
    await runner.emit({ type: "session_shutdown", reason: "quit" });
    await eventually(() => f.connections.size === 0);
    expect(f.sent("session.stop")).toHaveLength(1);
  });

  test("switching views restores each server transcript and closes the previous subscription", async () => {
    const f = leverage();
    const other = "22222222-2222-4222-8222-222222222222";
    f.sessions.push({ ...exampleSession(), id: other, title: "Second task" });
    f.emit("user", { content: "First shared task" });
    f.emit("user", { content: "Second shared task" }, { sessionId: other });
    const first = await load();
    f.configure(first, SESSION);
    await first.emit({ type: "session_start", reason: "startup" });
    const replacement = SessionManager.inMemory(first.createContext().cwd);
    commandActions(first, {
      newSession: async (options) => {
        await options?.setup?.(replacement);
        await first.emit({ type: "session_shutdown", reason: "quit" });
        return { cancelled: false };
      },
    });
    await command(first, `open ${other}`);
    expect(sessionLink(replacement.getBranch())?.sessionId).toBe(other);
    await eventually(() =>
      f
        .sent("session.unsubscribe")
        .some((frame) => frame.sessionId === SESSION),
    );
    const second = await load({ manager: replacement });
    f.configure(second);
    await second.emit({ type: "session_start", reason: "new" });
    await eventually(() => f.connections.size === 1);
    expect(transcript(second)).toContain("Second shared task");
    expect(transcript(second)).not.toContain("First shared task");
    commandActions(second, {
      newSession: async () => {
        throw new Error("Same session must keep its view");
      },
    });
    // A link saved by an older version still names the same session.
    await command(second, `open ses_${other}`);
    expect(historyRows(second)).toHaveLength(1);
    expect(f.connections.size).toBe(1);
    expect(f.sent("session.stop")).toEqual([]);
  });

  test("reports one failed startup read and accepts prompts after reconnecting", async () => {
    let failing = true;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = leverage(async (request) => {
      const url = new URL(request.url);
      // Only the full read fails. The one-row lookup that finds the session works.
      if (
        failing &&
        url.pathname.endsWith("/bootstrap") &&
        url.searchParams.get("limit") !== "1"
      ) {
        await gate;
        return Response.json(
          { error: "History is unavailable" },
          { status: 503 },
        );
      }
      return undefined;
    });
    const runner = await load();
    f.configure(runner, SESSION);
    const notices: string[] = [];
    let live = false;
    runner.setUIContext({
      ...runner.getUIContext(),
      notify: (message) => notices.push(message),
      setStatus: (_key, value) => {
        live ||= value?.endsWith(" · live") ?? false;
      },
    });
    const startup = runner.emit({ type: "session_start", reason: "startup" });
    await eventually(() => live);
    release();
    await startup;
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("503");

    failing = false;
    f.emit("user", { content: "Recovered" });
    // Dropping the socket makes Pi reconnect and read the session again.
    for (const connection of f.connections) {
      connection.close();
    }
    await eventually(() => transcript(runner).includes("Recovered"));
    // The read after reconnecting subscribes to the session's live frames.
    await eventually(() => f.sent("session.subscribe").length > 0);
    expect(
      await runner.emitInput(
        "Continue after recovery",
        undefined,
        "interactive",
      ),
    ).toEqual({ action: "handled" });
    expect(f.sent("session.message")).toEqual([
      expect.objectContaining({ content: "Continue after recovery" }),
    ]);
    expect(notices).toHaveLength(1);
  });
});
