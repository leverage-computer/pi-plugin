import { spawn } from "node:child_process";
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
import {
  api,
  endSignIn,
  type LoginWorkspace,
  sessionId,
  signedInWorkspaces,
  signIn,
} from "./api";
import {
  forgetLogin,
  loginHost,
  rememberedModel,
  rememberModel,
  resolveConnection,
  saveLogin,
} from "./config";
import { chooseDrawer, clean, report, textDrawer } from "./drawers";
import { UnconfirmedError } from "./errors";
import type { ModelChoice } from "./interactions";
import { createEntryComponent } from "./render";
import {
  DRAFT_ENTRY,
  HISTORY_ENTRY,
  type HistoryMarker,
  historyMarkerSchema,
  LINK_ENTRY,
  NO_TERMINAL,
  type Prompt,
  type PromptFile,
  type SessionLink,
  SessionView,
  sameSession,
  sessionLink,
  viewRemoteHistory,
} from "./session";
import {
  BorderStatus,
  footerLines,
  personText,
  roster,
  statusLines,
} from "./status";
import { workspace } from "./workspace/api";
import {
  describeChanges,
  describeConnectors,
  filesDrawer,
} from "./workspace/files";
import {
  type HostedModel,
  type ProviderFamily,
  runnableFamilies,
  type SessionDraft,
  type WorkspaceSession,
} from "./workspace/schema";
import { contextName, editDraft, sessionsDrawer } from "./workspace/ui";
import { userText } from "./workspace/view";

// F1 opens these draft settings directly.
const SETTING_SECTIONS = ["context", "model"] as const;
const FUNCTION_KEYS = [
  ["f1", "settings context"],
  ["f3", "sessions"],
  ["f4", "approvals"],
] as const;
// Pi's own session keys open the matching Leverage control.
const PI_KEYS = [
  ["app.session.new", "new"],
  ["app.session.resume", "sessions"],
] as const;
const PI_COMMANDS: Record<string, string> = {
  "/resume": "sessions",
  "/new": "new",
};
// These commands use the open view as it is. The others reconnect after a lost connection.
const VIEW_COMMANDS = new Set(["status", "exit"]);
// Pi's thinking levels that share a name with a Leverage reasoning effort.
const THINKING_LEVELS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
// Pi needs a model to open its composer before Leverage's models load.
const PLACEHOLDER_MODEL = {
  id: "session",
  name: "Leverage session",
  reasoning: false,
  input: ["text", "image"] as ("text" | "image")[],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
};

// The name Pi's session gets while its Leverage session has no title.
const UNTITLED = "Leverage session";

// The reasoning effort a Pi thinking level stands for on a Leverage model.
function effortOf(
  model: { thinkingLevelMap?: Partial<Record<string, string | null>> },
  level: string,
): string | undefined {
  return model.thinkingLevelMap?.[level] ?? undefined;
}

/**
 * A Leverage model as a Pi model, so Pi's own model and thinking controls
 * choose it. Pi offers only the thinking levels Leverage has an effort for.
 */
function piModel(model: HostedModel) {
  return {
    ...PLACEHOLDER_MODEL,
    id: model.id,
    name: model.label,
    reasoning: model.reasoningEfforts.length > 0,
    thinkingLevelMap: Object.fromEntries([
      ["off", null],
      ...THINKING_LEVELS.map((level) => [
        level,
        model.reasoningEfforts.includes(level) ? level : null,
      ]),
    ]),
  };
}
// These commands sign in and out, so they never need a connection first.
const ACCESS_COMMANDS = new Set(["login", "logout"]);
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

// Opens a page in the browser. Where none opens, the notice has the link.
function browse(link: string): void {
  const opener =
    process.env.BROWSER?.trim() ||
    (process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? undefined
        : "xdg-open");
  if (!opener) {
    return;
  }
  try {
    spawn(opener, [link], { stdio: "ignore", detached: true })
      .on("error", () => undefined)
      .unref();
  } catch {
    // The notice already shows the link.
  }
}

