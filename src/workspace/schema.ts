import { z } from "zod";

// Wire shapes of Leverage's native API. They mirror the server's contract in
// `packages/contracts/src/ws-protocol.ts`. Fields this client never reads are
// left out, so new server fields never break it.

export const familySchema = z.enum(["claude_code", "codex"]);

export type ProviderFamily = z.infer<typeof familySchema>;

export const memberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  role: z.string().nullish(),
});

export type WorkspaceMember = z.infer<typeof memberSchema>;

export const channelSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  kind: z.string().nullish(),
  defaultProviderFamily: familySchema.optional(),
});

export type Channel = z.infer<typeof channelSchema>;

// Why a session waits for a person, if it does.
export const awaitingSchema = z
  .union([
    z.object({
      kind: z.literal("tool_approval"),
      tool: z.string(),
      count: z.number(),
    }),
    z.object({ kind: z.literal("question") }),
  ])
  .nullable();

export const sessionSchema = z.object({
  id: z.string(),
  title: z.string().nullable(),
  channelId: z.string().nullable(),
  providerFamily: familySchema,
  model: z.string().nullable(),
  reasoningEffort: z.string().nullish(),
  status: z.string(),
  awaitingReason: awaitingSchema.nullish(),
  queuedCount: z.number().nullish(),
  turnId: z.string().nullish(),
  archivedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  requestedBranch: z.string().nullish(),
  repo: z.object({ fullName: z.string() }).nullish(),
  ownerId: z.string().nullish(),
  // Tokens the last model call used, and the window the provider reported.
  contextUsedTokens: z.number().nullish(),
  contextWindowTokens: z.number().nullish(),
});

export type WorkspaceSession = z.infer<typeof sessionSchema>;

export const attachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  url: z.string().nullish(),
});

export type Attachment = z.infer<typeof attachmentSchema>;

// A person's message and where it is on its way to the agent.
export const inputSchema = z.object({
  uuid: z.string(),
  sessionId: z.string(),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  harness: z.string().nullable(),
  content: z.string(),
  status: z.string(),
  createdAt: z.string(),
  attachments: z.array(attachmentSchema).nullish(),
  intent: z.string().nullish(),
  kind: z.string().nullish(),
  queuePosition: z.number().nullish(),
  // Where the agent's transcript took the message in.
  consumedTranscriptSeq: z.number().nullish(),
  note: z.string().nullish(),
});

export type SessionInput = z.infer<typeof inputSchema>;

/**
 * The fields a transcript row may carry. Which ones it has depends on its
 * kind. Leverage stores them untyped, so a field of the wrong type reads as
 * empty instead of rejecting the whole transcript.
 */
export const rowDataSchema = z.record(z.string(), z.unknown()).pipe(
  z.looseObject({
    content: z.string().catch(""),
    eventId: z.string().catch(""),
    toolUseId: z.string().catch(""),
    name: z.string().catch(""),
    cause: z.string().catch(""),
    finalized: z.boolean().catch(false),
    tombstone: z.boolean().catch(false),
    isError: z.boolean().catch(false),
    is_error: z.boolean().catch(false),
    // Compactions and background tasks report their phase.
    phase: z.string().catch(""),
    status: z.string().catch(""),
    taskId: z.string().catch(""),
    taskKind: z.string().catch(""),
    backgrounded: z.boolean().catch(false),
    // The session's first row lists the skills its folder offers.
    directorySkills: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/i),
            description: z.string().catch(""),
          })
          .nullable()
          .catch(null),
      )
      .catch([]),
    // A sub-agent's rows name the tool call that started it.
    parentToolUseId: z.string().catch(""),
    delegatedTaskId: z.string().catch(""),
    input: z.unknown().optional(),
    result: z.unknown().optional(),
    answers: z.record(z.string(), z.unknown()).catch({}),
    attachments: z
      .array(
        z.object({
          filename: z.string().catch("Attachment"),
          contentType: z.string().catch("application/octet-stream"),
          url: z.string().nullish().catch(undefined),
        }),
      )
      .catch([]),
  }),
);

