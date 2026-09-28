import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LeverageConnection, SessionClient } from "./api";
import {
	bootstrapSchema,
	channelSchema,
	familySchema,
	fileReadSchema,
	liveFilesSchema,
	memberSchema,
	messageSchema,
	readStateSchema,
	repoSchema,
	type SessionDraft,
	type SessionGrant,
	sessionSchema,
	sharingSchema,
	sourcesSchema,
	timelineSchema,
} from "./workspace-schema";
import { WorkspaceSocket } from "./workspace-socket";

const id = encodeURIComponent;
const workspaceList = z.array(z.object({ id: z.string(), slug: z.string() }));
const familySettings = z.object({
	settings: z.array(
		z.object({
			providerFamily: familySchema,
			defaultModel: z.string().nullable(),
			defaultReasoningEffort: z.string().nullable(),
		}),
	),
});
const availability = z.object({ claude_code: z.boolean(), codex: z.boolean() });

/** OpenCode aliases name the same records as the native API. */
export function nativeId(wire: string): string {
	if (!/^(ses|msg)_/.test(wire)) return wire;
	const rest = wire.slice(4);
	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rest)
	)
		return rest;
	const digest = createHash("sha256").update(wire).digest();
	digest[6] = (digest[6] & 15) | 80;
	digest[8] = (digest[8] & 63) | 128;
	const hex = digest.subarray(0, 16).toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class WorkspaceClient {
	private identity?: Promise<string>;
	private live?: WorkspaceSocket;
	constructor(
		readonly transport: SessionClient,
		readonly connection: LeverageConnection,
	) {}
	async workspaceId(signal?: AbortSignal): Promise<string> {
		this.identity ??= this.read("/api/workspaces", workspaceList, signal)
			.then((workspaces) => {
				const workspace = workspaces.find(
					(one) => one.slug === this.connection.workspace,
				);
				if (!workspace)
					throw new Error(
						"Leverage workspace is not available to this account.",
					);
				return workspace.id;
			})
			.catch((error: unknown) => {
				this.identity = undefined;
				throw error;
			});
		return this.identity;
	}
	async socket(signal?: AbortSignal): Promise<WorkspaceSocket> {
		const workspaceId = await this.workspaceId(signal);
		signal?.throwIfAborted();
		this.live ??= new WorkspaceSocket(
			this.transport,
			this.connection.host,
			workspaceId,
		);
		return this.live;
	}
	async read<T>(
		path: string,
		schema: z.ZodType<T>,
		signal?: AbortSignal,
	): Promise<T> {
		const result = schema.safeParse(
			await this.transport.nativeJson(path, "GET", signal),
		);
		if (!result.success)
			throw new Error(
				`Leverage returned invalid data for ${path.split("?")[0]}`,
			);
		return result.data;
	}
	private async scope(signal?: AbortSignal): Promise<string> {
		return `/api/workspaces/${id(await this.workspaceId(signal))}`;
	}
	async members(signal?: AbortSignal) {
		return this.read(
			`/api/users?workspaceId=${id(await this.workspaceId(signal))}`,
			z.array(memberSchema),
			signal,
		);
	}
	async channels(signal?: AbortSignal) {
		return this.read(
			`/api/channels?workspaceId=${id(await this.workspaceId(signal))}`,
			z.array(channelSchema),
			signal,
		);
	}
	async readStates(signal?: AbortSignal) {
		return this.read(
			`/api/read-state/channels?workspaceId=${id(await this.workspaceId(signal))}`,
			z.array(readStateSchema),
			signal,
		);
	}
	async sessions(signal?: AbortSignal, archived = false) {
		return this.read(
			`/api/sessions${archived ? "/archived" : ""}?workspaceId=${id(await this.workspaceId(signal))}`,
			z.array(sessionSchema),
			signal,
		);
	}
	bootstrap(sessionId: string, signal?: AbortSignal) {
		return this.read(
			`/api/sessions/${id(nativeId(sessionId))}/bootstrap?limit=500`,
			bootstrapSchema,
			signal,
		);
	}
	sharing(sessionId: string, signal?: AbortSignal) {
		return this.read(
			`/api/sessions/${id(nativeId(sessionId))}/members`,
			sharingSchema,
			signal,
		);
	}
	async visibility(
		sessionId: string,
		visibility: SessionDraft["visibility"],
		signal?: AbortSignal,
	): Promise<void> {
		await this.transport.nativeJson(
			`/api/sessions/${id(nativeId(sessionId))}/visibility`,
			"PATCH",
			signal,
			{ visibility },
		);
	}
	async grant(
		sessionId: string,
		member: SessionGrant,
		signal?: AbortSignal,
	): Promise<void> {
		await this.transport.nativeJson(
			`/api/sessions/${id(nativeId(sessionId))}/members`,
			"POST",
			signal,
			member,
		);
	}
	async revoke(
		sessionId: string,
		member: SessionGrant,
		signal?: AbortSignal,
	): Promise<void> {
		await this.transport.nativeJson(
			`/api/sessions/${id(nativeId(sessionId))}/members/${member.principalType}/${id(member.principalId)}`,
			"DELETE",
			signal,
		);
	}
	async repos(signal?: AbortSignal) {
		return (
			await this.read(
				`${await this.scope(signal)}/github/repos`,
				z.object({ repos: z.array(repoSchema) }),
				signal,
			)
		).repos;
	}
	async branches(repoId: string, signal?: AbortSignal) {
		return (
			await this.read(
				`${await this.scope(signal)}/github/repos/${id(repoId)}/branches`,
				z.object({
					branches: z.array(
						z.object({ name: z.string(), isDefault: z.boolean() }),
					),
				}),
				signal,
			)
		).branches;
	}
	async defaults(signal?: AbortSignal) {
		const scope = await this.scope(signal);
		const [families, healthy, sharing] = await Promise.all([
			this.read(`${scope}/provider-family-settings`, familySettings, signal),
			this.read(`${scope}/provider-access/availability`, availability, signal),
			this.read(
				`${scope}/session-sharing-defaults`,
				z.object({ defaultVisibility: z.enum(["private", "workspace"]) }),
				signal,
			),
		]);
		return {
			families: families.settings,
			healthy,
			visibility: sharing.defaultVisibility,
		};
	}
	async draft(signal?: AbortSignal): Promise<SessionDraft> {
		const defaults = await this.defaults(signal);
		return {
			requestId: randomUUID(),
			context: { type: "none" },
			mode: "yolo",
			visibility: defaults.visibility,
			grants: [],
			includePersonalKnowledge: false,
		};
	}
	async validateDraft(draft: SessionDraft, signal: AbortSignal): Promise<void> {
		const [defaults, models] = await Promise.all([
			this.defaults(signal),
			this.transport.models(signal),
		]);
		let inherited: string | undefined;
		if (draft.context.type === "repo") {
			const repo = (await this.repos(signal)).find(
				(one) =>
					one.id ===
					(draft.context.type === "repo" ? draft.context.repoConnectionId : ""),
			);
			if (!repo || repo.connectionStatus !== "connected")
				throw new Error("Choose a connected repository.");
			if (
				draft.context.branch &&
				!(await this.branches(repo.id, signal)).some(
					(one) =>
						one.name ===
						(draft.context.type === "repo" ? draft.context.branch : ""),
				)
			)
				throw new Error("The selected branch is no longer available.");
		} else if (draft.context.type === "channel") {
			const channel = (await this.channels(signal)).find(
				(one) =>
					one.id ===
					(draft.context.type === "channel" ? draft.context.channelId : ""),
			);
			if (!channel)
				throw new Error("The selected channel is no longer available.");
			inherited = channel.defaultProviderFamily;
		}
		const family =
			draft.providerFamily ??
			inherited ??
			(defaults.healthy.claude_code ? "claude_code" : "codex");
		if (family !== "codex" && family !== "claude_code")
			throw new Error("Choose a hosted provider.");
		if (!defaults.healthy[family])
			throw new Error(
				"This provider is unavailable. Connect it in Leverage Settings → Agent.",
			);
		const selected = draft.model
			? models.find(
					(one) =>
						one.id === draft.model &&
						one.family === family &&
						one.enabled &&
						one.status !== "deprecated",
				)
			: undefined;
		if (draft.model && !selected)
			throw new Error("The selected model is no longer available.");
		if (
			draft.reasoningEffort &&
			(!selected ||
				!selected.variants.some((one) => one.id === draft.reasoningEffort))
		)
			throw new Error("Choose a reasoning effort supported by this model.");
		draft.providerFamily = family;
	}
	async create(draft: SessionDraft, signal: AbortSignal): Promise<string> {
		if (!draft.sessionId) {
			await this.validateDraft(draft, signal);
			const socket = await this.socket(signal);
			const event = await socket.request(
				{
					type: "session.create",
					clientRequestId: draft.requestId,
					prompt: "",
					context: draft.context,
					mode: draft.mode,
					providerFamily: draft.providerFamily,
					model: draft.model,
					reasoningEffort: draft.reasoningEffort,
					includePersonalKnowledge: draft.includePersonalKnowledge,
					checkoutStrategy: "clone",
					harness: "leverage/cli",
				},
				(reply) =>
					(reply.type === "session.created" || reply.type === "error") &&
					reply.clientRequestId === draft.requestId,
				signal,
			);
			if (event.type !== "session.created")
				throw new Error("Session creation was not confirmed.");
			draft.sessionId = event.session.id;
		}
		await this.visibility(draft.sessionId, draft.visibility, signal);
		for (const grant of draft.grants)
			await this.grant(draft.sessionId, grant, signal);
		const sharing = await this.sharing(draft.sessionId, signal);
		if (
			sharing.visibility !== draft.visibility ||
			draft.grants.some(
				(wanted) =>
					!sharing.members.some(
						(one) =>
							one.principalId === wanted.principalId &&
							one.principalType === wanted.principalType &&
							one.role === wanted.role,
					),
			)
		)
			throw new Error(
				"Session access is not confirmed. The prompt has not been sent.",
			);
		if (draft.title)
			await this.transport.rename(
				`ses_${draft.sessionId}`,
				draft.title,
				signal,
			);
		return draft.sessionId;
	}
	timeline(channelId: string, before?: number | null, signal?: AbortSignal) {
		return this.read(
			`/api/channels/${id(channelId)}/timeline?limit=50${before == null ? "" : `&beforeSeq=${before}`}`,
			timelineSchema,
			signal,
		);
	}
	async thread(channelId: string, rootId: string, signal?: AbortSignal) {
		const result = await this.read(
			`/api/channels/${id(channelId)}/messages/${id(rootId)}/thread`,
			z.union([
				z.array(messageSchema),
				z.object({ messages: z.array(messageSchema) }),
			]),
			signal,
		);
		return Array.isArray(result) ? result : result.messages;
	}
	async sendMessage(
		channelId: string,
		content: string,
		clientMessageId: string,
		signal: AbortSignal,
		parentMessageId?: string,
	): Promise<void> {
		const socket = await this.socket(signal);
		await socket.request(
			{
				type: "message.send",
				channelId,
				content,
				clientMessageId,
				parentMessageId,
			},
			(event) =>
				event.type === "message.created"
					? event.message.clientMessageId === clientMessageId
					: event.type === "error" && event.clientMessageId === clientMessageId,
			signal,
		);
	}
	async markRead(
		channelId: string,
		lastReadTopLevelSeq: number,
		signal?: AbortSignal,
	): Promise<void> {
		await this.transport.nativeJson(
			`/api/channels/${id(channelId)}/read`,
			"POST",
			signal,
			{ lastReadTopLevelSeq },
		);
	}
	sources(sessionId: string, signal?: AbortSignal) {
		return this.read(
			`/api/sessions/${id(nativeId(sessionId))}/file-sources`,
			sourcesSchema,
			signal,
		);
	}
	liveFiles(sessionId: string, signal?: AbortSignal, wake = false) {
		return this.read(
			`/api/sessions/${id(nativeId(sessionId))}/live-file-status${wake ? "?wake=1" : ""}`,
			liveFilesSchema,
			signal,
		);
	}
	file(
		sessionId: string,
		path: string,
		resourceId: string,
		commit?: string,
		signal?: AbortSignal,
	) {
		return this.read(
			`/api/sessions/${id(nativeId(sessionId))}/files/read?${new URLSearchParams({ path, resource_id: resourceId, ...(commit ? { commit } : {}), wake: "1" })}`,
			fileReadSchema,
			signal,
		);
	}
	async accessPreview(draft: SessionDraft, signal?: AbortSignal) {
		return z
			.object({
				resources: z.array(
					z.object({
						kind: z.string(),
						access: z.string(),
						repositoryName: z.string().optional(),
						branch: z.string().optional(),
						mountPath: z.string(),
					}),
				),
			})
			.parse(
				await this.transport.nativeJson(
					`${await this.scope(signal)}/files/session-preview`,
					"POST",
					signal,
					{
						context: draft.context,
						includePersonalKnowledge: draft.includePersonalKnowledge,
					},
				),
			);
	}
	close(): void {
		this.live?.close();
	}
}
