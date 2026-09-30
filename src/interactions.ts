import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { clean } from "./drawers";
import { planOf, questionsOf } from "./history";
import { workspace } from "./workspace/api";
import type {
  Invocation,
  SessionInput,
  TranscriptEvent,
  WorkspaceMember,
  WorkspaceSession,
} from "./workspace/schema";

type Interaction = "approvals" | "questions" | "inbox" | "model";

/** The model and effort a person picked for their next message. */
export type ModelChoice = { model: string; reasoningEffort?: string };

/** What the dialogs read: the shared session's pending work. */
export interface InteractionSource {
  readonly id: string;
  readonly session?: WorkspaceSession;
  readonly userId?: string;
  readonly members: readonly WorkspaceMember[];
  pendingApprovals(): Invocation[];
  pendingQuestions(): TranscriptEvent[];
  queued(): SessionInput[];
  refresh(): Promise<void>;
}

/**
 * Who may approve a call, and who may make that permanent. This is
 * Leverage's own rule, so the dialog never offers a choice it refuses.
 */
function approvalRights(
  invocation: Invocation,
  source: InteractionSource,
): { approve: boolean; always: boolean } {
  // Approval runs the call as someone. Without anyone, nobody can run it.
  if (invocation.actingUserId === null) {
    return { approve: false, always: false };
  }
  const viewer = source.userId;
  const role = source.members.find((one) => one.id === viewer)?.role;
  const staff = role === "owner" || role === "admin";
  const connector =
    invocation.workspaceConnectorId ||
    invocation.connectorOwnerUserId ||
    invocation.connectorScope;
  // A first-party tool: an "always" rule belongs to the session owner.
  if (!connector) {
    return { approve: true, always: source.session?.ownerId === viewer };
  }
  const owner =
    !!invocation.connectorOwnerUserId &&
    invocation.connectorOwnerUserId === viewer;
  // A deleted connection keeps its snapshot but takes no new rules.
  const live = !!invocation.workspaceConnectorId;
  switch (invocation.connectorScope ?? "") {
    case "user":
      return { approve: owner, always: owner && live };
    case "channel":
      return { approve: true, always: live && (owner || staff) };
    case "workspace":
      return { approve: true, always: live && staff };
    default:
      return { approve: false, always: false };
  }
}