export type RowData = z.infer<typeof rowDataSchema>;

// What the agent asks with an ask_user row: questions and their answer
// options, or a plan to review.
export const askSchema = z
  .object({
    plan: z.string().catch(""),
    questions: z
      .array(
        z.object({
          question: z.string().catch(""),
          options: z.array(z.object({ label: z.string() })).catch([]),
          multiSelect: z.boolean().catch(false),
        }),
      )
      .catch([]),
  })
  .catch({ plan: "", questions: [] });

// One row of the shared transcript. Its `data` depends on `kind`.
export const transcriptEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  kind: z.string(),
  data: rowDataSchema,
  createdAt: z.string(),
  transcriptSeq: z.number().nullish(),
  turnId: z.string().nullish(),
  authorId: z.string().nullish(),
  sourceInputUuids: z.array(z.string()).nullish(),
});

export type TranscriptEvent = z.infer<typeof transcriptEventSchema>;

// A row as Leverage sends it, before its fields are read.
export type TranscriptRow = z.input<typeof transcriptEventSchema>;

// A piece of streamed text, reasoning, or tool output.
export const deltaSchema = z.object({
  kind: z.string(),
  streamId: z.string(),
  delta: z.string(),
  offset: z.number(),
  snapshot: z
    .object({ content: z.string(), startOffset: z.number().optional() })
    .optional(),
  eventId: z.string().nullish(),
  rowId: z.string().nullish(),
  toolUseId: z.string().nullish(),
  parentToolUseId: z.string().nullish(),
  delegatedTaskId: z.string().nullish(),
});

export type TranscriptDelta = z.infer<typeof deltaSchema>;

// A tool call that Leverage governs, such as one waiting for approval.
export const invocationSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolUseId: z.string().nullable(),
  tool: z.string(),
  toolDisplayName: z.string().nullish(),
  originalArguments: z.record(z.string(), z.unknown()),
  effectiveArguments: z.record(z.string(), z.unknown()).nullable(),
  state: z.string(),
  actingUserName: z.string().nullish(),
  connectorName: z.string().nullish(),
  // Who the call runs as, and whose connection it goes through.
  actingUserId: z.string().nullish(),
  connectorScope: z.string().nullish(),
  connectorOwnerUserId: z.string().nullish(),
  workspaceConnectorId: z.string().nullish(),
});

export type Invocation = z.infer<typeof invocationSchema>;

export const bootstrapSchema = z.object({
  session: sessionSchema,
  events: z.array(transcriptEventSchema).default([]),
  messages: z.array(inputSchema),
  version: z.number(),
  lastCursorIncluded: z.number(),
  toolApprovals: z.array(invocationSchema).default([]),
  viewerCanWrite: z.boolean(),
});

export type Bootstrap = z.infer<typeof bootstrapSchema>;

export const historyPageSchema = z.object({
  events: z.array(transcriptEventSchema),
  hasOlderEvents: z.boolean(),
  oldestTranscriptSeq: z.number().nullable(),
});

export type HistoryPage = z.infer<typeof historyPageSchema>;

export const queueSchema = z.object({
  queuedCount: z.number(),
  messages: z.array(inputSchema),
});

export const pendingApprovalsSchema = z.object({
  invocations: z.array(invocationSchema),
});

export const modelSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().nullable(),
  family: familySchema,
  legacy: z.boolean(),
  reasoningEfforts: z.array(z.string()),
  defaultReasoningEffort: z.string().nullable(),
});

export type HostedModel = z.infer<typeof modelSchema>;

export const modelCatalogSchema = z.object({ models: z.array(modelSchema) });

export const providerAvailabilitySchema = z.object({
  claude_code: z.boolean(),
  codex: z.boolean(),
});

export type ProviderAvailability = z.infer<typeof providerAvailabilitySchema>;

export const uploadSchema = z.object({
  attachmentId: z.string(),
  mode: z.string(),
  url: z.string().nullish(),
});

export const sessionContextSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("none") }),
  z.object({ type: z.literal("channel"), channelId: z.string() }),
]);

