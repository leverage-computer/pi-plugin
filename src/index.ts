import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename } from "node:path";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type InputEvent,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { api, sessionId } from "./api";
import { rememberedModel, rememberModel, resolveConnection } from "./config";
import { chooseDrawer, clean, report, textDrawer } from "./drawers";
import {
  createHistoryComponent,
  HISTORY_ENTRY,
  type HistoryEntry,
  type HistoryMarker,
  historyMarkerSchema,
} from "./history";
import {
  DRAFT_ENTRY,
  LINK_ENTRY,
  type Prompt,
  type PromptFile,
  type SessionLink,
  SessionView,
  sameSession,
  sessionLink,
  viewRemoteHistory,
} from "./session";
import { BorderStatus, footerLines, statusLines } from "./status";
import { workspace } from "./workspace/api";
import {
  describeChanges,
  describeConnectors,
  filesDrawer,
} from "./workspace/files";
import type { SessionDraft, WorkspaceSession } from "./workspace/schema";
import { contextName, editDraft, sessionsDrawer } from "./workspace/ui";

// F1 and F2 open these draft settings directly.
const SETTING_SECTIONS = ["context", "model"] as const;
const FUNCTION_KEYS = [
  ["f1", "settings context"],
  ["f2", "settings model"],
  ["f3", "sessions"],
  ["f4", "approvals"],
] as const;
// Pi's own model and session keys open the matching Leverage control.
const PI_KEYS = [
  ["app.model.select", "model"],
  ["app.model.cycleForward", "model"],
  ["app.model.cycleBackward", "model"],
  ["app.thinking.cycle", "model"],
  ["app.session.new", "new"],
  ["app.session.resume", "sessions"],
] as const;
const PI_COMMANDS: Record<string, string> = {
  "/model": "model",
  "/resume": "sessions",
  "/new": "new",
  "/compact": "compact",
  "/name": "rename",
  "/tree": "history",
};
// These commands use the open view as it is. The others reconnect after a lost connection.
const VIEW_COMMANDS = new Set([
  "stop",
  "retry",
  "queue",
  "compact",
  "status",
  "exit",
]);
// Pi creates a new extension instance when it switches sessions.
const composerDrafts = new Map<string, string>();
let nextDraft: Partial<SessionDraft> | undefined;

// Image types Leverage shows, by file extension.
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
// An absolute or home path to an image. Dragged files escape their spaces.
const IMAGE_PATH =
  /(?<=^|\s)(?:~|\/)(?:\\ |[^\s])+\.(?:png|jpe?g|gif|webp)(?=\s|$)/gi;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Pi pastes a clipboard image, or a dragged file, as a path on this machine.
 * Leverage cannot read this machine, so each image that exists goes with the
 * message and its path leaves the text.
 */
async function localImages(
  text: string,
): Promise<{ text: string; files: PromptFile[] }> {
  const files: PromptFile[] = [];
  let rest = text;
  for (const match of text.matchAll(IMAGE_PATH)) {
    const written = match[0];
    const path = written.replace(/\\ /g, " ").replace(/^~(?=\/)/, homedir());
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) {
      continue;
    }
    if (info.size > MAX_IMAGE_BYTES) {
      continue;
    }
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    files.push({
      filename: basename(path),
      contentType: IMAGE_TYPES[extension] ?? "application/octet-stream",
      data: (await readFile(path)).toString("base64"),
    });
    rest = rest.replace(
      rest.includes(` ${written}`) ? ` ${written}` : written,
      "",
    );
  }
  return { text: rest.trim(), files };
}

type Interaction = "approvals" | "questions" | "inbox" | "model";
type Command = (
  ctx: ExtensionCommandContext,
  words: string[],
  opening: number,
) => Promise<void>;

