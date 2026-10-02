import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { api } from "../api";
import { chooseDrawer, type DrawerItem, textDrawer } from "../drawers";
import { workspace } from "./api";
import type { Channel, SessionDraft, WorkspaceSession } from "./schema";

const relative = new Intl.RelativeTimeFormat("en", {
  numeric: "auto",
  style: "narrow",
});
function ago(time?: string): string {
  const minutes = Math.round((Date.parse(time ?? "") - Date.now()) / 60_000);
  if (!Number.isFinite(minutes)) {
    return "";
  }
  if (minutes > -60) {
    return relative.format(minutes, "minute");
  }
  if (minutes > -1440) {
    return relative.format(Math.round(minutes / 60), "hour");
  }
  return relative.format(Math.round(minutes / 1440), "day");
}
// Where a session works: its channel, its repository, or neither.
function placeName(session: WorkspaceSession, channels: Channel[]): string {
  const channel = channels.find((one) => one.id === session.channelId);
  return (
    [
      session.channelId
        ? channel?.kind === "dm"
          ? "Direct message"
          : `#${channel?.name ?? "channel"}`
        : "",
      session.repo
        ? `${session.repo.fullName}${session.requestedBranch ? ` / ${session.requestedBranch}` : ""}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ") || "Standalone"
  );
}
export function contextName(
  draft: SessionDraft,
  channels: Channel[] = [],
): string {
  const context = draft.context;
  return context.type === "channel"
    ? `#${channels.find((one) => one.id === context.channelId)?.name ?? "channel"}`
    : "Standalone";
}

export async function editDraft(
  ctx: ExtensionContext,
  draft: SessionDraft,
  signal: AbortSignal,
  changed: (context: string) => void,
  initial?: string,
): Promise<void> {
  let action = initial;
  while (!signal.aborted) {
    if (draft.sessionId) {
      await textDrawer(ctx, {
        title: "Session setup is waiting",
        read: () =>
          "The empty session already exists. Retry the original prompt to finish its setup. Start a new session to use different settings.",
        signal,
      });
      return;
    }
    const [providers, channels, models, { excludedChannelIds }] =
      await Promise.all([
        workspace.providers(signal),
        workspace.channels(signal),
        workspace.models(signal),
        workspace.choices(signal),
      ]);
    action ??= await chooseDrawer(ctx, {
      title: "New session settings",
      items: [
        {
          value: "context",
          label: "Channel",
          detail: contextName(draft, channels),
        },
        {
          value: "model",
          label: "Model and reasoning",
          detail: draft.model ?? "Leverage default",
        },
        { value: "done", label: "Back to composer" },
      ],
      signal,
      subtitle: "Selections and defaults come from Leverage",
    });
    if (!action) {
      return;
    }
    if (action === "done") {
      return;
    }
    if (action === "context") {
      const context = draft.context;
      const choices: DrawerItem[] = [
        {
          value: "none",
          label: "Standalone",
          detail: "No channel",
          current: context.type === "none",
        },
        ...channels
          .filter((one) => !excludedChannelIds.includes(one.id))
          .map((one) => ({
            value: one.id,
            label: `#${one.name ?? "channel"}`,
            detail: "Channel",
            current: context.type === "channel" && context.channelId === one.id,
          })),
      ];
      const picked = await chooseDrawer(ctx, {
        title: "Session context",
        items: choices,
        signal,
        subtitle: "The channel whose folder and files the agent works in",
      });
      if (picked) {
        draft.context =
          picked === "none"
            ? { type: "none" }
            : { type: "channel", channelId: picked };
      }
    } else if (action === "model") {
      const usable = models.filter(
        (one) => !one.legacy && providers[one.family],
      );
      const picked = await chooseDrawer(ctx, {
        title: "Leverage model",
        items: [
          {
            value: "default",
            label: "Leverage default",
            detail: "Channel or workspace setting",
            current: !draft.model,
          },
          ...usable.map((one) => ({
            value: one.id,
            label: one.label,
            detail: one.family === "codex" ? "Codex" : "Claude",
            current: draft.model === one.id,
          })),
        ],
        signal,
      });
      if (picked === "default") {
        draft.model = undefined;
        draft.providerFamily = undefined;
        draft.reasoningEffort = undefined;
      } else if (picked) {
        const model = usable.find((one) => one.id === picked)!;
        draft.model = model.id;
        draft.providerFamily = model.family;
        draft.reasoningEffort = undefined;
        if (model.reasoningEfforts.length) {
          const effort = await chooseDrawer(ctx, {
            title: "Reasoning effort",
            items: [
              {
                value: "default",
                label: "Leverage default",
                detail: model.defaultReasoningEffort ?? undefined,
                current: true,
              },
              ...model.reasoningEfforts.map((one) => ({
                value: one,
                label: one,
              })),
            ],
            signal,
          });
          if (effort && effort !== "default") {
            draft.reasoningEffort = effort;
          }
        }
      }
    }
    changed(contextName(draft, channels));
    // A direct setting key returns to the composer after one change.
    if (initial) {
      return;
    }
    action = undefined;
  }
}

// Frames that change which sessions the picker lists, or how.
const LIST_CHANGES = new Set([
  "session.created",
  "session.updated",
  "session.list.changed",
  "session.access_revoked",
  "session.rename.accepted",
]);

function sessionItems(
  sessions: WorkspaceSession[],
  channels: Channel[],
): DrawerItem[] {
  return sessions
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .map((one) => ({
      value: one.id,
      label: one.title || "Untitled session",
      detail: [
        placeName(one, channels),
        one.status.charAt(0).toUpperCase() + one.status.slice(1),
        one.model ?? one.providerFamily,
        ago(one.updatedAt ?? undefined),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
}

/**
 * Every session the person can open, newest first and updated live. With
 * --leverage-directory it starts at that channel. Tab offers a session's
 * own actions.
 */
export async function sessionsDrawer(
  ctx: ExtensionContext,
  signal: AbortSignal,
  query = "",
): Promise<string | undefined> {
  let archived = false;
  let scoped = true;
  const socket = await workspace.socket(signal);
  // The connection names the viewer, which tells whose sessions are shared.
  await socket.connect().catch(() => {});
  while (!signal.aborted) {
    const [channels, choices] = await Promise.all([
      workspace.channels(signal),
      workspace.choices(signal),
    ]);
    const home = channels.find(
      (one) =>
        api.connection.directory === `/${api.connection.workspace}/${one.name}`,
    );
    const listed = async () => {
      const sessions = await workspace.sessions(signal, archived);
      const viewer = socket.userId;
      return sessions.filter(
        (one) =>
          (!scoped || !home || one.channelId === home.id) &&
          // The channel --leverage-directory names stays listed, even when left out.
          (!one.channelId ||
            one.channelId === home?.id ||
            !choices.excludedChannelIds.includes(one.channelId)) &&
          // A standalone session has no channel and no repository.
          (choices.showStandalone || one.channelId || one.repo) &&
          // A shared session is someone else's, and its channel does not show it.
          // Without a known owner or viewer, the session is not hidden.
          (choices.showShared ||
            !one.ownerId ||
            !viewer ||
            one.ownerId === viewer ||
            one.visibility === "channel"),
      );
    };
    const fixed = (): DrawerItem[] => [
      { value: "new", label: "+ New session" },
      { value: "refresh", label: "Refresh" },
      {
        value: "archive",
        label: archived ? "Show active sessions" : "Show archived sessions",
      },
      ...(home
        ? [
            {
              value: "scope",
              label: scoped ? "Show every channel" : `Show only #${home.name}`,
            },
          ]
        : []),
    ];
    let sessions = await listed();
    const picked = await chooseDrawer(ctx, {
      title: "Leverage sessions",
      items: [...fixed(), ...sessionItems(sessions, channels)],
      signal,
      query,
      more: "actions",
      live: (update) =>
        socket.onEvent((event) => {
          if (!LIST_CHANGES.has(event.type)) {
            return;
          }
          void listed()
            .then((next) => {
              sessions = next;
              update([...fixed(), ...sessionItems(next, channels)]);
            })
            .catch(() => {});
        }),
    });
    if (picked === "refresh") {
      continue;
    }
    if (picked === "archive") {
      archived = !archived;
      continue;
    }
    if (picked === "scope") {
      scoped = !scoped;
      continue;
    }
    if (picked?.startsWith("more:")) {
      const session = sessions.find((one) => `more:${one.id}` === picked);
      const opened = session
        ? await sessionActions(ctx, session, archived, signal)
        : undefined;
      if (opened) {
        return opened;
      }
      continue;
    }
    return picked;
  }
}

// Open, rename, archive or restore a session without opening it first.
async function sessionActions(
  ctx: ExtensionContext,
  session: WorkspaceSession,
  archived: boolean,
  signal: AbortSignal,
): Promise<string | undefined> {
  const title = session.title || "Untitled session";
  const action = await chooseDrawer(ctx, {
    title,
    items: [
      { value: "open", label: "Open" },
      { value: "rename", label: "Rename" },
      archived
        ? { value: "restore", label: "Restore" }
        : { value: "archive", label: "Archive" },
    ],
    signal,
  });
  switch (action ?? "") {
    case "open":
      return session.id;
    case "rename": {
      const name = await ctx.ui.input("New name", title, { signal });
      if (name?.trim()) {
        await workspace.rename(session.id, name, signal);
      }
      return undefined;
    }
    case "archive":
      await workspace.archive(session.id, signal);
      ctx.ui.notify(`Archived ${title}.`, "info");
      return undefined;
    case "restore":
      await workspace.unarchive(session.id, signal);
      ctx.ui.notify(`Restored ${title}.`, "info");
      return undefined;
    default:
      return undefined;
  }
}
