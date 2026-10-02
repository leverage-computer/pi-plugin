import { stripVTControlCharacters } from "node:util";
import { Duration, Effect } from "effect";
import { z } from "zod";
import {
  ApiError,
  failure,
  InputError,
  ProtocolError,
  StateError,
} from "./errors";
import { decode, run, runSync, within } from "./runtime";

export { ApiError, failure, ProtocolError } from "./errors";

export type LeverageConnection = {
  host: string;
  workspace: string;
  token: string;
  refreshToken?: string;
  sessionId?: string;
  directory?: string;
};

type Failure = Error;

type TokenRefresh = {
  controller: AbortController;
  promise: Promise<void>;
  waiters: number;
};

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

const connectionSchema = z.object({
  host: z
    .string()
    .transform((value, ctx) => {
      try {
        return new URL(value);
      } catch {
        ctx.addIssue("Leverage host must be an HTTP or HTTPS origin");
        return z.NEVER;
      }
    })
    .refine(
      (host) =>
        ["http:", "https:"].includes(host.protocol) &&
        !host.username &&
        !host.password &&
        !host.search &&
        !host.hash &&
        host.pathname === "/",
      "Leverage host must be an HTTP or HTTPS origin",
    )
    .transform((host) => host.origin),
  workspace: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/, "A Leverage workspace slug is required"),
  token: z
    .string()
    .min(1, "A Leverage device token is required")
    .refine((token) => !/[\s:]/.test(token), {
      message: "A Leverage device token is required",
    }),
  refreshToken: z.string().optional(),
});

const accessToken = z
  .object({ access_token: z.string().min(1) })
  .transform((body) => body.access_token);

const correlationId = z.string().regex(/^[a-zA-Z0-9._:-]{1,128}$/);

const sanitized = z.string().transform((detail) =>
  stripVTControlCharacters(detail)
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 512),
);

const errorDetail = z.union([
  z.object({ message: sanitized }).transform((body) => body.message),
  z
    .object({ error: z.object({ message: sanitized }) })
    .transform((body) => body.error.message),
  z.object({ error: sanitized }).transform((body) => body.error),
]);

/**
 * A session ID as Leverage's native API spells it. Links saved by older
 * versions of this plugin carry a `ses_` prefix, which is dropped here.
 */
export function sessionId(id: string): string {
  const plain = id.replace(/^ses_/, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(plain)) {
    throw new InputError("Invalid Leverage session ID");
  }
  return plain;
}

export function sameSessionId(one: string, other: string): boolean {
  return one.replace(/^ses_/, "") === other.replace(/^ses_/, "");
}

/** Reads a body up to a byte limit, then releases the stream. */
function readBody(
  response: Response,
  limit: number,
): Effect.Effect<Uint8Array, Failure> {
  return Effect.tryPromise({
    try: async (signal) => {
      const reader = response.body?.getReader();
      if (!reader) {
        throw new ProtocolError("Leverage returned an empty response");
      }
      const stop = () => void reader.cancel().catch(() => undefined);
      signal.addEventListener("abort", stop, { once: true });
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const read = await reader.read();
          if (read.done) {
            break;
          }
          size += read.value.byteLength;
          if (size > limit) {
            throw new ProtocolError(
              `Leverage response exceeds the ${limit / 1024 / 1024} MiB limit`,
            );
          }
          chunks.push(read.value);
        }
      } finally {
        signal.removeEventListener("abort", stop);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      return Buffer.concat(chunks, size);
    },
    catch: failure,
  });
}

/** Builds the error for a failing response. The body only lends its message. */
function requestError(
  response: Response,
  method: string,
  url: URL,
  action = "request",
): Effect.Effect<ApiError> {
  const detail = response.headers.get("content-type")?.includes("json")
    ? readBody(response, MAX_ERROR_BODY_BYTES).pipe(
        Effect.flatMap((bytes) =>
          Effect.try((): unknown =>
            JSON.parse(Buffer.from(bytes).toString("utf8")),
          ),
        ),
        Effect.map((body) => errorDetail.safeParse(body)),
        Effect.map((result) => (result.success ? result.data : undefined)),
      )
    : Effect.succeed(undefined);
  return detail.pipe(
    // The HTTP status remains useful when the error body cannot be read.
    Effect.catch(() => Effect.succeed(undefined)),
    Effect.map((message) => {
      const id = correlationId.safeParse(
        response.headers.get("x-leverage-correlation-id"),
      );
      return new ApiError(response.status, action, {
        request: `${method} ${url.origin}${url.pathname}`,
        message,
        ...(id.success ? { correlationId: id.data } : {}),
      });
    }),
  );
}