export default function leverage(pi: ExtensionAPI): void {
  // Pi needs a model entry to open its composer without a local provider login.
  pi.registerProvider("leverage", {
    name: "Leverage",
    baseUrl: "https://leverage.invalid",
    apiKey: "remote-session",
    api: "openai-completions",
    models: [
      {
        id: "session",
        name: "Leverage session",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
    streamSimple: () => {
      throw new Error(
        "Use the Leverage composer to send prompts to the remote session.",
      );
    },
  });
  for (const [name, description] of Object.entries({
    host: "Leverage server origin",
    workspace: "Leverage workspace slug",
    session: "Leverage session to open; otherwise open a new draft",
    directory:
      "Workspace or channel folder for the session picker and new sessions",
  })) {
    pi.registerFlag(`leverage-${name}`, { type: "string", description });
  }

  // This instance's hold on the shared connection. Pi starts the next
  // extension instance before it shuts this one down, so the connection
  // only ends when the last instance lets go of it.
  let own: number | undefined;
  let lifetime = new AbortController();
  let generation = 0;
  // Pi stays itself until /leverage opens a view in it.
  let active = false;
  let stream = "disconnected";
  let failure = "Choose or create a session with /leverage.";
  // The open Leverage session.
  let view: SessionView | undefined;
  // A new session is a local draft until its first prompt creates it.
  let draft: SessionDraft | undefined;
  let draftLoading: Promise<void> | undefined;
  let draftError: string | undefined;
  let draftContext = "Standalone";
  let creating = false;
  let pendingCreation: Prompt | undefined;
  // Pi's composer and the dialogs above it.
  let composerKey: string | undefined;
  let editorInstalled = false;
  let priorEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let composer: { editor: CustomEditor; tui: TUI } | undefined;
  let working: BorderStatus | undefined;
  let redrawConversation = () => {};
  let dialogCount = 0;

  const flag = (name: string) => {
    const value = pi.getFlag(`leverage-${name}`);
    return typeof value === "string" ? value : undefined;
  };
  const settings = (link?: SessionLink) =>
    resolveConnection({
      host: flag("host") ?? link?.host,
      workspace: flag("workspace") ?? link?.workspace,
      session: link?.sessionId ?? flag("session"),
      directory: flag("directory"),
    });
  const linkFor = (session: WorkspaceSession): SessionLink => ({
    version: 1,
    host: api.connection.host,
    workspace: api.connection.workspace,
    sessionId: session.id,
  });
  const busy = () => dialogCount > 0 || !!view?.interactions?.hasDialog;
  // Shortcuts go through Pi's command path. Only a command can switch sessions.
  const runCommand = (args: string) =>
    pi.sendUserMessage(`/leverage ${args}`, { expandPromptTemplates: true });

  const stopWorking = () => {
    composer?.editor.setWorkingStatusIndicator(undefined);
    working?.stop();
    working = undefined;
  };
  const status = (ctx: ExtensionContext) => {
    ctx.ui.setStatus(
      "leverage",
      clean(
        view
          ? `${view.session.title || view.session.id} · ${view.stream}`
          : draft
            ? "Leverage: new session"
            : "Leverage: connecting",
      ),
    );
    const spinner =
      view && (!view.ready || view.running)
        ? view.ready
          ? "Working"
          : "Connecting"
        : undefined;
    if (!spinner) {
      stopWorking();
    } else if (composer) {
      const { editor, tui } = composer;
      working ??= new BorderStatus(
        tui,
        (text) => editor.borderColor(text),
        (text) => editor.borderColor(text),
        spinner,
      );
      working.setMessage(spinner);
      // Pi does not export its indicator type; the composer calls only the border methods.
      editor.setWorkingStatusIndicator(
        working as unknown as Parameters<
          CustomEditor["setWorkingStatusIndicator"]
        >[0],
      );
    }
    // Other modes forward widget text, so only the terminal gets colors.
    const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
    const lines = statusLines(
      view,
      {
        settings: draft,
        place: draftContext,
        error: draftError,
        unconfirmed: !!pendingCreation,
      },
      theme,
    );
    if (!theme) {
      ctx.ui.setWidget("leverage-session", lines);
      return;
    }
    // Pi indents text widgets by a column, so these lines sit flush with the composer.
    ctx.ui.setWidget("leverage-session", (tui) => {
      // Another extension's composer may not draw the indicator, so it goes here instead.
      if (spinner && !composer) {
        working ??= new BorderStatus(
          tui,
          (text) => theme.fg("accent", text),
          (text) => theme.fg("muted", text),
          spinner,
        );
        working.setMessage(spinner);
      }
      const indicator = composer ? undefined : working;
      return {
        invalidate() {},
        render: (width: number) => [
          ...(indicator ? indicator.render(width) : []),
          ...lines.flatMap((line) => wrapTextWithAnsi(line, width)),
        ],
      };
    });
  };

  const disconnect = () => {
    generation++;
    stopWorking();
    view?.close();
    view = undefined;
    lifetime.abort();
    if (own !== undefined) {
      api.close(own);
      if (!api.connected) {
        workspace.close();
      }
    }
    own = undefined;
    stream = "disconnected";
    draft = undefined;
    draftLoading = undefined;
    draftError = undefined;
    draftContext = "Standalone";
    creating = false;
    pendingCreation = undefined;
  };
  const ensureApi = () => {
    if (lifetime.signal.aborted) {
      disconnect();
    }
    if (own === undefined) {
      lifetime = new AbortController();
      own = api.connect(settings());
      workspace.open();
    }
  };
  // The open session once it is ready. A write also needs collaborator access.
  const requireSession = (write = false): SessionView => {
    if (own === undefined) {
      throw new Error(view?.problem ?? failure);
    }
    if (!view?.ready) {
      throw new Error(view?.problem ?? failure);
    }
    if (write && !view.writable) {
      throw new Error(
        "This session is read-only. Ask the owner for collaborator access.",
      );
    }
    return view;
  };
  const stop = async () => {
    await requireSession(true).stop();
  };
  const showInteraction = async (kind: Interaction) => {
    await requireSession().interactions!.show(kind);
  };

  const attach = async (session: WorkspaceSession, ctx: ExtensionContext) => {
    ensureApi();
    const owner = lifetime;
    view?.close();
    composerKey = `${api.connection.host}/${api.connection.workspace}/${session.id}`;
    view = new SessionView(pi, ctx, session, owner.signal, {
      changed: () => status(ctx),
      opened: () => redrawConversation(),
      revoked: () => owner.abort(),
    });
    await view.open(linkFor(session));
  };
  const switchTo = async (
    session: WorkspaceSession,
    ctx: ExtensionCommandContext,
  ) => {
    if (!ctx.isIdle()) {
      throw new Error("Stop local work before opening a Leverage session.");
    }
    if (ctx.hasPendingMessages()) {
      throw new Error("Stop local work before opening a Leverage session.");
    }
    const link = linkFor(session);
    const currentLink = sessionLink(ctx.sessionManager.getBranch());
    if (currentLink && sameSession(link, currentLink) && view?.ready) {
      await view.sync();
      return;
    }
    const result = await ctx.newSession({
      setup: async (manager) => {
        manager.appendCustomEntry(LINK_ENTRY, link);
        manager.appendSessionInfo(session.title || "Leverage session");
      },
    });
    if (result.cancelled) {
      ctx.ui.notify(
        `Open ${session.id} with /leverage open to continue.`,
        "info",
      );
    }
  };
  const submit = async (
    event: Pick<InputEvent, "text" | "images">,
    ctx: ExtensionContext,
    queue = false,
  ) => {
    const given = (event.images ?? []).map(
      (image, index): PromptFile => ({
        filename: `image-${index + 1}.${image.mimeType.split("/")[1] || "png"}`,
        contentType: image.mimeType,
        data: image.data,
      }),
    );
    const pasted = await localImages(event.text);
    const files = [...given, ...pasted.files];
    // A message sent while the agent works steers that turn. Idle, it starts one.
    const prompt: Prompt = {
      id: randomUUID(),
      text: pasted.text,
      ...(files.length ? { files } : {}),
      delivery: queue || !view?.running ? "queue" : "send",
    };
    if (view) {
      await requireSession(true).send(prompt);
    } else {
      await createAndSend(prompt, ctx);
    }
  };
  // The first prompt creates the empty session, opens it, then sends the prompt.
  const createAndSend = async (prompt: Prompt, ctx: ExtensionContext) => {
    if (creating) {
      throw new Error("Session setup is already in progress.");
    }
    await draftLoading;
    if (creating) {
      throw new Error("Session setup is already in progress.");
    }
    if (!draft) {
      throw new Error(
        "Leverage defaults are unavailable. Use /leverage new to retry.",
      );
    }
    if (own === undefined) {
      throw new Error(
        "Leverage defaults are unavailable. Use /leverage new to retry.",
      );
    }
    if (pendingCreation && pendingCreation.id !== prompt.id) {
      throw new Error(
        "The previous setup is unconfirmed. Use /leverage retry first.",
      );
    }
    const opening = generation;
    creating = true;
    pendingCreation = prompt;
    status(ctx);
    try {
      const id = await workspace.create(draft, lifetime.signal);
      rememberModel(api.connection, {
        providerFamily: draft.providerFamily,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
      });
      const session = await workspace.session(id, lifetime.signal);
      if (opening !== generation) {
        return;
      }
      if (!view?.ready || view.session.id !== session.id) {
        await attach(session, ctx);
      }
      await requireSession(true).send(prompt);
      if (opening === generation) {
        draft = undefined;
        pendingCreation = undefined;
      }
    } finally {
      if (opening === generation) {
        creating = false;
        status(ctx);
      }
    }
  };
  // A new session starts as a local draft. --leverage-directory can name its channel.
  const startDraft = async (ctx: ExtensionContext, opening: number) => {
    const nativeSocket = await workspace.socket(lifetime.signal);
    const unstate = nativeSocket.onState((state) => {
      if (opening === generation) {
        stream = state;
        status(ctx);
      }
    });
    lifetime.signal.addEventListener("abort", unstate, { once: true });
    void nativeSocket.connect().catch((error) => {
      if (opening === generation) {
        report(ctx, error);
      }
    });
    const overrides = nextDraft;
    nextDraft = undefined;
    const loaded: SessionDraft = {
      ...workspace.draft(),
      ...rememberedModel(api.connection),
      ...overrides,
    };
    draftLoading = (async () => {
      // A remembered model may have left the catalog. Then the default applies.
      if (loaded.model) {
        const models = await workspace.models(lifetime.signal);
        const kept = models.find((one) => one.id === loaded.model);
        if (!kept) {
          loaded.model = undefined;
          loaded.reasoningEffort = undefined;
        } else if (
          loaded.reasoningEffort &&
          !kept.reasoningEfforts.includes(loaded.reasoningEffort)
        ) {
          loaded.reasoningEffort = undefined;
        }
      }
      const channels =
        loaded.context.type === "channel" || api.connection.directory
          ? await workspace.channels(lifetime.signal)
          : [];
      if (opening !== generation) {
        return;
      }
      const channel = channels.find(
        (one) =>
          api.connection.directory ===
          `/${api.connection.workspace}/${one.name}`,
      );
      if (!overrides?.context && channel) {
        loaded.context = { type: "channel", channelId: channel.id };
      }
      draft = loaded;
      draftContext = contextName(loaded, channels);
      status(ctx);
    })().catch((error: unknown) => {
      if (opening === generation && !lifetime.signal.aborted) {
        failure =
          error instanceof Error
            ? error.message
            : "Cannot load the workspace channels";
        draftError = failure;
        status(ctx);
        report(ctx, error);
      }
    });
  };
  // Pi's composer, with Pi's model and session controls sent to Leverage.
  const installEditor = (ctx: ExtensionContext, opening: number) => {
    const previousEditor = editorInstalled
      ? priorEditor
      : ctx.ui.getEditorComponent();
    priorEditor = previousEditor;
    editorInstalled = true;
    ctx.ui.setEditorComponent((tui, theme, keys) => {
      redrawConversation = () => {
        // Reset the old viewport before a different conversation fills the terminal.
        tui.terminal.write("\u001b[2J\u001b[H\u001b[3J");
        tui.requestRender(true);
      };
      const editor =
        previousEditor?.(tui, theme, keys) ??
        new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
      composer =
        editor instanceof CustomEditor && editor.embedWorkingStatus
          ? { editor, tui }
          : undefined;
      const handleInput = editor.handleInput.bind(editor);
      editor.handleInput = (data) => {
        const completing =
          "isShowingAutocomplete" in editor &&
          typeof editor.isShowingAutocomplete === "function" &&
          editor.isShowingAutocomplete() === true;
        if (
          matchesKey(data, "escape") &&
          !completing &&
          view?.running &&
          !busy()
        ) {
          void stop().catch((error: unknown) => {
            if (opening === generation) {
              report(ctx, error);
            }
          });
          return;
        }
        const action = PI_KEYS.find(([key]) => keys.matches(data, key));
        if (!completing && !busy() && action) {
          runCommand(action[1]);
          return;
        }
        if (matchesKey(data, "enter")) {
          const [command, ...args] = editor.getText().trim().split(/\s+/);
          if (command && PI_COMMANDS[command]) {
            editor.setText(
              `/leverage ${PI_COMMANDS[command]} ${args.join(" ")}`.trim(),
            );
          }
        }
        handleInput(data);
      };
      return editor;
    });
  };
  // Draft settings before creation. An open session has no context, so F1 shows its details.
  const editSettings = async (
    ctx: ExtensionCommandContext,
    section?: (typeof SETTING_SECTIONS)[number],
  ) => {
    if (!view) {
      await draftLoading;
      if (!draft) {
        throw new Error(failure);
      }
      await editDraft(
        ctx,
        draft,
        lifetime.signal,
        (context) => {
          draftContext = context;
          status(ctx);
        },
        section,
      );
      return;
    }
    const picked =
      section === "model"
        ? "model"
        : section === "context"
          ? "info"
          : await chooseDrawer(ctx, {
              title: "Session settings",
              items: [
                {
                  value: "model",
                  label: "Model and reasoning",
                  detail: view.model,
                },
                { value: "info", label: "Session details" },
              ],
              signal: lifetime.signal,
            });
    if (picked === "model") {
      await showInteraction("model");
    }
    if (picked === "info") {
      await textDrawer(ctx, {
        title: "Session details",
        read: () =>
          [
            view?.session.title || "Untitled session",
            view?.place,
            view?.session.id,
            view?.model,
          ]
            .filter(Boolean)
            .join("\n"),
        signal: lifetime.signal,
      });
    }
  };
  // Reads the session again after its title or archive state changes.
  const reload = async (current: SessionView, ctx: ExtensionContext) => {
    await current.sync();
    pi.setSessionName(current.session.title || "Leverage session");
    status(ctx);
  };

  // A new Pi view for a draft. The marker keeps it a Leverage view after a reload.
  const openDraft = async (
    ctx: ExtensionCommandContext,
    overrides: Partial<SessionDraft>,
  ) => {
    nextDraft = overrides;
    const result = await ctx.newSession({
      setup: async (manager) => {
        manager.appendCustomEntry(DRAFT_ENTRY, {});
      },
    });
    if (result.cancelled) {
      nextDraft = undefined;
    }
  };

  const commands: Record<string, Command> = {
    stop,
    retry: async (ctx) => {
      if (pendingCreation && draft) {
        await createAndSend(pendingCreation, ctx);
        return;
      }
      const prompt = view?.failedPrompt;
      if (!prompt) {
        throw new Error("There is no unconfirmed message to retry.");
      }
      await requireSession(true).send(prompt);
    },
    queue: async (ctx, words) => {
      if (!words.length) {
        throw new Error("Use /leverage queue <message>.");
      }
      await submit({ text: words.join(" ") }, ctx, true);
    },
    compact: async () => {
      await requireSession(true).compact();
    },
    status: async (ctx) => {
      ctx.ui.notify(
        clean(
          view
            ? `${view.session.title || view.session.id}\n${view.place}\n${view.session.id}\n${view.model} · ${view.running ? "working" : "idle"} · ${view.stream}`
            : failure,
        ),
        "info",
      );
    },
    new: (ctx, words) =>
      openDraft(ctx, words.length ? { title: words.join(" ") } : {}),
    // Leaves Leverage for a plain Pi view.
    exit: async (ctx) => {
      if (!active) {
        throw new Error("This Pi view is not a Leverage session.");
      }
      await ctx.newSession();
    },
    settings: (ctx, words) =>
      editSettings(
        ctx,
        SETTING_SECTIONS.find((one) => one === words[0]),
      ),
    model: (ctx) =>
      view ? showInteraction("model") : editSettings(ctx, "model"),
    approvals: () => showInteraction("approvals"),
    questions: () => showInteraction("questions"),
    inbox: () => showInteraction("inbox"),
    files: async (ctx) => {
      const current = requireSession();
      await filesDrawer(ctx, current.session.id, current.signal);
    },
    outputs: async (ctx) => {
      const current = requireSession();
      await filesDrawer(ctx, current.session.id, current.signal, "outputs");
    },
    changes: async (ctx) => {
      const current = requireSession();
      const sources = await workspace.fileSources(
        current.session.id,
        current.signal,
      );
      await textDrawer(ctx, {
        title: "Changes",
        read: () => describeChanges(sources),
        signal: current.signal,
      });
    },
    connectors: async (ctx) => {
      const { connectors } = await workspace.connectors(lifetime.signal);
      await textDrawer(ctx, {
        title: "Connections",
        read: () => describeConnectors(connectors),
        signal: lifetime.signal,
      });
    },
    // A skill runs as a message. Claude takes it as a command; Codex as words.
    skills: async (ctx) => {
      const current = requireSession(true);
      const skills = current.shared.skills;
      if (!skills.length) {
        throw new Error("This session's folder has no skills.");
      }
      const picked = await chooseDrawer(ctx, {
        title: "Skills",
        items: skills.map((one) => ({
          value: one.name,
          label: `/${one.name}`,
          detail: one.description,
        })),
        signal: lifetime.signal,
      });
      if (!picked) {
        return;
      }
      ctx.ui.setEditorText(
        current.session.providerFamily === "codex"
          ? `Use the "${picked}" skill. `
          : `/${picked} `,
      );
    },
    history: async (ctx) => {
      const current = requireSession();
      const { session, signal } = current;
      const snapshot = await workspace.bootstrap(session.id, signal);
      await viewRemoteHistory(ctx, session, signal, {
        messages: snapshot.messages,
        members: current.shared.members,
        viewerId: current.shared.userId,
      });
    },
    rename: async (ctx, words) => {
      const current = requireSession(true);
      if (!words.length) {
        throw new Error("Use /leverage rename <title>.");
      }
      await workspace.rename(
        current.session.id,
        words.join(" "),
        current.signal,
      );
      await reload(current, ctx);
    },
    archive: async (ctx) => {
      const current = requireSession(true);
      await workspace.archive(current.session.id, current.signal);
      ctx.ui.notify(
        "Session archived. /leverage restore brings it back.",
        "info",
      );
    },
    restore: async (ctx) => {
      const current = requireSession(true);
      await workspace.unarchive(current.session.id, current.signal);
      ctx.ui.notify("Session restored.", "info");
    },
    open: async (ctx, words, opening) => {
      if (!words[0]) {
        throw new Error("Use /leverage open <session-id>.");
      }
      const session = await workspace.session(
        sessionId(words[0]),
        lifetime.signal,
      );
      if (opening === generation) {
        await switchTo(session, ctx);
      }
    },
    sessions: async (ctx, words, opening) => {
      const picked = await sessionsDrawer(
        ctx,
        lifetime.signal,
        words.join(" "),
      );
      if (picked === "new") {
        await openDraft(ctx, {});
        return;
      }
      if (!picked) {
        return;
      }
      const session = await workspace.session(picked, lifetime.signal);
      if (opening === generation) {
        await switchTo(session, ctx);
      }
    },
  };

  pi.registerEntryRenderer<HistoryMarker>(
    HISTORY_ENTRY,
    (entry, options, theme) =>
      createHistoryComponent(
        () => {
          const history = view?.history;
          const marker = historyMarkerSchema.safeParse(entry.data);
          if (!marker.success) {
            return undefined;
          }
          return history?.sessionId === marker.data.sessionId
            ? history.entry(marker.data.id)
            : undefined;
        },
        options.expanded,
        theme,
      ),
  );
  pi.on("input", async (event, ctx) => {
    if (!active) {
      return { action: "continue" };
    }
    try {
      await submit(event, ctx);
    } catch (error) {
      if (!lifetime.signal.aborted) {
        report(ctx, error);
      }
    }
    // Pi continues to its local model if an input handler throws.
    return { action: "handled" };
  });
  pi.on("session_before_switch", (_event, ctx) => {
    if (creating) {
      ctx.ui.notify("Wait for session setup to finish.", "info");
      return { cancel: true };
    }
    if (composerKey) {
      composerDrafts.set(composerKey, ctx.ui.getEditorText());
    }
  });
  pi.on("session_start", async (event, ctx) => {
    disconnect();
    lifetime = new AbortController();
    const opening = generation;
    composerKey = undefined;
    const branch = ctx.sessionManager.getBranch();
    const link = sessionLink(branch);
    // Only --leverage-session opens a session when Pi starts.
    const requested = event.reason === "startup" && !!flag("session");
    active =
      !!link ||
      requested ||
      nextDraft !== undefined ||
      branch.some(
        (entry) => entry.type === "custom" && entry.customType === DRAFT_ENTRY,
      );
    if (!active) {
      return;
    }
    pi.setActiveTools([]);
    installEditor(ctx, opening);
    // Pi's footer layout, with the Leverage folder and model in place of local ones.
    ctx.ui.setFooter((_tui, theme) => ({
      invalidate() {},
      render: (width) =>
        footerLines(
          theme,
          width,
          [
            view?.place ||
              (own === undefined ? "" : `/${api.connection.workspace}`),
            view?.session.title,
          ]
            .filter(Boolean)
            .join(" • "),
          view?.stream ?? stream,
          view?.model ?? "",
          view?.usage,
        ),
    }));
    try {
      const resolved = settings(link);
      composerKey = `${resolved.host}/${resolved.workspace}/${link?.sessionId ?? (event.reason !== "new" ? resolved.sessionId : undefined) ?? ctx.sessionManager.getSessionId()}`;
      ctx.ui.setEditorText(composerDrafts.get(composerKey) ?? "");
      if (
        link &&
        (link.host !== resolved.host || link.workspace !== resolved.workspace)
      ) {
        throw new Error(
          "This view belongs to another workspace. Use /leverage to choose a session.",
        );
      }
      own = api.connect(resolved);
      workspace.open();
      if (link || requested) {
        const session = await workspace.session(
          sessionId(link?.sessionId ?? api.connection.sessionId!),
          lifetime.signal,
        );
        if (opening === generation) {
          // A view with local Pi messages opens the session in a new view instead.
          const localConversation = ctx.sessionManager
            .getBranch()
            .some(
              (entry) =>
                entry.type === "message" &&
                (entry.message.role === "user" ||
                  entry.message.role === "assistant"),
            );
          if (localConversation) {
            runCommand(`open ${session.id}`);
          } else {
            await attach(session, ctx);
          }
        }
      } else {
        await startDraft(ctx, opening);
      }
    } catch (error) {
      if (opening !== generation) {
        return;
      }
      failure =
        error instanceof Error ? error.message : "Cannot connect to Leverage.";
      report(ctx, error);
    }
    if (opening === generation) {
      status(ctx);
    }
  });
  pi.on("session_shutdown", disconnect);
  pi.on("session_before_compact", async (_event, ctx) => {
    if (!active) {
      return;
    }
    try {
      await requireSession(true).compact();
    } catch (error) {
      report(ctx, error);
    }
    return { cancel: true };
  });
  // A Leverage session has one line of history, so Pi's tree has nowhere to go.
  pi.on("session_before_tree", (_event, ctx) => {
    if (!active) {
      return;
    }
    ctx.ui.notify(
      "Leverage sessions have one history. Use /leverage history to read it.",
      "info",
    );
    return { cancel: true };
  });
  pi.on("session_before_fork", (_event, ctx) => {
    if (!active) {
      return;
    }
    ctx.ui.notify(
      "Leverage does not support session forks. Use /leverage new.",
      "info",
    );
    return { cancel: true };
  });
  // Leverage has no remote shell for Pi yet. Refusing here keeps `!` commands
  // from running on this machine by mistake.
  pi.on("user_bash", () => {
    if (!active) {
      return;
    }
    return {
      operations: {
        async exec() {
          throw new Error(
            "Leverage cannot run shell commands from Pi yet. Ask the agent to run it instead.",
          );
        },
      },
    };
  });
  pi.registerCommand("leverage", {
    description:
      "Open Leverage: new, sessions, files, outputs, changes, approvals, skills, history, model, exit",
    handler: async (args, ctx) => {
      const opening = generation;
      dialogCount++;
      try {
        const [action = "sessions", ...words] = args
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (!VIEW_COMMANDS.has(action)) {
          ensureApi();
        }
        const command = Object.hasOwn(commands, action)
          ? commands[action]
          : undefined;
        if (!command) {
          throw new Error(
            "Use /leverage sessions, new, open, history, files, outputs, changes, connectors, skills, stop, queue, approvals, questions, inbox, model, compact, rename, archive, restore, or exit.",
          );
        }
        await command(ctx, words, opening);
      } catch (error) {
        if (opening === generation) {
          report(ctx, error);
        }
      } finally {
        dialogCount--;
      }
    },
  });
  for (const [key, action] of FUNCTION_KEYS) {
    pi.registerShortcut(key, {
      description: `Leverage ${action}`,
      handler: async () => {
        if (!active) {
          return;
        }
        if (!busy()) {
          runCommand(action);
        }
      },
    });
  }
}
