import { z } from "zod";

export const familySchema = z.enum(["claude_code", "codex"]);
export const visibilitySchema = z.enum(["private", "workspace", "channel"]);
export const memberSchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	image: z.string().nullable().optional(),
});
export const channelSchema = z.object({
	id: z.string(),
	name: z.string().nullable(),
	kind: z.string().optional(),
	visibility: z.string().optional(),
	defaultProviderFamily: familySchema.optional(),
	defaultModel: z.string().nullable().optional(),
	defaultReasoningEffort: z.string().nullable().optional(),
});
export const sessionSchema = z.object({
	id: z.string(),
	title: z.string().nullable(),
	channelId: z.string().nullable(),
	visibility: visibilitySchema,
	createdBy: z.string().nullable().optional(),
	ownerId: z.string().nullable().optional(),
	providerFamily: familySchema,
	model: z.string().nullable(),
	reasoningEffort: z.string().nullable().optional(),
	mode: z.enum(["plan", "yolo"]),
	status: z.string(),
	updatedAt: z.string().optional(),
	contextWindow: z.string().nullable().optional(),
	codexServiceTier: z.string().nullable().optional(),
});
export const inputSchema = z.object({
	uuid: z.string(),
	sessionId: z.string(),
	authorId: z.string().nullable(),
	authorName: z.string().nullable(),
	harness: z.string().nullable(),
	content: z.string(),
	status: z.string(),
	createdAt: z.string(),
	kind: z.string().optional(),
});
export const bootstrapSchema = z.object({
	session: sessionSchema,
	messages: z.array(inputSchema),
	version: z.number(),
	lastCursorIncluded: z.number(),
	viewerCanWrite: z.boolean(),
});
export const fileChangeSchema = z.object({
	path: z.string(),
	oldPath: z.string().optional(),
	state: z.string(),
	patch: z.string().optional(),
	additions: z.number().optional(),
	deletions: z.number().optional(),
});
export const sourceSchema = z.object({
	id: z.string(),
	resourceId: z.string(),
	kind: z.string(),
	label: z.string(),
	mountPath: z.string(),
	candidateCommit: z.string().optional(),
	baseCommit: z.string().optional(),
	branch: z.string().optional(),
	changes: z.array(fileChangeSchema),
	updates: z.array(fileChangeSchema),
	checkedAt: z.string().optional(),
	error: z.string().optional(),
	publication: z
		.object({
			state: z.string(),
			url: z.string(),
			number: z.number(),
			draft: z.boolean().optional(),
		})
		.optional(),
	publicationComparison: z
		.object({ changes: z.array(fileChangeSchema) })
		.optional(),
});
export const sourcesSchema = z.object({
	sources: z.array(sourceSchema),
	working: z.boolean(),
	error: z.string().optional(),
});
export const liveFilesSchema = z.object({
	available: z.boolean(),
	files: z.array(fileChangeSchema),
});
export const fileReadSchema = z.object({
	content: z.string().optional(),
	isBinary: z.boolean(),
	tooLarge: z.boolean(),
	encoding: z.string(),
});

const eventBase = z.object({
	type: z.string(),
	cursor: z.number().optional(),
	_topic: z.string().optional(),
});
export const eventSchema = z.discriminatedUnion("type", [
	eventBase.extend({ type: z.literal("connection.ready"), userId: z.string() }),
	eventBase.extend({
		type: z.literal("error"),
		message: z.string(),
		clientRequestId: z.string().optional(),
		clientMessageId: z.string().optional(),
	}),
	eventBase.extend({
		type: z.literal("session.created"),
		session: sessionSchema,
		clientRequestId: z.string().optional(),
	}),
	eventBase.extend({
		type: z.literal("session.messages.updated"),
		sessionId: z.string(),
		version: z.number(),
		messages: z.array(inputSchema),
	}),
	eventBase.extend({
		type: z.literal("session.updated"),
		sessionId: z.string(),
		version: z.number().optional(),
	}),
	eventBase.extend({
		type: z.literal("session.list.changed"),
		sessionId: z.string(),
	}),
	eventBase.extend({
		type: z.literal("session.access_revoked"),
		sessionId: z.string(),
	}),
]);

export type WorkspaceSession = z.infer<typeof sessionSchema>;
export type SessionInput = z.infer<typeof inputSchema>;
export type WorkspaceMember = z.infer<typeof memberSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type WorkspaceEvent = z.infer<typeof eventSchema>;
export type FileSource = z.infer<typeof sourceSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type SessionContext =
	| { type: "none" }
	| { type: "channel"; channelId: string };
export interface SessionDraft {
	requestId: string;
	context: SessionContext;
	providerFamily?: z.infer<typeof familySchema>;
	model?: string;
	reasoningEffort?: string;
	title?: string;
	sessionId?: string;
}