// The workspace named, the only one, or the one the person picks.
async function chooseWorkspace(
  ctx: ExtensionCommandContext,
  workspaces: LoginWorkspace[],
  named?: string,
): Promise<LoginWorkspace | undefined> {
  if (named) {
    const found = workspaces.find(
      (one) => one.slug === named || one.name === named,
    );
    if (!found) {
      const yours = workspaces.map((one) => one.slug).join(", ");
      throw new Error(`No workspace ${named}. Yours: ${yours}.`);
    }
    return found;
  }
  if (workspaces.length <= 1) {
    return workspaces[0];
  }
  const picked = await ctx.ui.select(
    "Leverage workspace",
    workspaces.map((one) => `${one.name} (${one.slug})`),
  );
  return workspaces.find((one) => `${one.name} (${one.slug})` === picked);
}

type Interaction = "approvals" | "questions";
type Command = (
  ctx: ExtensionCommandContext,
  words: string[],
  opening: number,
) => Promise<void>;

export default function leverage(pi: ExtensionAPI): void {
  // Leverage's models are Pi models of this provider. Leverage runs them, so
  // Pi never streams from it.
  const offer = (models: ReturnType<typeof piModel>[]) =>
    pi.registerProvider("leverage", {
      name: "Leverage",
      baseUrl: "https://leverage.invalid",
      apiKey: "remote-session",
      api: "openai-completions",
      models: models.length ? models : [PLACEHOLDER_MODEL],
      streamSimple: () => {
        throw new Error(
          "Use the Leverage composer to send prompts to the remote session.",
        );
      },
    });
  offer([]);
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
  // Pi's terminal, which the tool cards draw into.
  let terminal: TUI | undefined;
  let working: BorderStatus | undefined;
  let redrawConversation = () => {};
  let dialogCount = 0;
  // The Leverage models Pi offers, and the choice Pi shows as selected.
  let hosted: HostedModel[] = [];
  let selected = "";
  let recreating = false;

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
    const shown = view;
    const draftStatus = {
      settings: draft,
      place: draftContext,
      error: draftError,
      unconfirmed: !!pendingCreation,
    };
    // Other modes forward widget text, so only the terminal gets colors.
    const theme = ctx.mode === "tui" ? ctx.ui.theme : undefined;
    if (!theme) {
      ctx.ui.setWidget("leverage-session", statusLines(shown, draftStatus));
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
      // A theme change invalidates the widget. The lines then take the new colors.
      let lines: string[] | undefined;
      return {
        invalidate() {
          lines = undefined;
        },
        render: (width: number) => {
          lines ??= statusLines(shown, draftStatus, theme);
          return [
            ...(indicator ? indicator.render(width) : []),
            ...lines.flatMap((line) => wrapTextWithAnsi(line, width)),
          ];
        },
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
  // Takes every waiting message back from Leverage and puts its text in the
  // editor, above whatever is typed there, the way Pi restores its queue.
  const dequeue = async (editor: {
    getText(): string;
    setText(text: string): void;
  }) => {
    const current = requireSession(true);
    const waiting = (current.view.docs["pi.inbox"]?.items ?? []).filter(
      (item) => item.mode !== "write",
    );
    if (!waiting.length) {
      return;
    }
    for (const item of waiting) {
      await workspace.cancelQueued(
        current.session.id,
        String(item.id),
        current.signal,
      );
    }
    const texts = waiting.map((item) => userText(item.content));
    editor.setText(
      [...texts, editor.getText()].filter((one) => one.trim()).join("\n\n"),
    );
  };
  const showInteraction = async (kind: Interaction) => {
    await requireSession().interactions!.show(kind);
  };
  // Runs what a Pi control does in a Leverage session and reports a failure.
  // Requests wait to open their dialogs meanwhile.
  const perform = (
    ctx: ExtensionContext,
    opening: number,
    action: () => Promise<void>,
  ) => {
    dialogCount++;
    void action()
      .catch((error: unknown) => {
        if (opening === generation) {
          report(ctx, error);
        }
      })
      .finally(() => {
        dialogCount--;
      });
  };
  // A message Leverage did not store goes back into the composer to send again.
  // One it has not confirmed goes again on its own.
  const restore = (
    error: unknown,
    text: string,
    editor: { getText(): string; setText(text: string): void },
  ) => {
    if (!(error instanceof UnconfirmedError) && !editor.getText().trim()) {
      editor.setText(text);
    }
  };
  // Pi's history of the session: Leverage's older messages, page by page.
  const history = async (ctx: ExtensionContext) => {
    const current = requireSession();
    const { session, signal } = current;
    const snapshot = await workspace.bootstrap(session.id, signal);
    await viewRemoteHistory(ctx, session, signal, {
      messages: snapshot.messages,
      members: current.doc.members,
      viewerId: current.doc.userId,
    });
  };
  /**
   * Offers Leverage's models to Pi's model controls: the session's family,
   * or every family Leverage runs for a draft.
   */
  const offerModels = async (family?: ProviderFamily) => {
    const [models, providers] = await Promise.all([
      workspace.models(lifetime.signal),
      family ? undefined : workspace.providers(lifetime.signal),
    ]);
    const runnable = providers
      ? runnableFamilies(providers, models)
      : undefined;
    hosted = models.filter(
      (one) => !one.legacy && (runnable?.[one.family] ?? one.family === family),
    );
    offer(hosted.map(piModel));
  };
  // Shows a model and effort as Pi's selection, so Pi's controls start there.
  const select = async (choice: ModelChoice, ctx: ExtensionContext) => {
    const model = ctx.modelRegistry.find("leverage", choice.model);
    if (!model) {
      return;
    }
    selected = `${choice.model}/${choice.reasoningEffort ?? ""}`;
    try {
      await pi.setModel(model);
      const level = THINKING_LEVELS.find(
        (one) => one === choice.reasoningEffort,
      );
      if (level) {
        pi.setThinkingLevel(level);
      }
    } catch {
      // A Pi without model controls keeps its own selection.
    }
  };
  // The model and effort the next message uses, as Leverage knows them.
  const current = (): ModelChoice | undefined => {
    const model = view
      ? (view.nextModel?.model ?? view.session.model)
      : draft?.model;
    const reasoningEffort = view
      ? view.nextModel
        ? view.nextModel.reasoningEffort
        : view.session.reasoningEffort
      : draft?.reasoningEffort;
    return model
      ? { model, ...(reasoningEffort ? { reasoningEffort } : {}) }
      : undefined;
  };
  // A model change Leverage reports, by anyone, shows in Pi's controls.
  const follow = (ctx: ExtensionContext) => {
    const choice = current();
    if (!choice || view?.nextModel) {
      return;
    }
    if (`${choice.model}/${choice.reasoningEffort ?? ""}` !== selected) {
      void select(choice, ctx);
    }
  };
  /**
   * Pi's model and thinking controls choose the model of the next message, as
   * a Pi Durable conversation keeps its model in its agent document.
   */
  const choose = (
    model: string,
    reasoningEffort: string | undefined,
    ctx: ExtensionContext,
  ) => {
    const picked = hosted.find((one) => one.id === model);
    if (!picked) {
      return;
    }
    selected = `${model}/${reasoningEffort ?? ""}`;
    if (view) {
      const { session } = view;
      const same =
        model === session.model &&
        (reasoningEffort ?? null) === (session.reasoningEffort ?? null);
      view.nextModel = same
        ? undefined
        : { model, ...(reasoningEffort ? { reasoningEffort } : {}) };
    } else if (draft) {
      draft.model = model;
      draft.providerFamily = picked.family;
      draft.reasoningEffort = reasoningEffort;
    }
    status(ctx);
  };

  const attach = async (session: WorkspaceSession, ctx: ExtensionContext) => {
    ensureApi();
    const owner = lifetime;
    view?.close();
    composerKey = `${api.connection.host}/${api.connection.workspace}/${session.id}`;
    view = new SessionView(pi, ctx, session, owner.signal, {
      changed: () => {
        status(ctx);
        follow(ctx);
      },
      idle: () => !busy() && !creating,
      opened: () => redrawConversation(),
      revoked: () => owner.abort(),
    });
    void offerModels(session.providerFamily)
      .then(() => follow(ctx))
      .catch((error: unknown) => {
        if (!owner.signal.aborted) {
          report(ctx, error);
        }
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
      throw new Error("Wait until Leverage confirms the new session.");
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
      // The session exists, so the open view sends the prompt from here on.
      if (opening === generation) {
        draft = undefined;
        pendingCreation = undefined;
      }
      await requireSession(true).send(prompt);
    } catch (error) {
      if (opening === generation && pendingCreation === prompt) {
        if (error instanceof UnconfirmedError) {
          void recreate(prompt, ctx, opening);
        } else {
          pendingCreation = undefined;
        }
      }
      throw error;
    } finally {
      if (opening === generation) {
        creating = false;
        status(ctx);
      }
    }
  };
  // An unconfirmed setup goes again with the same request ID until Leverage
  // answers, so Leverage makes one session.
  const recreate = async (
    prompt: Prompt,
    ctx: ExtensionContext,
    opening: number,
  ) => {
    if (recreating) {
      return;
    }
    recreating = true;
    try {
      let wait = 1_000;
      while (opening === generation && pendingCreation === prompt) {
        await new Promise((resolve) => setTimeout(resolve, wait));
        wait = Math.min(wait * 2, 30_000);
        if (opening !== generation || pendingCreation !== prompt || creating) {
          continue;
        }
        await createAndSend(prompt, ctx).catch((error: unknown) => {
          if (!(error instanceof UnconfirmedError) && opening === generation) {
            report(ctx, error);
          }
        });
      }
    } finally {
      recreating = false;
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
      await offerModels();
      if (opening === generation) {
        follow(ctx);
      }
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
      terminal = tui;
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
        // A keystroke is what keeps the person online, not an open window.
        workspace.active();
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
        // Pi's own keys: a follow-up waits for the turn to end, and the
        // dequeue key brings every waiting message back into the editor.
        if (
          !completing &&
          !busy() &&
          keys.matches(data, "app.message.followUp")
        ) {
          const text = editor.getText().trim();
          if (text && view) {
            editor.addToHistory?.(text);
            editor.setText("");
            void submit({ text }, ctx, true).catch((error: unknown) => {
              if (opening === generation) {
                report(ctx, error);
                restore(error, text, editor);
              }
            });
          }
          return;
        }
        // Pi's tree key shows the session's history, which Leverage keeps.
        if (
          !completing &&
          !busy() &&
          view &&
          keys.matches(data, "app.session.tree")
        ) {
          perform(ctx, opening, () => history(ctx));
          return;
        }
        if (
          !completing &&
          !busy() &&
          keys.matches(data, "app.message.dequeue")
        ) {
          void dequeue(editor).catch((error: unknown) => {
            if (opening === generation) {
              report(ctx, error);
            }
          });
          return;
        }
        if (matchesKey(data, "enter")) {
          const typed = editor.getText().trim();
          const [command, ...args] = typed.split(/\s+/);
          // Pi's /compact and /tree act on the session Leverage keeps.
          if (view && (command === "/compact" || command === "/tree")) {
            editor.addToHistory?.(typed);
            editor.setText("");
            perform(ctx, opening, () =>
              command === "/tree"
                ? history(ctx)
                : requireSession(true).compact(),
            );
            return;
          }
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
    // A session's model is Pi's to choose, so F1 shows the session's details.
    await textDrawer(ctx, {
      title: "Session details",
      read: () =>
        [
          view?.session.title || "Untitled session",
          view?.place,
          view?.session.id,
          view?.model,
          "",
          "People",
          ...(view ? roster(view.doc).map((one) => personText(one)) : []),
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      signal: lifetime.signal,
    });
  };
  // Reads the session again after its title or archive state changes.
  const reload = async (current: SessionView, ctx: ExtensionContext) => {
    await current.sync();
    pi.setSessionName(current.session.title || UNTITLED);
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
    // Signs Pi in through the browser, as leverage login does.
    login: async (ctx, words) => {
      const host = loginHost(flag("host"));
      const login = await signIn(host, (code, link) => {
        ctx.ui.notify(`Confirm ${code} in the browser: ${link}`, "info");
        browse(link);
      });
      const workspaces = await signedInWorkspaces(host, login);
      if (workspaces.length === 0) {
        await endSignIn(host, login);
        throw new Error("Your Leverage account has no workspace yet.");
      }
      const chosen = await chooseWorkspace(ctx, workspaces, words[0]).catch(
        async (error: unknown) => {
          await endSignIn(host, login);
          throw error;
        },
      );
      if (!chosen) {
        await endSignIn(host, login);
        return;
      }
      saveLogin({ host, workspace: chosen.slug, ...login });
      // The next command connects with this sign-in.
      disconnect();
      ctx.ui.notify(
        `Signed in to ${chosen.slug}. /leverage new starts a session.`,
        "info",
      );
    },
    // Forgets Pi's sign-in and ends it on Leverage.
    logout: async (ctx) => {
      const login = forgetLogin();
      if (login) {
        await endSignIn(login.host, login);
      }
      let cliSignedIn = false;
      try {
        resolveConnection({});
        cliSignedIn = true;
      } catch {
        // Nothing else signs Pi in.
      }
      ctx.ui.notify(
        cliSignedIn
          ? "Signed out of Pi. The Leverage CLI keeps its own sign-in: leverage logout ends it."
          : "Signed out.",
        "info",
      );
      if (active) {
        await ctx.newSession();
      } else {
        disconnect();
      }
    },
    settings: (ctx, words) =>
      editSettings(
        ctx,
        SETTING_SECTIONS.find((one) => one === words[0]),
      ),
    approvals: () => showInteraction("approvals"),
    questions: () => showInteraction("questions"),
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
      const { skills } = current.doc;
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
      createEntryComponent(
        () => {
          const marker = historyMarkerSchema.safeParse(entry.data);
          if (!marker.success) {
            return undefined;
          }
          return view?.session.id === marker.data.sessionId
            ? view.show(marker.data.id)
            : undefined;
        },
        options.expanded,
        theme,
        terminal ?? NO_TERMINAL,
        process.cwd(),
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
        restore(error, event.text, {
          getText: () => ctx.ui.getEditorText(),
          setText: (text) => ctx.ui.setEditorText(text),
        });
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
  // A Leverage session has one line of history, so Pi's tree shows that history.
  pi.on("session_before_tree", (_event, ctx) => {
    if (!active) {
      return;
    }
    if (view) {
      perform(ctx, generation, () => history(ctx));
    }
    return { cancel: true };
  });
  // Pi's /name names the Leverage session, or the session a draft creates.
  pi.on("session_info_changed", async (event, ctx) => {
    const name = event.name?.trim();
    if (!active || !name) {
      return;
    }
    if (!view) {
      if (draft) {
        draft.title = name;
      }
      return;
    }
    // The view names Pi's session after Leverage's, which needs no rename.
    const { title } = view.session;
    if (!view.ready || name === title || (!title && name === UNTITLED)) {
      return;
    }
    try {
      await workspace.rename(view.session.id, name, view.signal);
      await reload(view, ctx);
    } catch (error) {
      report(ctx, error);
    }
  });
  pi.on("model_select", (event, ctx) => {
    if (!active) {
      return;
    }
    if (event.model.provider !== "leverage") {
      ctx.ui.notify("A Leverage session runs Leverage's models.", "info");
      const choice = current();
      if (choice) {
        void select(choice, ctx);
      }
      return;
    }
    choose(event.model.id, effortOf(event.model, pi.getThinkingLevel()), ctx);
  });
  pi.on("thinking_level_select", (event, ctx) => {
    if (!active || ctx.model?.provider !== "leverage") {
      return;
    }
    choose(ctx.model.id, effortOf(ctx.model, event.level), ctx);
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
      "Open Leverage: new, sessions, files, outputs, changes, approvals, skills, exit, login, logout",
    handler: async (args, ctx) => {
      const opening = generation;
      dialogCount++;
      try {
        const [action = "sessions", ...words] = args
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        if (!VIEW_COMMANDS.has(action) && !ACCESS_COMMANDS.has(action)) {
          ensureApi();
        }
        const command = Object.hasOwn(commands, action)
          ? commands[action]
          : undefined;
        if (!command) {
          throw new Error(
            "Use /leverage sessions, new, open, files, outputs, changes, connectors, skills, approvals, questions, archive, restore, exit, login, or logout.",
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
