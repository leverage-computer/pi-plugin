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
	type SessionDraft,
	sessionSchema,
	sourcesSchema,
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
	async defaults(signal?: AbortSignal) {
		const scope = await this.scope(signal);
		const [families, healthy] = await Promise.all([
			this.read(`${scope}/provider-family-settings`, familySettings, signal),
			this.read(`${scope}/provider-access/availability`, availability, signal),
		]);
		return { families: families.settings, healthy };
	}
	draft(): SessionDraft {
		return { requestId: randomUUID(), context: { type: "none" } };
	}
	async validateDraft(draft: SessionDraft, signal: AbortSignal): Promise<void> {
		const [defaults, models] = await Promise.all([
			this.defaults(signal),
			this.transport.models(signal),
		]);
		let inherited: string | undefined;
		if (draft.context.type === "channel") {
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
					providerFamily: draft.providerFamily,
					model: draft.model,
					reasoningEffort: draft.reasoningEffort,
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
		if (draft.title)
			await this.transport.rename(
				`ses_${draft.sessionId}`,
				draft.title,
				signal,
			);
		return draft.sessionId;
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
	close(): void {
		this.live?.close();
	}
}
