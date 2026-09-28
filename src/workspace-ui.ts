import {
	copyToClipboard,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { chooseDrawer, type DrawerItem, textDrawer } from "./drawers";
import { nativeId, type WorkspaceClient } from "./workspace-api";
import type {
	Channel,
	SessionDraft,
	SessionGrant,
	WorkspaceSession,
} from "./workspace-schema";

export function visibilityName(visibility: string): string {
	return visibility === "workspace"
		? "Public"
		: visibility === "private"
			? "Private"
			: visibility.charAt(0).toUpperCase() + visibility.slice(1);
}
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
export function contextName(
	draft: SessionDraft,
	channels: Channel[] = [],
	repos: Array<{ id: string; fullName: string }> = [],
): string {
	const context = draft.context;
	if (context.type === "repo")
		return `${repos.find((one) => one.id === context.repoConnectionId)?.fullName ?? "Repository"}${context.branch ? ` / ${context.branch}` : ""}`;
	if (context.type === "channel")
		return `#${channels.find((one) => one.id === context.channelId)?.name ?? "channel"}`;
	return "Standalone";
}

export async function pickGrant(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	signal: AbortSignal,
): Promise<SessionGrant | undefined> {
	const [members, channels] = await Promise.all([
		api.members(signal),
		api.channels(signal),
	]);
	const principals = [
		...members.map((one) => ({
			principalType: "user" as const,
			principalId: one.id,
			name: one.name || "Unnamed member",
		})),
		...channels
			.filter((one) => one.kind !== "dm")
			.map((one) => ({
				principalType: "channel" as const,
				principalId: one.id,
				name: `#${one.name ?? "channel"}`,
			})),
	];
	const chosen = await chooseDrawer(
		ctx,
		"Add people or a channel",
		principals.map((one, i) => ({
			value: String(i),
			label: one.name,
			detail:
				one.principalType === "channel"
					? "Everyone in this channel"
					: undefined,
		})),
		signal,
	);
	if (chosen === undefined) return;
	const role = await chooseDrawer(
		ctx,
		"Session role",
		[
			{
				value: "collaborator",
				label: "Collaborator",
				detail: "Send prompts and answer approvals",
			},
			{ value: "viewer", label: "Viewer", detail: "Read the conversation" },
		],
		signal,
	);
	if (role !== "viewer" && role !== "collaborator") return;
	const principal = principals[Number(chosen)];
	return {
		principalType: principal.principalType,
		principalId: principal.principalId,
		role,
	};
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
		const [defaults, channels, repos, models] = await Promise.all([
			api.defaults(signal),
			api.channels(signal),
			api.repos(signal),
			api.transport.models(signal),
		]);
		action ??= await chooseDrawer(
			ctx,
			"New session settings",
			[
				{
					value: "context",
					label: "Repository or channel",
					detail: contextName(draft, channels, repos),
				},
				...(draft.context.type === "repo"
					? [
							{
								value: "branch",
								label: "Branch",
								detail: draft.context.branch ?? "Repository default",
							},
						]
					: []),
				{
					value: "provider",
					label: "Provider",
					detail: draft.providerFamily ?? "Leverage default",
				},
				{
					value: "model",
					label: "Model and reasoning",
					detail: draft.model ?? "Leverage default",
				},
				{
					value: "mode",
					label: "Run mode",
					detail: draft.mode === "yolo" ? "Build" : "Plan",
				},
				{
					value: "knowledge",
					label: "Personal knowledge",
					detail: draft.includePersonalKnowledge ? "Included" : "Not included",
				},
				{
					value: "visibility",
					label: "Sharing",
					detail:
						draft.visibility === "workspace"
							? "Public to workspace"
							: "Private",
				},
				{
					value: "members",
					label: "People and channels",
					detail: draft.grants.length
						? `${draft.grants.length} invited`
						: "None",
				},
				{ value: "access", label: "Preview agent access" },
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
					detail: "No repository or channel",
					current: context.type === "none",
				},
				...repos.map((one) => ({
					value: `repo:${one.id}`,
					label: one.fullName,
					detail:
						one.connectionStatus === "connected"
							? "Repository"
							: "Disconnected",
					disabled: one.connectionStatus !== "connected",
					current:
						context.type === "repo" && context.repoConnectionId === one.id,
				})),
				...channels.map((one) => ({
					value: `channel:${one.id}`,
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
				"Where the agent works and what it can read",
			);
			if (picked) {
				draft.context =
					picked === "none"
						? { type: "none" }
						: picked.startsWith("repo:")
							? { type: "repo", repoConnectionId: picked.slice(5) }
							: { type: "channel", channelId: picked.slice(8) };
			}
		} else if (action === "branch" && draft.context.type === "repo") {
			const branches = await api.branches(
				draft.context.repoConnectionId,
				signal,
			);
			const picked = await chooseDrawer(
				ctx,
				"Repository branch",
				[
					{
						value: "default",
						label: "Repository default",
						current: !draft.context.branch,
					},
					...branches.map((one) => ({
						value: one.name,
						label: one.name,
						detail: one.isDefault ? "Default branch" : undefined,
						current:
							draft.context.type === "repo" &&
							draft.context.branch === one.name,
					})),
				],
				signal,
			);
			if (picked !== undefined)
				draft.context = {
					...draft.context,
					branch: picked === "default" ? undefined : picked,
				};
		} else if (action === "provider") {
			const picked = await chooseDrawer(
				ctx,
				"Hosted provider",
				[
					{
						value: "default",
						label: "Leverage default",
						current: !draft.providerFamily,
					},
					...(["claude_code", "codex"] as const).map((family) => ({
						value: family,
						label: family === "codex" ? "Codex" : "Claude",
						detail: defaults.healthy[family] ? "Connected" : "Unavailable",
						disabled: !defaults.healthy[family],
						current: draft.providerFamily === family,
					})),
				],
				signal,
			);
			const family =
				picked === "codex" || picked === "claude_code" ? picked : undefined;
			// A model belongs to one provider, so only a new provider clears it.
			if (picked && family !== draft.providerFamily) {
				draft.providerFamily = family;
				draft.model = undefined;
				draft.reasoningEffort = undefined;
			}
		} else if (action === "model") {
			const usable = models.filter(
				(one) =>
					one.id !== "session" &&
					one.enabled &&
					one.status !== "deprecated" &&
					(one.family === "codex" || one.family === "claude_code") &&
					defaults.healthy[one.family] &&
					(!draft.providerFamily || one.family === draft.providerFamily),
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
		} else if (action === "mode") {
			const picked = await chooseDrawer(
				ctx,
				"Run mode",
				[
					{
						value: "yolo",
						label: "Build",
						detail: "Run tools under Leverage approval policy",
						current: draft.mode === "yolo",
					},
					{
						value: "plan",
						label: "Plan",
						detail: "Plan before implementation",
						current: draft.mode === "plan",
					},
				],
				signal,
			);
			if (picked === "yolo" || picked === "plan") draft.mode = picked;
		} else if (action === "knowledge")
			draft.includePersonalKnowledge = !draft.includePersonalKnowledge;
		else if (action === "visibility") {
			const picked = await chooseDrawer(
				ctx,
				"Session visibility",
				[
					{
						value: "private",
						label: "Private",
						detail: "Owner and invited people",
						current: draft.visibility === "private",
					},
					{
						value: "workspace",
						label: "Public to workspace",
						detail: "Members can read by link",
						current: draft.visibility === "workspace",
					},
				],
				signal,
				defaults.visibility === "workspace"
					? "An empty placeholder can briefly inherit public access."
					: "Collaborators need an explicit grant.",
			);
			if (picked === "private" || picked === "workspace")
				draft.visibility = picked;
		} else if (action === "members") {
			const members = await api.members(signal);
			const picked = await chooseDrawer(
				ctx,
				"Session invitations",
				[
					{ value: "add", label: "+ Add a person or channel" },
					...draft.grants.map((grant, index) => ({
						value: String(index),
						label:
							grant.principalType === "user"
								? (members.find((one) => one.id === grant.principalId)?.name ??
									"Unknown member")
								: `#${channels.find((one) => one.id === grant.principalId)?.name ?? grant.principalId}`,
						detail: `${grant.role === "collaborator" ? "Collaborator" : "Viewer"} · Enter removes`,
					})),
				],
				signal,
				"People and channels invited when the session starts",
			);
			if (picked === "add") {
				const grant = await pickGrant(api, ctx, signal);
				if (grant)
					draft.grants = [
						...draft.grants.filter(
							(one) =>
								one.principalType !== grant.principalType ||
								one.principalId !== grant.principalId,
						),
						grant,
					];
			} else if (picked !== undefined) draft.grants.splice(Number(picked), 1);
		} else if (action === "access") {
			const preview = await api.accessPreview(draft, signal);
			await textDrawer(
				ctx,
				"Agent access",
				() =>
					preview.resources
						.map(
							(one) =>
								`${one.kind} · ${one.access}\n${one.repositoryName ?? one.mountPath}${one.branch ? ` / ${one.branch}` : ""}`,
						)
						.join("\n\n"),
				signal,
			);
		}
		changed(contextName(draft, channels, repos));
		// A direct setting key returns to the composer after one change.
		if (initial) return;
		action = undefined;
	}
}

export async function shareSession(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	session: WorkspaceSession,
	signal: AbortSignal,
): Promise<void> {
	while (!signal.aborted) {
		const [sharing, members, channels] = await Promise.all([
			api.sharing(session.id, signal),
			api.members(signal),
			api.channels(signal),
		]);
		const memberName = (member: SessionGrant) =>
			member.principalType === "channel"
				? `#${channels.find((one) => one.id === member.principalId)?.name ?? "Unknown channel"}`
				: (members.find((one) => one.id === member.principalId)?.name ??
					"Unknown member");
		const picked = await chooseDrawer(
			ctx,
			"Share session",
			[
				{ value: "link", label: "Copy session link" },
				{
					value: "visibility",
					label: "Visibility",
					detail: visibilityName(sharing.visibility),
				},
				{ value: "add", label: "+ Add a person or channel" },
				...sharing.members.map((member, i) => ({
					value: String(i),
					label: memberName(member),
					detail: member.role === "collaborator" ? "Collaborator" : "Viewer",
				})),
			],
			signal,
			"Workspace link access is read-only. Invite collaborators to write.",
		);
		if (picked === undefined) return;
		if (picked === "link") {
			const url = new URL(
				`/w/${encodeURIComponent(api.connection.workspace)}/session/${encodeURIComponent(nativeId(session.id))}`,
				api.connection.host,
			).href;
			await copyToClipboard(url);
			ctx.ui.notify(`Copied: ${url}`, "info");
		} else if (picked === "visibility") {
			if (sharing.visibility === "channel") {
				ctx.ui.notify(
					"Thread-born channel visibility is managed by Leverage.",
					"info",
				);
				continue;
			}
			const visibility = await chooseDrawer(
				ctx,
				"Session visibility",
				[
					{
						value: "private",
						label: "Private",
						current: sharing.visibility === "private",
					},
					{
						value: "workspace",
						label: "Public to workspace",
						current: sharing.visibility === "workspace",
					},
				],
				signal,
			);
			if (visibility === "private" || visibility === "workspace")
				await api.visibility(session.id, visibility, signal);
		} else if (picked === "add") {
			const grant = await pickGrant(api, ctx, signal);
			if (grant) await api.grant(session.id, grant, signal);
		} else {
			const member = sharing.members[Number(picked)];
			if (!member) continue;
			const action = await chooseDrawer(
				ctx,
				memberName(member),
				[
					{
						value: "viewer",
						label: "Viewer",
						detail: "Read the conversation",
						current: member.role === "viewer",
					},
					{
						value: "collaborator",
						label: "Collaborator",
						detail: "Send prompts and answer approvals",
						current: member.role === "collaborator",
					},
					{ value: "remove", label: "Remove access" },
				],
				signal,
			);
			if (action === "remove") await api.revoke(session.id, member, signal);
			else if (action === "viewer" || action === "collaborator")
				await api.grant(session.id, { ...member, role: action }, signal);
		}
	}
}

export async function sessionsDrawer(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	signal: AbortSignal,
	channelId?: string,
	query = "",
): Promise<string | undefined> {
	let archived = false;
	while (!signal.aborted) {
		const sessions = (await api.sessions(signal, archived)).filter(
			(one) => !channelId || one.channelId === channelId,
		);
		const picked = await chooseDrawer(
			ctx,
			channelId ? "Channel sessions" : "Leverage sessions",
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
							one.status.charAt(0).toUpperCase() + one.status.slice(1),
							visibilityName(one.visibility),
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
