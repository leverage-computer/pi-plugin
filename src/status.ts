import {
  keyText,
  rawKeyHint,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clean } from "./drawers";
import type { SessionView } from "./session";
import type {
  PresenceEntry,
  SessionDraft,
  WorkspaceMember,
} from "./workspace/schema";
import { type SessionDoc, userText } from "./workspace/view";

/**
 * Where a person is, as the web app's session header puts it. `here` and
 * `typing` have the session open and watched. `idle` has it open but is not
 * watching. `online` is in the workspace, but not on this session.
 */
export type Presence =
  | "typing"
  | "here"
  | "idle"
  | "online"
  | "away"
  | "offline";

export interface Person {
  userId: string;
  name: string;
  presence: Presence;
  isOwner: boolean;
  isSelf: boolean;
  // The agent app the person is online in, when it is one.
  app?: string;
}

const PRESENCE_RANK: Record<Presence, number> = {
  typing: 0,
  here: 1,
  idle: 2,
  online: 3,
  away: 4,
  offline: 5,
};

// Only an agent app gets named. Leverage's own apps and Pi get nothing.
const APP_NAMES: Record<string, string> = {
  codex: "Codex",
  opencode: "OpenCode",
};

/** The agent app an online person is in, if any. An away person has none. */
export function appOf(entry: PresenceEntry | undefined): string | undefined {
  if (entry?.status !== "online") {
    return undefined;
  }
  return (entry.clients ?? []).map((client) => APP_NAMES[client]).find(Boolean);
}

export function memberName(
  members: readonly WorkspaceMember[],
  userId: string,
): string | undefined {
  return members.find((one) => one.id === userId)?.name ?? undefined;
}

/**
 * The owner and everyone who has the session open, the most present first.
 * The owner is listed even when away, with where they are in the workspace.
 */
export function roster(doc: SessionDoc): Person[] {
  const ownerId = doc.session?.ownerId ?? undefined;
  const people = new Map<string, Person>();
  const person = (
    userId: string,
    name: string | undefined,
    presence: Presence,
  ): Person => {
    const app = appOf(doc.presence[userId]);
    return {
      userId,
      name: name || memberName(doc.members, userId) || "Teammate",
      // You are reading the line, so your own row is never away.
      presence: userId === doc.userId ? "here" : presence,
      isOwner: userId === ownerId,
      isSelf: userId === doc.userId,
      ...(app ? { app } : {}),
    };
  };
  if (ownerId) {
    const status = doc.presence[ownerId]?.status;
    people.set(
      ownerId,
      person(
        ownerId,
        undefined,
        status === "online" ? "online" : status === "away" ? "away" : "offline",
      ),
    );
  }
  for (const viewer of doc.viewers) {
    people.set(
      viewer.userId,
      person(
        viewer.userId,
        viewer.userName,
        doc.typing.includes(viewer.userId)
          ? "typing"
          : viewer.state === "idle"
            ? "idle"
            : "here",
      ),
    );
  }
  return [...people.values()].sort(
    (left, right) =>
      PRESENCE_RANK[left.presence] - PRESENCE_RANK[right.presence] ||
      Number(right.isOwner) - Number(left.isOwner) ||
      left.name.localeCompare(right.name),
  );
}

const PRESENCE_MARK: Record<Presence, [ThemeColor, string, string]> = {
  typing: ["accent", "●", "typing…"],
  here: ["success", "●", ""],
  idle: ["warning", "◐", "idle"],
  online: ["warning", "◐", "online"],
  away: ["dim", "○", "away"],
  offline: ["dim", "○", "offline"],
};

/** One person as the status line shows them: a mark, the name, and where they are. */
export function personText(
  one: Person,
  paint: (color: ThemeColor, value: string) => string = (_, value) => value,
): string {
  const [color, mark, state] = PRESENCE_MARK[one.presence];
  const notes = [
    one.isOwner ? "owner" : "",
    one.isSelf ? "you" : "",
    state,
    one.app ? `on ${one.app}` : "",
  ].filter(Boolean);
  return [
    paint(color, mark),
    paint(
      one.presence === "here" || one.presence === "typing" ? "text" : "dim",
      one.name,
    ),
    ...(notes.length ? [paint("muted", `(${notes.join(", ")})`)] : []),
  ].join(" ");
}

export interface DraftStatus {
  settings?: SessionDraft;
  place: string;
  error?: string;
  unconfirmed: boolean;
}

