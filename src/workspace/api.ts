import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { api, type LeverageConnection } from "../api";
import { failure, InputError, ProtocolError, StateError } from "../errors";
import { decode, run } from "../runtime";
import {
  type Bootstrap,
  bootstrapSchema,
  type Channel,
  channelSchema,
  connectorsSchema,
  familySchema,
  fileReadSchema,
  fileResourcesSchema,
  fileSearchSchema,
  fileSourcesSchema,
  fileTreeSchema,
  type HistoryPage,
  type HostedModel,
  historyPageSchema,
  type Invocation,
  inputSchema,
  invocationSchema,
  memberSchema,
  modelCatalogSchema,
  type ProviderAvailability,
  type ProviderFamily,
  pendingApprovalsSchema,
  preferencesSchema,
  providerAvailabilitySchema,
  queueSchema,
  type SessionDraft,
  type SessionInput,
  sessionCreateSchema,
  sessionMessageSchema,
  sessionSchema,
  uploadSchema,
  type WorkspaceSession,
} from "./schema";
import { WorkspaceSocket } from "./socket";

// The most a download reads into memory before it is saved.
const MAX_DOWNLOAD_BYTES = 256 * 1024 * 1024;

const workspaceList = z.array(z.object({ id: z.string(), slug: z.string() }));

// Titles are trimmed and limited like the web app's own.
const sessionTitle = z
  .string()
  .transform((title) => title.trim().replace(/\s+/g, " "))
  .refine((title) => title.length >= 1 && title.length <= 80);

export type Decision = {
  action: "approve" | "deny";
  approvalScope?: "once" | "session" | "always";
  denialReason?: string;
};

export type OutgoingMessage = {
  clientRequestId: string;
  content: string;
  delivery: "send" | "queue";
  attachmentIds?: string[];
  model?: string;
  reasoningEffort?: string;
};

export type Upload = {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
};

// The provider a draft uses: its own choice, then the channel's, then the first available.
function chooseFamily(
  draft: SessionDraft,
  channel: Channel | undefined,
  providers: ProviderAvailability,
): Effect.Effect<ProviderFamily, InputError> {
  const family =
    draft.providerFamily ??
    channel?.defaultProviderFamily ??
    (providers.claude_code ? "claude_code" : "codex");
  return decode(
    familySchema.refine((one) => providers[one]),
    family,
  ).pipe(
    Effect.mapError(
      () =>
        new InputError(
          familySchema.safeParse(family).success
            ? "This provider is unavailable. Connect it in Leverage Settings → Agent."
            : "Choose a hosted provider.",
        ),
    ),
  );
}

// The model a draft names must exist for that provider, with a known effort.
function checkModel(
  draft: SessionDraft,
  family: ProviderFamily,
  models: HostedModel[],
): Effect.Effect<void, InputError> {
  const selected = draft.model
    ? models.find((one) => one.id === draft.model && one.family === family)
    : undefined;
  if (draft.model && !selected) {
    return Effect.fail(
      new InputError("The selected model is no longer available."),
    );
  }
  if (
    draft.reasoningEffort &&
    !selected?.reasoningEfforts.includes(draft.reasoningEffort)
  ) {
    return Effect.fail(
      new InputError("Choose a reasoning effort supported by this model."),
    );
  }
  return Effect.void;
}

/** The workspace behind the connection. Like `api`, there is exactly one. */
export class WorkspaceClient {
  private identity?: Promise<string>;
  private live?: WorkspaceSocket;
  private settings?: LeverageConnection;

  /** Follows the connection. A new one forgets the old workspace and socket. */
  open(): void {
    if (this.settings === api.connection) {
      return;
    }
    this.close();
    this.settings = api.connection;
    this.identity = undefined;
  }

  close(): void {
    this.live?.close();
    this.live = undefined;
    this.settings = undefined;
  }

  workspaceId(signal?: AbortSignal): Promise<string> {
    this.identity ??= run(
      this.fetch("/api/workspaces", workspaceList).pipe(
        Effect.map((workspaces) =>
          workspaces.find((one) => one.slug === api.connection.workspace),
        ),
        Effect.flatMap((workspace) =>
          workspace
            ? Effect.succeed(workspace.id)
            : Effect.fail(
                new StateError(
                  "Leverage workspace is not available to this account.",
                ),
              ),
        ),
      ),
      signal,
    ).catch((error: unknown) => {
      this.identity = undefined;
      throw error;
    });
    return this.identity;
  }

  async socket(signal?: AbortSignal): Promise<WorkspaceSocket> {
    const workspaceId = await this.workspaceId(signal);
    signal?.throwIfAborted();
    this.live ??= new WorkspaceSocket(workspaceId);
    return this.live;
  }