class Unauthorized extends Error {
  constructor(readonly token: string) {
    super("Leverage authentication failed");
  }
}

/**
 * Shares one device credential across every request to Leverage's native API.
 * The plugin holds exactly one, exported below as `api`. Every extension
 * instance that connects with the same settings holds the same connection,
 * and it ends when the last holder closes it. Different settings replace it.
 */
export class SessionClient {
  connection!: LeverageConnection;
  private id = 0;
  private holders = 0;
  private origin = "";
  private workspace = "";
  private token = "";
  private refreshToken?: string;
  private refreshing?: TokenRefresh;
  private lifetime = new AbortController();

  constructor() {
    this.lifetime.abort(new Error("Leverage is not connected"));
  }

  get connected(): boolean {
    return !this.lifetime.signal.aborted;
  }

  /** Joins or replaces the connection. The result is this holder's handle. */
  connect(settings: LeverageConnection): number {
    const parsed = runSync(
      decode(connectionSchema, settings).pipe(
        Effect.mapError(
          (issue) =>
            new InputError(issue.issues[0]?.message ?? "Invalid settings"),
        ),
      ),
    );
    const same =
      this.connected &&
      this.origin === parsed.host &&
      this.workspace === parsed.workspace &&
      this.token === parsed.token &&
      this.refreshToken === parsed.refreshToken;
    if (same) {
      this.holders++;
      return this.id;
    }
    this.close();
    this.connection = settings;
    this.origin = parsed.host;
    this.workspace = parsed.workspace;
    this.token = parsed.token;
    this.refreshToken = parsed.refreshToken;
    this.refreshing = undefined;
    this.lifetime = new AbortController();
    this.holders = 1;
    return ++this.id;
  }

  /** Releases a handle, or ends the connection outright without one. */
  close(handle?: number): void {
    if (handle !== undefined) {
      if (handle !== this.id) {
        return;
      }
      if (!this.connected) {
        return;
      }
      this.holders--;
      if (this.holders > 0) {
        return;
      }
    }
    this.holders = 0;
    this.lifetime.abort(new Error("The Leverage connection was closed"));
    this.refreshing?.controller.abort(this.lifetime.signal.reason);
  }

  authorization(): string {
    return `Bearer ${this.token}`;
  }

  refreshCredential(previous: string, signal: AbortSignal): Promise<void> {
    return this.run(
      this.refreshToken
        ? this.renew(previous.replace(/^Bearer /, ""))
        : Effect.fail(new StateError("Sign in with leverage login again.")),
      signal,
    );
  }

  /** Sends one JSON request to a native `/api/…` path and reads its reply. */
  json(
    path: string,
    method = "GET",
    signal?: AbortSignal,
    body?: unknown,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    return this.run(this.fetchJson(path, method, body, timeoutMs), signal);
  }

  /** A file Leverage serves, such as an attached image, read whole. */
  bytes(
    path: string,
    signal?: AbortSignal,
    limit = MAX_RESPONSE_BYTES,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const program = Effect.suspend(() => {
      if (!path.startsWith("/api/")) {
        return Effect.fail(new InputError("Invalid Leverage API path"));
      }
      return this.send(new URL(path, this.origin), "GET");
    }).pipe(
      Effect.flatMap((response) =>
        readBody(response, limit).pipe(
          Effect.map((data) => ({
            data,
            contentType: response.headers.get("content-type") ?? "",
          })),
        ),
      ),
    );
    return this.run(program, signal);
  }

  private run<A>(effect: Effect.Effect<A, Failure>, signal?: AbortSignal) {
    return run(effect, within(this.lifetime.signal, signal));
  }