/** Pi's working indicator, which Pi's composer draws in its top border. */
export class BorderStatus extends Loader {
  renderInBorder(width: number): string {
    const line = super.render(width + 2)[1] ?? "";
    return truncateToWidth(
      line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd(),
      width,
      "",
    );
  }
  renderSpinnerInBorder(width: number): string {
    return truncateToWidth(this.getRenderedIndicator(), width, "");
  }
}

/** The lines above the composer. Without a theme, Pi forwards them as plain text. */
export function statusLines(
  view: SessionView | undefined,
  draft: DraftStatus,
  theme?: Theme,
): string[] {
  const paint = (color: ThemeColor, value: string, bold = false) => {
    const text = clean(value);
    return theme ? theme.fg(color, bold ? theme.bold(text) : text) : text;
  };
  const join = (parts: string[]) => parts.join(paint("muted", " · "));
  // Pi's own hint style, as in its startup header.
  const keys = (hints: Array<[string, string]>) =>
    theme ? [join(hints.map(([key, label]) => rawKeyHint(key, label)))] : [];
  const count = (value: number, noun: string) =>
    value === 1 ? `1 ${noun}` : `${value} ${noun}s`;
  const warning = (show: unknown, text: string) =>
    show ? [paint("warning", text)] : [];
  if (view) {
    const approvals = view.interactions?.approvalCount ?? 0;
    const questions = view.interactions?.questionCount ?? 0;
    // Everyone else on the session, always, so a shared session feels shared.
    const others = roster(view.doc).filter((one) => !one.isSelf);
    // Messages waiting for the turn to end, as Pi lists its own queue.
    const waiting = (view.view.docs["pi.inbox"]?.items ?? []).filter(
      (item) => item.mode !== "write",
    );
    return [
      others.length
        ? join(others.map((one) => personText(one, paint)))
        : paint("dim", "Only you here"),
      ...waiting.map((item) =>
        paint("dim", `Follow-up: ${userText(item.content).split("\n")[0]}`),
      ),
      ...(waiting.length
        ? [
            paint(
              "dim",
              `↳ ${keyText("app.message.dequeue")} to edit all queued messages`,
            ),
          ]
        : []),
      ...warning(
        !view.doc.canWrite,
        "Read-only · ask the owner for collaborator access",
      ),
      ...warning(
        approvals,
        `▲ ${count(approvals, "approval")} waiting · F4 to review`,
      ),
      ...warning(
        questions,
        `? ${count(questions, "question")} waiting · /leverage questions`,
      ),
      ...warning(
        view.failedPrompt,
        "▲ Send not confirmed · /leverage retry sends the same message",
      ),
      ...keys([
        ["F1", "details"],
        ["F2", "model"],
        ["F3", "sessions"],
        ["F4", "approvals"],
      ]),
    ];
  }
  const { settings } = draft;
  return [
    paint("accent", "New Leverage session", true),
    settings
      ? join([
          paint("text", draft.place),
          paint(
            "text",
            settings.model
              ? `${settings.model}${settings.reasoningEffort ? ` / ${settings.reasoningEffort}` : ""}`
              : "Default model",
          ),
        ])
      : paint(
          draft.error ? "error" : "dim",
          draft.error ?? "Loading the workspace…",
        ),
    ...warning(
      draft.unconfirmed,
      "▲ Setup not confirmed · /leverage retry continues the same session",
    ),
    ...keys([
      ["F1", "context"],
      ["F2", "model"],
      ["F3", "sessions"],
    ]),
  ];
}

/** Pi's footer layout: the folder and session name, then the connection and model. */
export function footerLines(
  theme: Theme,
  width: number,
  place: string,
  stream: string,
  model: string,
  usage = "",
): string[] {
  const connection =
    stream === "live"
      ? theme.fg("dim", stream)
      : theme.fg(stream === "disconnected" ? "error" : "warning", stream);
  const state = usage
    ? `${connection}${theme.fg("dim", ` · ${clean(usage)}`)}`
    : connection;
  const right = theme.fg("dim", clean(model));
  const gap = width - visibleWidth(state) - visibleWidth(right);
  return [
    truncateToWidth(
      theme.fg("dim", clean(place)),
      width,
      theme.fg("dim", "..."),
    ),
    gap >= 2
      ? `${state}${" ".repeat(gap)}${right}`
      : truncateToWidth(state, width),
  ];
}