/** The dialogs a pending request may open. Every string shown is cleaned. */
interface Dialogs {
  hasUI: boolean;
  notify(message: string, level: "info" | "warning"): void;
  choose(options: {
    title: string;
    choices: string[];
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  input(options: {
    title: string;
    placeholder?: string;
    signal?: AbortSignal;
  }): Promise<string | undefined>;
  confirm(options: {
    title: string;
    body: string;
    signal?: AbortSignal;
  }): Promise<boolean>;
}

function dialogs(ctx: ExtensionContext): Dialogs {
  return {
    hasUI: ctx.hasUI,
    notify: (message, level) => ctx.ui.notify(clean(message), level),
    async choose({ title, choices, signal }) {
      const labels = choices.map(clean);
      const picked = await ctx.ui.select(clean(title), labels, { signal });
      return picked === undefined ? undefined : choices[labels.indexOf(picked)];
    },
    input: ({ title, placeholder, signal }) =>
      ctx.ui.input(
        clean(title),
        placeholder === undefined ? undefined : clean(placeholder),
        { signal },
      ),
    confirm: ({ title, body, signal }) =>
      ctx.ui.confirm(clean(title), clean(body), { signal }),
  };
}

// A short, readable view of a tool call's arguments.
function argumentsOf(invocation: Invocation): string {
  const args = invocation.effectiveArguments ?? invocation.originalArguments;
  const lines = JSON.stringify(args, null, 2).split("\n");
  return lines.length > 20
    ? [...lines.slice(0, 20), `… ${lines.length - 20} more lines`].join("\n")
    : lines.join("\n");
}

function toolName(invocation: Invocation): string {
  return invocation.toolDisplayName ?? invocation.tool;
}

/**
 * The dialogs for what waits on a person: tool approvals, the agent's
 * questions, queued messages, and the model for the next message.
 */
export class PendingInteractions {
  private active?: { id?: string; controller: AbortController };
  private closed = false;
  private lastCanWrite: boolean;
  private readonly abort = () => this.close();
  private readonly ui: Dialogs;

  constructor(
    ctx: ExtensionContext,
    private readonly source: InteractionSource,
    private readonly signal: AbortSignal,
    private readonly canWrite: () => boolean = () => true,
    private readonly chooseModel: (choice: ModelChoice) => void = () => {},
  ) {
    this.ui = dialogs(ctx);
    this.lastCanWrite = canWrite();
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) {
      this.close();
    }
  }

  get hasDialog(): boolean {
    return this.active !== undefined;
  }

  get approvalCount(): number {
    return this.closed ? 0 : this.source.pendingApprovals().length;
  }

  get questionCount(): number {
    return this.closed ? 0 : this.source.pendingQuestions().length;
  }

  /**
   * Closes an open dialog whose request was resolved elsewhere, or whose
   * decision this person may no longer make.
   */
  sync(): void {
    const writable = this.canWrite();
    if (this.lastCanWrite && !writable) {
      this.active?.controller.abort();
    }
    this.lastCanWrite = writable;
    const id = this.active?.id;
    if (!id) {
      return;
    }
    const open =
      this.source.pendingApprovals().some((one) => one.id === id) ||
      this.source.pendingQuestions().some((one) => one.data.toolUseId === id);
    if (!open) {
      this.active?.controller.abort();
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.active?.controller.abort();
    this.signal.removeEventListener("abort", this.abort);
  }

  async show(kind: Interaction): Promise<void> {
    if (this.closed) {
      return;
    }
    if (!this.canWrite() && kind !== "approvals") {
      throw new Error(
        "This session is read-only. Ask the owner for collaborator access.",
      );
    }
    if (!this.ui.hasUI) {
      throw new Error(
        "Open Pi interactively to answer requests and choose session settings.",
      );
    }
    if (this.active) {
      this.ui.notify("Close the current Leverage dialog first.", "info");
      return;
    }
    const active = {
      controller: new AbortController(),
      id: undefined as string | undefined,
    };
    this.active = active;
    const signal = AbortSignal.any([this.signal, active.controller.signal]);
    try {
      if (kind === "model") {
        return await this.model(signal);
      }
      if (kind === "inbox") {
        return await this.inbox(signal);
      }
      await this.source.refresh();
      if (signal.aborted) {
        return;
      }
      if (kind === "approvals") {
        const invocation = await this.pick(
          this.source.pendingApprovals(),
          "approvals",
          (one) => `${toolName(one)} · ${one.id}`,
          signal,
        );
        if (invocation) {
          active.id = invocation.id;
          await this.approval(invocation, signal);
        }
        return;
      }
      const question = await this.pick(
        this.source.pendingQuestions(),
        "questions",
        (one) =>
          planOf(one)
            ? "Review the plan"
            : (questionsOf(one)[0]?.question ?? "Question"),
        signal,
      );
      if (question) {
        active.id = question.data.toolUseId;
        await this.question(question, signal);
      }
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    } finally {
      if (this.active === active) {
        this.active = undefined;
      }
    }
  }

  // Picks one waiting item. A single item opens directly.
  private async pick<T>(
    items: T[],
    kind: string,
    label: (item: T) => string,
    signal: AbortSignal,
  ): Promise<T | undefined> {
    if (!items.length) {
      this.ui.notify(`No ${kind} are waiting.`, "info");
      return undefined;
    }
    if (items.length === 1) {
      return items[0];
    }
    const labels = items.map((item, index) => `${index + 1}. ${label(item)}`);
    const picked = await this.ui.choose({
      title: `Leverage ${kind}`,
      choices: labels,
      signal,
    });
    return picked === undefined ? undefined : items[labels.indexOf(picked)];
  }

  private async approval(
    invocation: Invocation,
    signal: AbortSignal,
  ): Promise<void> {
    const detail = [
      `Allow ${toolName(invocation)}?`,
      invocation.connectorName ? `Through ${invocation.connectorName}` : "",
      invocation.actingUserName ? `Runs as ${invocation.actingUserName}` : "",
      argumentsOf(invocation),
    ]
      .filter(Boolean)
      .join("\n");
    if (!this.canWrite()) {
      await this.ui.choose({
        title: `${detail}\nRead-only · collaborator access is required to decide`,
        choices: ["Back"],
        signal,
      });
      return;
    }
    const rights = approvalRights(invocation, this.source);
    const picked = await this.ui.choose({
      title: rights.approve
        ? detail
        : `${detail}\nOnly the connection's owner can approve this`,
      choices: [
        ...(rights.approve ? ["Approve once", "Approve for this session"] : []),
        ...(rights.always ? ["Always approve"] : []),
        "Deny",
        "Leave pending",
      ],
      signal,
    });
    if (picked === undefined) {
      return;
    }
    if (picked === "Leave pending") {
      return;
    }
    if (signal.aborted) {
      return;
    }
    if (!this.canWrite()) {
      return;
    }
    if (picked === "Deny") {
      const reason = await this.ui.input({
        title: "Reason for denial",
        placeholder: "Optional reason",
        signal,
      });
      if (reason === undefined) {
        return;
      }
      if (signal.aborted) {
        return;
      }
      await workspace.decide(
        invocation.id,
        {
          action: "deny",
          ...(reason.trim() ? { denialReason: reason.trim() } : {}),
        },
        signal,
      );
    } else {
      await workspace.decide(
        invocation.id,
        {
          action: "approve",
          approvalScope:
            picked === "Approve once"
              ? "once"
              : picked === "Always approve"
                ? "always"
                : "session",
        },
        signal,
      );
    }
    if (!signal.aborted) {
      await this.source.refresh();
    }
  }

  private async question(
    event: TranscriptEvent,
    signal: AbortSignal,
  ): Promise<void> {
    const toolUseId = event.data.toolUseId;
    if (planOf(event)) {
      await this.plan(toolUseId, signal);
      return;
    }
    const answers: Record<string, string> = {};
    for (const one of questionsOf(event)) {
      const answer = one.multiSelect
        ? await this.several(one.question, one.options, signal)
        : await this.single(one.question, one.options, signal);
      if (answer === undefined) {
        return;
      }
      if (signal.aborted) {
        return;
      }
      answers[one.question] = answer;
    }
    const summary = Object.entries(answers)
      .map(([question, answer]) => `${question}: ${answer}`)
      .join("\n");
    const confirmed = await this.ui.confirm({
      title: "Send these answers?",
      body: summary || "No answers",
      signal,
    });
    if (!confirmed) {
      return;
    }
    if (signal.aborted) {
      return;
    }
    await workspace.answer(this.source.id, toolUseId, { answers }, signal);
  }

  // The plan itself is in the conversation. Changes carry the person's note.
  private async plan(toolUseId: string, signal: AbortSignal): Promise<void> {
    const picked = await this.ui.choose({
      title: "Review the plan above",
      choices: ["Approve the plan", "Ask for changes", "Leave it pending"],
      signal,
    });
    if (picked === "Approve the plan") {
      await workspace.answer(
        this.source.id,
        toolUseId,
        { answers: { plan: "approved" } },
        signal,
      );
      return;
    }
    if (picked !== "Ask for changes") {
      return;
    }
    const comment = await this.ui.input({
      title: "What should change?",
      placeholder: "Your note for the agent",
      signal,
    });
    if (comment === undefined) {
      return;
    }
    if (signal.aborted) {
      return;
    }
    const notes = comment.trim()
      ? {
          plan: {
            notes: JSON.stringify([
              { selectedText: "", comment: comment.trim() },
            ]),
          },
        }
      : undefined;
    await workspace.answer(
      this.source.id,
      toolUseId,
      {
        answers: { plan: "changes_requested" },
        ...(notes ? { annotations: notes } : {}),
      },
      signal,
    );
  }

  // One option, or a written answer of the person's own.
  private async single(
    question: string,
    options: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const labels = options.map((option, index) => `${index + 1}. ${option}`);
    const picked = await this.ui.choose({
      title: question,
      choices: [...labels, "Write another answer"],
      signal,
    });
    if (picked !== "Write another answer") {
      return picked === undefined ? undefined : options[labels.indexOf(picked)];
    }
    while (!signal.aborted) {
      const written = await this.ui.input({
        title: question,
        placeholder: "Your answer",
        signal,
      });
      if (written === undefined) {
        return undefined;
      }
      if (written.trim()) {
        return written.trim();
      }
      this.ui.notify("Write an answer, or press Escape to go back.", "info");
    }
    return undefined;
  }

  // Several options, toggled one at a time until the person is done.
  private async several(
    question: string,
    options: string[],
    signal: AbortSignal,
  ): Promise<string | undefined> {
    let selected: string[] = [];
    while (!signal.aborted) {
      const labels = options.map(
        (option, index) =>
          `${selected.includes(option) ? "[x]" : "[ ]"} ${index + 1}. ${option}`,
      );
      const picked = await this.ui.choose({
        title: question,
        choices: [...labels, "Done"],
        signal,
      });
      if (picked === undefined) {
        return undefined;
      }
      if (picked === "Done" && selected.length) {
        return selected.join(", ");
      }
      if (picked === "Done") {
        this.ui.notify("Pick at least one answer.", "info");
        continue;
      }
      const option = options[labels.indexOf(picked)];
      if (option) {
        selected = selected.includes(option)
          ? selected.filter((one) => one !== option)
          : [...selected, option];
      }
    }
    return undefined;
  }

  // Queued messages can be sent into the running turn now, or taken back.
  private async inbox(signal: AbortSignal): Promise<void> {
    await this.source.refresh();
    while (!signal.aborted) {
      const queued = this.source.queued();
      if (!queued.length) {
        this.ui.notify("No messages are waiting.", "info");
        return;
      }
      const labels = queued.map(
        (input, index) => `${index + 1}. ${input.content.split("\n")[0]}`,
      );
      const picked = await this.ui.choose({
        title: "Messages waiting for their turn",
        choices: labels,
        signal,
      });
      const input =
        picked === undefined ? undefined : queued[labels.indexOf(picked)];
      if (!input) {
        return;
      }
      const action = await this.ui.choose({
        title: input.content,
        choices: ["Send it now", "Take it back", "Back"],
        signal,
      });
      if (action === "Send it now") {
        await workspace.steerQueued(this.source.id, input.uuid, signal);
        return;
      }
      if (action === "Take it back") {
        const confirmed = await this.ui.confirm({
          title: "Take this message back?",
          body: input.content,
          signal,
        });
        if (confirmed) {
          await workspace.cancelQueued(this.source.id, input.uuid, signal);
        }
        return;
      }
      if (action === undefined) {
        return;
      }
    }
  }

  // Leverage changes a session's model with the next message, so the choice waits for it.
  private async model(signal: AbortSignal): Promise<void> {
    const family = this.source.session?.providerFamily;
    const models = (await workspace.models(signal)).filter(
      (model) => !model.legacy && (!family || model.family === family),
    );
    if (signal.aborted) {
      return;
    }
    if (!models.length) {
      this.ui.notify("No hosted models are available.", "warning");
      return;
    }
    const current = this.source.session?.model;
    const labels = models.map(
      (model) => `${model.label}${model.id === current ? " (current)" : ""}`,
    );
    const picked = await this.ui.choose({
      title: "Leverage session model",
      choices: labels,
      signal,
    });
    const model =
      picked === undefined ? undefined : models[labels.indexOf(picked)];
    if (!model) {
      return;
    }
    if (signal.aborted) {
      return;
    }
    let reasoningEffort: string | undefined;
    if (model.reasoningEfforts.length) {
      const fallback = model.defaultReasoningEffort;
      const efforts = model.reasoningEfforts.map(
        (one) => `${one}${one === fallback ? " (default)" : ""}`,
      );
      const effort = await this.ui.choose({
        title: "Reasoning effort",
        choices: efforts,
        signal,
      });
      if (effort === undefined) {
        return;
      }
      reasoningEffort = model.reasoningEfforts[efforts.indexOf(effort)];
    }
    this.chooseModel({
      model: model.id,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    });
    this.ui.notify(
      `${model.label}${reasoningEffort ? ` (${reasoningEffort})` : ""} is used from your next message.`,
      "info",
    );
  }
}
