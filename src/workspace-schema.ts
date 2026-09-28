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
export const messageSchema = z.object({
	id: z.string(),
	channelId: z.string(),
	content: z.string(),
	createdAt: z.string(),
	authorId: z.string().nullable(),
	authorName: z.string().nullable().optional(),
	parentMessageId: z.string().nullable().optional(),
	topLevelSeq: z.number().nullable().optional(),
	clientMessageId: z.string().nullable().optional(),
	harness: z.string().nullable().optional(),
	sessionId: z.string().nullable().optional(),
	isAi: z.boolean().optional(),
	threadSummary: z.object({ replyCount: z.number() }).nullable().optional(),
	attachments: z.array(z.object({ filename: z.string() })).optional(),
});
export const timelineSchema = z.object({
	messages: z.array(messageSchema),
	hasMoreOlder: z.boolean(),
	nextBeforeSeq: z.number().nullable(),
	lastCursorIncluded: z.number(),
});
export const readStateSchema = z.object({
	channelId: z.string(),
	unreadCount: z.number(),
});
export const repoSchema = z.object({
	id: z.string(),
	fullName: z.string(),
	connectionStatus: z.string(),
	defaultBranch: z.string().nullable().optional(),
});
export const grantSchema = z.object({
	principalType: z.enum(["user", "channel"]),
	principalId: z.string(),
	role: z.enum(["viewer", "collaborator"]),
});
export const sharingSchema = z.object({
	members: z.array(grantSchema.extend({ name: z.string().optional() })),
	ownerId: z.string(),
	visibility: visibilitySchema,
	includePersonalKnowledge: z.boolean().optional(),
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

const viewerSchema = z.object({
	userId: z.string(),
	userName: z.string(),
	state: z.enum(["active", "idle"]).optional(),
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
	eventBase.extend({
		type: z.literal("session.presence.snapshot"),
		sessionId: z.string(),
		viewers: z.array(viewerSchema),
	}),
	eventBase.extend({
		type: z.literal("session.presence.update"),
		sessionId: z.string(),
		viewer: viewerSchema,
		active: z.boolean(),
		state: z.enum(["active", "idle"]).optional(),
	}),
	eventBase.extend({
		type: z.literal("session.typing.snapshot"),
		sessionId: z.string(),
		users: z.array(viewerSchema),
	}),
	eventBase.extend({
		type: z.literal("session.typing.update"),
		sessionId: z.string(),
		userId: z.string(),
		userName: z.string(),
		active: z.boolean(),
	}),
	eventBase.extend({
		type: z.literal("message.created"),
		message: messageSchema,
	}),
	eventBase.extend({
		type: z.literal("message.content.updated"),
		channelId: z.string(),
		messageId: z.string(),
		content: z.string(),
	}),
	eventBase.extend({
		type: z.literal("message.deleted"),
		channelId: z.string(),
		messageId: z.string(),
	}),
	eventBase.extend({
		type: z.literal("message.delta"),
		channelId: z.string(),
		messageId: z.string(),
		delta: z.string(),
		offset: z.number().optional(),
	}),
	eventBase.extend({
		type: z.literal("typing.update"),
		channelId: z.string(),
		userId: z.string(),
		userName: z.string(),
		active: z.boolean(),
		parentMessageId: z.string().nullable().optional(),
	}),
]);

export type WorkspaceSession = z.infer<typeof sessionSchema>;
export type SessionInput = z.infer<typeof inputSchema>;
export type WorkspaceMember = z.infer<typeof memberSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type ChannelMessage = z.infer<typeof messageSchema>;
export type SessionGrant = z.infer<typeof grantSchema>;
export type WorkspaceEvent = z.infer<typeof eventSchema>;
export type FileSource = z.infer<typeof sourceSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type Viewer = z.infer<typeof viewerSchema>;
export type SessionContext =
	| { type: "none" }
	| { type: "repo"; repoConnectionId: string; branch?: string }
	| { type: "channel"; channelId: string };
export interface SessionDraft {
	requestId: string;
	context: SessionContext;
	visibility: "private" | "workspace";
	providerFamily?: z.infer<typeof familySchema>;
	model?: string;
	reasoningEffort?: string;
	mode: "plan" | "yolo";
	includePersonalKnowledge: boolean;
	grants: SessionGrant[];
	title?: string;
	sessionId?: string;
}