  private fetchJson(
    path: string,
    method: string,
    body?: unknown,
    timeoutMs = 30_000,
  ): Effect.Effect<unknown, Failure> {
    return Effect.suspend(() => {
      if (!path.startsWith("/api/")) {
        return Effect.fail(new InputError("Invalid Leverage API path"));
      }
      return this.send(new URL(path, this.origin), method, body);
    }).pipe(
      Effect.flatMap((response) =>
        response.status === 204
          ? Effect.succeed(undefined)
          : readBody(response, MAX_RESPONSE_BYTES).pipe(
              Effect.flatMap((bytes) =>
                Effect.try({
                  try: () =>
                    JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown,
                  catch: () =>
                    new ProtocolError("Leverage returned invalid JSON"),
                }),
              ),
            ),
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () => Effect.fail(new Error("Leverage request timed out")),
      }),
    );
  }

  /** One authenticated request. An expired token is renewed once, then retried. */
  private send(
    url: URL,
    method: string,
    body?: unknown,
  ): Effect.Effect<Response, Failure> {
    if (url.origin !== this.origin) {
      return Effect.fail(new InputError("Invalid Leverage request origin"));
    }
    const once = (renewable: boolean) =>
      Effect.suspend(() => {
        const token = this.token;
        return Effect.tryPromise({
          try: (signal) =>
            fetch(url, {
              method,
              signal,
              redirect: "error",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/json",
              },
              ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
            }),
          catch: failure,
        }).pipe(
          Effect.flatMap((response) =>
            response.status === 401 && renewable && this.refreshToken
              ? Effect.tryPromise({
                  try: async () => response.body?.cancel(),
                  catch: failure,
                }).pipe(Effect.andThen(Effect.fail(new Unauthorized(token))))
              : response.ok
                ? Effect.succeed(response)
                : Effect.flatMap(
                    requestError(response, method, url),
                    Effect.fail,
                  ),
          ),
        );
      });
    // A second rejection after renewal is reported as it is.
    return once(true).pipe(
      Effect.catchIf(
        (error): error is Unauthorized => error instanceof Unauthorized,
        (error) => this.renew(error.token).pipe(Effect.andThen(once(false))),
      ),
    );
  }

  /** Joins the shared renewal. The last waiter to leave cancels it. */
  private renew(previous: string): Effect.Effect<void, Failure> {
    return Effect.suspend(() => {
      if (this.token !== previous) {
        return Effect.void;
      }
      if (!this.refreshing) {
        const controller = new AbortController();
        this.refreshing = {
          controller,
          waiters: 0,
          promise: run(
            this.exchangeToken().pipe(
              Effect.tap((token) =>
                Effect.sync(() => {
                  this.token = token;
                }),
              ),
              Effect.asVoid,
            ),
            controller.signal,
          ).finally(() => {
            if (this.refreshing?.controller === controller) {
              this.refreshing = undefined;
            }
          }),
        };
      }
      const pending = this.refreshing;
      pending.waiters++;
      return Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            let settled = false;
            const finish = (error?: Error) => {
              if (settled) {
                return;
              }
              settled = true;
              signal.removeEventListener("abort", abort);
              pending.waiters--;
              if (pending.waiters === 0 && this.refreshing === pending) {
                this.refreshing = undefined;
                pending.controller.abort(error);
              }
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            };
            const abort = () => finish(failure(signal.reason));
            signal.addEventListener("abort", abort, { once: true });
            if (signal.aborted) {
              abort();
            }
            void pending.promise.then(
              () => finish(),
              (error: unknown) => finish(failure(error)),
            );
          }),
        catch: failure,
      });
    });
  }

  private exchangeToken(): Effect.Effect<string, Failure> {
    const url = new URL("/api/cli/auth/refresh", this.origin);
    return Effect.tryPromise({
      try: (signal) =>
        fetch(url, {
          method: "POST",
          signal,
          redirect: "error",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ refresh_token: this.refreshToken }),
        }),
      catch: failure,
    }).pipe(
      Effect.flatMap(
        (response): Effect.Effect<string, Failure> =>
          response.ok
            ? Effect.tryPromise({
                try: (): Promise<unknown> => response.json(),
                catch: failure,
              }).pipe(
                Effect.mapError(
                  () =>
                    new ProtocolError(
                      "Leverage returned an invalid token response",
                    ),
                ),
                Effect.flatMap((body) =>
                  decode(accessToken, body).pipe(
                    Effect.mapError(
                      () =>
                        new ProtocolError(
                          "Leverage returned an invalid access token",
                        ),
                    ),
                  ),
                ),
              )
            : Effect.flatMap(
                requestError(response, "POST", url, "token refresh"),
                Effect.fail,
              ),
      ),
      Effect.timeoutOrElse({
        duration: Duration.seconds(15),
        orElse: () =>
          Effect.fail(new Error("Leverage token refresh timed out")),
      }),
    );
  }
}

/** The one connection this plugin holds. */
export const api = new SessionClient();