export type SessionContext = z.infer<typeof sessionContextSchema>;

// Frames the server sends on the workspace socket.
const frameBase = z.object({
  cursor: z.number().nullish(),
  _topic: z.string().nullish(),
});

export const eventSchema = z.discriminatedUnion("type", [
  frameBase.extend({ type: z.literal("connection.ready"), userId: z.string() }),
  frameBase.extend({
    type: z.literal("error"),
    message: z.string(),
    clientRequestId: z.string().nullish(),
  }),
  frameBase.extend({
    type: z.literal("session.created"),
    session: sessionSchema,
    clientRequestId: z.string().optional(),
  }),
  frameBase.extend({
    type: z.literal("session.message.received"),
    sessionId: z.string(),
    clientRequestId: z.string(),
    message: inputSchema,
  }),
  frameBase.extend({
    type: z.literal("session.answer.received"),
    sessionId: z.string(),
    clientRequestId: z.string(),
  }),
  frameBase.extend({
    type: z.literal("session.stop.accepted"),
    sessionId: z.string(),
    clientRequestId: z.string(),
  }),
  frameBase.extend({
    type: z.literal("session.rename.accepted"),
    sessionId: z.string(),
    title: z.string(),
    clientRequestId: z.string(),
  }),
  frameBase.extend({
    type: z.literal("session.updated"),
    sessionId: z.string(),
    title: z.string().optional(),
    status: z.string(),
    awaitingReason: awaitingSchema.nullish(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    queuedCount: z.number(),
    turnId: z.string().nullable(),
    version: z.number(),
    archivedAt: z.string().nullish(),
    contextUsedTokens: z.number().nullish(),
    contextWindowTokens: z.number().nullish(),
  }),
  frameBase.extend({
    type: z.literal("session.messages.updated"),
    sessionId: z.string(),
    version: z.number(),
    messages: z.array(inputSchema),
  }),
  frameBase.extend({
    type: z.literal("session.event"),
    sessionId: z.string(),
    event: transcriptEventSchema,
  }),
  frameBase.extend({
    type: z.literal("session.event.delta"),
    sessionId: z.string(),
    delta: deltaSchema,
  }),
  frameBase.extend({
    type: z.literal("session.approval.pending"),
    sessionId: z.string(),
    invocation: invocationSchema,
  }),
  frameBase.extend({
    type: z.literal("session.approval.updated"),
    sessionId: z.string(),
    invocation: invocationSchema,
  }),
  frameBase.extend({
    type: z.literal("session.list.changed"),
    sessionId: z.string(),
  }),
  frameBase.extend({
    type: z.literal("session.access_revoked"),
    sessionId: z.string(),
  }),
]);

export type WorkspaceEvent = z.infer<typeof eventSchema>;

// Frames this client sends. Validating them keeps the wire format in one place.
export const sessionCreateSchema = z.object({
  type: z.literal("session.create"),
  clientRequestId: z.string().uuid(),
  prompt: z.string(),
  title: z.string().optional(),
  context: sessionContextSchema,
  providerFamily: familySchema.optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  checkoutStrategy: z.literal("clone"),
  harness: z.literal("leverage/cli"),
});

export const sessionMessageSchema = z.object({
  type: z.literal("session.message"),
  sessionId: z.string(),
  clientRequestId: z.string().uuid(),
  content: z.string(),
  delivery: z.enum(["send", "queue"]),
  attachmentIds: z.array(z.string()).optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
  harness: z.literal("leverage/cli"),
});

export const clientFrameSchema = z.discriminatedUnion("type", [
  sessionCreateSchema,
  sessionMessageSchema,
  z.object({
    type: z.literal("session.stop"),
    sessionId: z.string(),
    turnId: z.string().optional(),
    clientRequestId: z.string(),
  }),
  z.object({
    type: z.literal("session.rename"),
    sessionId: z.string(),
    title: z.string(),
    clientRequestId: z.string(),
  }),
  z.object({
    type: z.literal("session.answer"),
    sessionId: z.string(),
    toolUseId: z.string(),
    answers: z.record(z.string(), z.string()),
    annotations: z
      .record(z.string(), z.object({ notes: z.string().optional() }))
      .optional(),
    clientRequestId: z.string(),
  }),
  z.object({ type: z.literal("session.compact"), sessionId: z.string() }),
  z.object({ type: z.literal("session.archive"), sessionId: z.string() }),
  z.object({ type: z.literal("session.unarchive"), sessionId: z.string() }),
  z.object({
    type: z.literal("session.queue.cancel"),
    sessionId: z.string(),
    uuid: z.string(),
  }),
  z.object({
    type: z.literal("session.queue.steer"),
    sessionId: z.string(),
    uuid: z.string(),
  }),
  z.object({
    type: z.literal("session.subscribe"),
    sessionId: z.string(),
    afterCursor: z.number().optional(),
  }),
  z.object({ type: z.literal("session.unsubscribe"), sessionId: z.string() }),
  z.object({ type: z.literal("presence.heartbeat") }),
]);

export type ClientFrame = z.infer<typeof clientFrameSchema>;

export interface SessionDraft {
  requestId: string;
  context: SessionContext;
  providerFamily?: ProviderFamily;
  model?: string;
  reasoningEffort?: string;
  title?: string;
  sessionId?: string;
}

// Where a session keeps files: its outputs, channels, repositories and home.
export const fileResourcesSchema = z.object({
  resources: z.array(
    z.object({
      resourceId: z.string(),
      kind: z.string(),
      mountPath: z.string().catch(""),
      isWorkingRoot: z.boolean().catch(false),
      channelId: z.string().nullish(),
      repositoryName: z.string().nullish(),
      branch: z.string().nullish(),
    }),
  ),
});

export type FileResource = z.infer<
  typeof fileResourcesSchema
>["resources"][number];

// One file or folder. Its path is relative to its resource.
export const fileEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  type: z.enum(["file", "dir"]),
  size: z.number().nullish(),
  modifiedAt: z.string().nullish(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;

export const fileTreeSchema = z.object({
  path: z.string(),
  entries: z.array(fileEntrySchema),
  nextPageToken: z.string().nullish(),
});

// A file's text, or why it has none: binary, or over the 1 MiB inline limit.
export const fileReadSchema = z.object({
  path: z.string(),
  name: z.string(),
  byteSize: z.number(),
  isBinary: z.boolean(),
  tooLarge: z.boolean(),
  content: z.string().nullish(),
});

export const fileSearchSchema = z.object({
  entries: z.array(fileEntrySchema),
  truncated: z.boolean(),
});

const fileChangeSchema = z.object({
  path: z.string(),
  oldPath: z.string().nullish(),
  state: z.string(),
  patch: z.string().nullish(),
  additions: z.number().nullish(),
  deletions: z.number().nullish(),
});

// What a session changed in each of its sources, and any pull request.
export const fileSourcesSchema = z.object({
  sources: z.array(
    z.object({
      resourceId: z.string(),
      kind: z.string(),
      label: z.string(),
      branch: z.string().nullish(),
      sourceOutOfDate: z.boolean().nullish(),
      changes: z.array(fileChangeSchema),
      unpublished: z.number().nullish(),
      error: z.string().nullish(),
      publication: z
        .object({
          number: z.number(),
          url: z.string(),
          state: z.string(),
          draft: z.boolean().nullish(),
        })
        .nullish(),
    }),
  ),
  working: z.boolean(),
});

export type FileSources = z.infer<typeof fileSourcesSchema>;

// The workspace's connections to other apps.
export const connectorsSchema = z.object({
  connectors: z.array(
    z.object({
      id: z.string(),
      namespace: z.string(),
      label: z.string().nullish(),
      scope: z.string(),
      disabled: z.boolean().catch(false),
      runtimeStatus: z.string().catch("unknown"),
      catalogToolCount: z.number().nullish(),
      description: z.string().nullish(),
    }),
  ),
});

export type Connector = z.infer<typeof connectorsSchema>["connectors"][number];