  read<T>(path: string, schema: z.ZodType<T>, signal?: AbortSignal) {
    return run(this.fetch(path, schema), signal);
  }

  members(signal?: AbortSignal) {
    return this.scoped("/api/users", z.array(memberSchema), signal);
  }

  channels(signal?: AbortSignal) {
    return this.scoped("/api/channels", z.array(channelSchema), signal);
  }

  /** The channels this person leaves out of Pi in Leverage Settings. */
  async excludedChannels(signal?: AbortSignal): Promise<string[]> {
    // Preferences belong to the person, not the workspace.
    const preferences = await this.read(
      "/api/user/preferences",
      preferencesSchema,
      signal,
    );
    return preferences.piExcludedChannelIds;
  }

  sessions(signal?: AbortSignal, archived = false) {
    return this.scoped(
      `/api/sessions${archived ? "/archived" : ""}`,
      z.array(sessionSchema),
      signal,
    );
  }

  // Which hosted providers have working credentials.
  async providers(signal?: AbortSignal) {
    const workspaceId = await this.workspaceId(signal);
    return this.read(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/provider-access/availability`,
      providerAvailabilitySchema,
      signal,
    );
  }

  /** The hosted models Leverage can run, each family's default first. */
  async models(signal?: AbortSignal): Promise<HostedModel[]> {
    const workspaceId = await this.workspaceId(signal);
    const catalog = await this.read(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/provider-models`,
      modelCatalogSchema,
      signal,
    );
    return catalog.models;
  }

