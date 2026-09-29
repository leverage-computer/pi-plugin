import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseDrawer, type DrawerItem, textDrawer } from "../drawers";
import type { WorkspaceClient } from "./api";
import type { Channel, SessionDraft, WorkspaceSession } from "./schema";

const relative = new Intl.RelativeTimeFormat("en", {
	numeric: "auto",
	style: "narrow",
});
function ago(time?: string): string {
	const minutes = Math.round((Date.parse(time ?? "") - Date.now()) / 60_000);
	if (!Number.isFinite(minutes)) return "";
	if (minutes > -60) return relative.format(minutes, "minute");
	if (minutes > -1440) return relative.format(Math.round(minutes / 60), "hour");
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
	api: WorkspaceClient,
	ctx: ExtensionContext,
	draft: SessionDraft,
	signal: AbortSignal,
	changed: (context: string) => void,
	initial?: string,
): Promise<void> {
	let action = initial;
	while (!signal.aborted) {
		if (draft.sessionId) {
			await textDrawer(
				ctx,
				"Session setup is waiting",
				() =>
					"The empty session already exists. Retry the original prompt to finish its setup. Start a new session to use different settings.",
				signal,
			);
			return;
		}
		const [defaults, channels, models] = await Promise.all([
			api.defaults(signal),
			api.channels(signal),
			api.transport.models(signal),
		]);
		action ??= await chooseDrawer(
			ctx,
			"New session settings",
			[
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
			"Selections and defaults come from Leverage",
		);
		if (!action || action === "done") return;
		if (action === "context") {
			const context = draft.context;
			const choices: DrawerItem[] = [
				{
					value: "none",
					label: "Standalone",
					detail: "No channel",
					current: context.type === "none",
				},
				...channels.map((one) => ({
					value: one.id,
					label: `#${one.name ?? "channel"}`,
					detail: "Channel",
					current: context.type === "channel" && context.channelId === one.id,
				})),
			];
			const picked = await chooseDrawer(
				ctx,
				"Session context",
				choices,
				signal,
				"The channel whose folder and files the agent works in",
			);
			if (picked)
				draft.context =
					picked === "none"
						? { type: "none" }
						: { type: "channel", channelId: picked };
		} else if (action === "model") {
			const usable = models.filter(
				(one) =>
					one.id !== "session" &&
					one.enabled &&
					one.status !== "deprecated" &&
					(one.family === "codex" || one.family === "claude_code") &&
					defaults.healthy[one.family],
			);
			const picked = await chooseDrawer(
				ctx,
				"Leverage model",
				[
					{
						value: "default",
						label: "Leverage default",
						detail: "Channel or workspace setting",
						current: !draft.model,
					},
					...usable.map((one) => ({
						value: one.id,
						label: one.name,
						detail: one.family === "codex" ? "Codex" : "Claude",
						current: draft.model === one.id,
					})),
				],
				signal,
			);
			if (picked === "default") {
				draft.model = undefined;
				draft.providerFamily = undefined;
				draft.reasoningEffort = undefined;
			} else if (picked) {
				const model = usable.find((one) => one.id === picked)!;
				draft.model = model.id;
				draft.providerFamily =
					model.family === "codex" ? "codex" : "claude_code";
				draft.reasoningEffort = undefined;
				if (model.variants.length) {
					const effort = await chooseDrawer(
						ctx,
						"Reasoning effort",
						[
							{ value: "default", label: "Leverage default", current: true },
							...model.variants.map((one) => ({
								value: one.id,
								label: one.id,
							})),
						],
						signal,
					);
					if (effort && effort !== "default") draft.reasoningEffort = effort;
				}
			}
		}
		changed(contextName(draft, channels));
		// A direct setting key returns to the composer after one change.
		if (initial) return;
		action = undefined;
	}
}

export async function sessionsDrawer(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	signal: AbortSignal,
	query = "",
): Promise<string | undefined> {
	let archived = false;
	while (!signal.aborted) {
		const [sessions, channels] = await Promise.all([
			api.sessions(signal, archived),
			api.channels(signal),
		]);
		const picked = await chooseDrawer(
			ctx,
			"Leverage sessions",
			[
				{ value: "new", label: "+ New session" },
				{ value: "refresh", label: "Refresh" },
				{
					value: "archive",
					label: archived ? "Show active sessions" : "Show archived sessions",
				},
				...sessions
					.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
					.map((one) => ({
						value: one.id,
						label: one.title || "Untitled session",
						detail: [
							placeName(one, channels),
							one.status.charAt(0).toUpperCase() + one.status.slice(1),
							one.model ?? one.providerFamily,
							ago(one.updatedAt),
						]
							.filter(Boolean)
							.join(" · "),
					})),
			],
			signal,
			"",
			query,
		);
		if (picked === "refresh") continue;
		if (picked === "archive") {
			archived = !archived;
			continue;
		}
		return picked;
	}
}
