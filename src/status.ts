import {
  rawKeyHint,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { clean } from "./drawers";
import type { SessionView } from "./session";
import type { SessionDraft } from "./workspace/schema";

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
    return [
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