  // A session's files. A person asked, so each read may wake the sandbox.
  fileResources(sessionId: string, signal?: AbortSignal) {
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/files/resources`,
      fileResourcesSchema,
      signal,
    );
  }

  fileTree(
    sessionId: string,
    place: { resourceId: string; path: string; pageToken?: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      path: place.path,
      resource_id: place.resourceId,
      wake: "1",
      ...(place.pageToken ? { page_token: place.pageToken } : {}),
    });
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/files/tree?${query}`,
      fileTreeSchema,
      signal,
    );
  }

  readFile(
    sessionId: string,
    place: { resourceId: string; path: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      path: place.path,
      resource_id: place.resourceId,
      wake: "1",
    });
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/files/read?${query}`,
      fileReadSchema,
      signal,
    );
  }

  searchFiles(
    sessionId: string,
    place: { resourceId: string; query: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      q: place.query,
      resource_id: place.resourceId,
      limit: "50",
      wake: "1",
    });
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/files/search?${query}`,
      fileSearchSchema,
      signal,
    );
  }

  downloadFile(
    sessionId: string,
    place: { resourceId: string; path: string },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams({
      path: place.path,
      resource_id: place.resourceId,
      wake: "1",
    });
    return api.bytes(
      `/api/sessions/${encodeURIComponent(sessionId)}/files/download?${query}`,
      signal,
      MAX_DOWNLOAD_BYTES,
    );
  }

  /** What the session changed, per source, with any pull request. */
  fileSources(sessionId: string, signal?: AbortSignal) {
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/file-sources`,
      fileSourcesSchema,
      signal,
    );
  }

  async connectors(signal?: AbortSignal) {
    const workspaceId = await this.workspaceId(signal);
    return this.read(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/connectors`,
      connectorsSchema,
      signal,
    );
  }

  /** The session, its recent transcript, inputs and pending approvals. */
  bootstrap(sessionId: string, signal?: AbortSignal, limit = 200) {
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/bootstrap?limit=${limit}`,
      bootstrapSchema,
      signal,
    ) as Promise<Bootstrap>;
  }

  async session(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSession> {
    return (await this.bootstrap(sessionId, signal, 1)).session;
  }

  /** Transcript rows older than `before`, oldest first. */
  history(
    sessionId: string,
    before: number,
    signal?: AbortSignal,
    limit = 100,
  ): Promise<HistoryPage> {
    return this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/events/history?beforeTranscriptSeq=${before}&limit=${limit}`,
      historyPageSchema,
      signal,
    );
  }

  /** Messages waiting for their turn, in queue order. */
  async queue(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionInput[]> {
    const queue = await this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/queue`,
      queueSchema,
      signal,
    );
    return queue.messages;
  }

  async pendingApprovals(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<Invocation[]> {
    const pending = await this.read(
      `/api/sessions/${encodeURIComponent(sessionId)}/pending-approvals`,
      pendingApprovalsSchema,
      signal,
    );
    return pending.invocations;
  }

  async decide(
    invocationId: string,
    decision: Decision,
    signal?: AbortSignal,
  ): Promise<Invocation> {
    const reply = await api.json(
      `/api/tool-invocations/${encodeURIComponent(invocationId)}/decide`,
      "POST",
      signal,
      decision,
    );
    return run(
      decode(invocationSchema, reply).pipe(
        Effect.mapError(
          () => new ProtocolError("Leverage returned an invalid decision"),
        ),
      ),
    );
  }

  /** Marks the session read. A failure only leaves it unread. */
  async markRead(sessionId: string, signal?: AbortSignal): Promise<void> {
    await api
      .json(
        `/api/sessions/${encodeURIComponent(sessionId)}/read`,
        "POST",
        signal,
        {},
      )
      .catch(() => undefined);
  }

  /** Uploads one small file and returns the attachment ID for a message. */
  async upload(file: Upload, signal?: AbortSignal): Promise<string> {
    const workspaceId = await this.workspaceId(signal);
    const reply = await api.json(
      `/api/uploads/init?workspaceId=${encodeURIComponent(workspaceId)}`,
      "POST",
      signal,
      {
        filename: file.filename,
        contentType: file.contentType,
        size: file.bytes.byteLength,
      },
    );
    const init = await run(
      decode(uploadSchema, reply).pipe(
        Effect.mapError(
          () => new ProtocolError("Leverage returned an invalid upload"),
        ),
      ),
    );
    if (init.mode !== "single" || !init.url) {
      throw new InputError("This attachment is too large to send from Pi.");
    }
    const stored = await fetch(init.url, {
      method: "PUT",
      signal,
      headers: { "content-type": file.contentType },
      body: Buffer.from(file.bytes),
    });
    if (!stored.ok) {
      throw new StateError(`The attachment upload failed (${stored.status}).`);
    }
    await api.json(
      `/api/uploads/${encodeURIComponent(init.attachmentId)}/complete`,
      "POST",
      signal,
      {},
    );
    return init.attachmentId;
  }

  draft(): SessionDraft {
    return { requestId: randomUUID(), context: { type: "none" } };
  }

  /**
   * Creates the empty session for a draft. The draft keeps the created ID, so
   * a retry after a lost acknowledgement uses the same session instead of
   * creating a second one.
   */
  create(draft: SessionDraft, signal: AbortSignal): Promise<string> {
    const program = Effect.gen({ self: this }, function* () {
      if (draft.sessionId) {
        return draft.sessionId;
      }
      yield* this.validateDraft(draft, signal);
      const socket = yield* Effect.tryPromise({
        try: () => this.socket(signal),
        catch: failure,
      });
      const title = draft.title
        ? sessionTitle.safeParse(draft.title)
        : undefined;
      const request = sessionCreateSchema.parse({
        type: "session.create",
        clientRequestId: draft.requestId,
        prompt: "",
        ...(title?.success ? { title: title.data } : {}),
        context: draft.context,
        providerFamily: draft.providerFamily,
        model: draft.model,
        reasoningEffort: draft.reasoningEffort,
        checkoutStrategy: "clone",
        harness: "leverage/cli",
      });
      // The socket owns the "not confirmed" outcome, so the signal goes to it.
      const reply = yield* Effect.tryPromise({
        try: () =>
          socket.request(
            request,
            (one) =>
              (one.type === "session.created" || one.type === "error") &&
              one.clientRequestId === draft.requestId,
            signal,
          ),
        catch: failure,
      });
      if (reply.type !== "session.created") {
        return yield* Effect.fail(
          new StateError("Session creation was not confirmed."),
        );
      }
      draft.sessionId = reply.session.id;
      return draft.sessionId;
    });
    return run(program);
  }

  /** Sends a message and resolves once Leverage has stored it. */
  async send(
    sessionId: string,
    message: OutgoingMessage,
    signal: AbortSignal,
  ): Promise<SessionInput> {
    const socket = await this.socket(signal);
    const frame = sessionMessageSchema.parse({
      type: "session.message",
      sessionId,
      ...message,
      harness: "leverage/cli",
    });
    const reply = await socket.request(
      frame,
      (one) =>
        (one.type === "session.message.received" || one.type === "error") &&
        one.clientRequestId === message.clientRequestId,
      signal,
    );
    if (reply.type !== "session.message.received") {
      throw new StateError(
        "Send not confirmed. Retry to check the same request.",
      );
    }
    return inputSchema.parse(reply.message);
  }

  /** Asks Leverage to stop the turn that is running now. */
  async stop(
    sessionId: string,
    turnId: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const clientRequestId = randomUUID();
    const socket = await this.socket(signal);
    await socket.request(
      {
        type: "session.stop",
        sessionId,
        clientRequestId,
        ...(turnId ? { turnId } : {}),
      },
      (one) =>
        (one.type === "session.stop.accepted" || one.type === "error") &&
        one.clientRequestId === clientRequestId,
      signal,
    );
  }

  async rename(
    sessionId: string,
    title: string,
    signal: AbortSignal,
  ): Promise<string> {
    const parsed = sessionTitle.safeParse(title);
    if (!parsed.success) {
      throw new InputError(
        "Leverage session titles must contain 1 to 80 characters",
      );
    }
    const clientRequestId = randomUUID();
    const socket = await this.socket(signal);
    const reply = await socket.request(
      {
        type: "session.rename",
        sessionId,
        title: parsed.data,
        clientRequestId,
      },
      (one) =>
        (one.type === "session.rename.accepted" || one.type === "error") &&
        one.clientRequestId === clientRequestId,
      signal,
    );
    return reply.type === "session.rename.accepted" ? reply.title : parsed.data;
  }

  /** Answers the agent's question, keyed by each question's text. */
  async answer(
    sessionId: string,
    toolUseId: string,
    reply: {
      answers: Record<string, string>;
      annotations?: Record<string, { notes?: string }>;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const clientRequestId = randomUUID();
    const socket = await this.socket(signal);
    await socket.request(
      {
        type: "session.answer",
        sessionId,
        toolUseId,
        ...reply,
        clientRequestId,
      },
      (one) =>
        (one.type === "session.answer.received" || one.type === "error") &&
        one.clientRequestId === clientRequestId,
      signal,
    );
  }

  async compact(sessionId: string, signal?: AbortSignal): Promise<void> {
    await (await this.socket(signal)).post({
      type: "session.compact",
      sessionId,
    });
  }

  archive(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.shelve(sessionId, true, signal);
  }

  unarchive(sessionId: string, signal: AbortSignal): Promise<void> {
    return this.shelve(sessionId, false, signal);
  }

  // Leverage confirms an archive only through the session update it causes.
  private async shelve(
    sessionId: string,
    archived: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const socket = await this.socket(signal);
    await socket.request(
      {
        type: archived ? "session.archive" : "session.unarchive",
        sessionId,
      },
      (one) =>
        one.type === "error" ||
        (one.type === "session.updated" &&
          one.sessionId === sessionId &&
          !!one.archivedAt === archived),
      signal,
    );
  }

  async cancelQueued(
    sessionId: string,
    uuid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await (await this.socket(signal)).post({
      type: "session.queue.cancel",
      sessionId,
      uuid,
    });
  }

  async steerQueued(
    sessionId: string,
    uuid: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await (await this.socket(signal)).post({
      type: "session.queue.steer",
      sessionId,
      uuid,
    });
  }

  /** A native GET whose body is validated before anyone reads it. */
  private fetch<T>(path: string, schema: z.ZodType<T>) {
    return Effect.tryPromise({
      try: (signal) => api.json(path, "GET", signal),
      catch: failure,
    }).pipe(
      Effect.flatMap((json) =>
        decode(schema, json).pipe(
          // The field's path helps a report without showing any of the data.
          Effect.mapError((issue) => {
            const field = issue.issues[0]?.path.join(".");
            return new ProtocolError(
              `Leverage returned invalid data for ${path.split("?")[0]}${field ? ` (${field})` : ""}`,
            );
          }),
        ),
      ),
    );
  }

  // Native lists are scoped to the workspace by ID.
  private async scoped<T>(
    path: string,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ) {
    const workspaceId = await this.workspaceId(signal);
    return this.read(
      `${path}?workspaceId=${encodeURIComponent(workspaceId)}`,
      schema,
      signal,
    );
  }

  private validateDraft(draft: SessionDraft, signal: AbortSignal) {
    return Effect.gen({ self: this }, function* () {
      const [providers, models, channels] = yield* Effect.all(
        [
          Effect.tryPromise({
            try: () => this.providers(signal),
            catch: failure,
          }),
          // The catalog only matters when the draft names a model or effort.
          draft.model || draft.reasoningEffort
            ? Effect.tryPromise({
                try: () => this.models(signal),
                catch: failure,
              })
            : Effect.succeed([] as HostedModel[]),
          draft.context.type === "channel"
            ? Effect.tryPromise({
                try: () => this.channels(signal),
                catch: failure,
              })
            : Effect.succeed([] as Channel[]),
        ],
        { concurrency: "unbounded" },
      );
      const wanted =
        draft.context.type === "channel" ? draft.context.channelId : undefined;
      const channel = channels.find((one) => one.id === wanted);
      if (wanted && !channel) {
        return yield* Effect.fail(
          new InputError("The selected channel is no longer available."),
        );
      }
      const family = yield* chooseFamily(draft, channel, providers);
      yield* checkModel(draft, family, models);
      draft.providerFamily = family;
    });
  }
}

export const workspace = new WorkspaceClient();
