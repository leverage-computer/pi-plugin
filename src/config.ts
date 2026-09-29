import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { LeverageConnection } from "./api";
import { ConfigError } from "./errors";
import { decode, runSync } from "./runtime";

export type ConnectionFlags = {
  host?: string;
  workspace?: string;
  session?: string;
  directory?: string;
};

const DEFAULT_HOST = "https://app.leverage.computer";

const HOST_MESSAGE =
  "Leverage host must be an HTTP(S) origin without a path or credentials.";

const WORKSPACE_MESSAGE =
  "Set --leverage-workspace to your Leverage workspace slug.";

const TOKEN_MESSAGE = "Sign in with leverage login, or set LEVERAGE_TOKEN.";

// Anything that is not a non-blank string reads as "unset".
const optionalText = z
  .unknown()
  .transform((value) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined,
  );

const profile = z.object({
  workspaceSlug: optionalText,
  accessToken: optionalText,
  refreshToken: optionalText,
});

const noProfile: z.output<typeof profile> = {
  workspaceSlug: undefined,
  accessToken: undefined,
  refreshToken: undefined,
};

const configFile = z
  .object({
    currentHost: optionalText,
    hosts: z.record(z.string(), profile.catch(noProfile)).catch({}),
  })
  .catch({ currentHost: undefined, hosts: {} });

const missingFile = z.object({ code: z.literal("ENOENT") });

const origin = z
  .string({ error: HOST_MESSAGE })
  .transform((value, ctx) => {
    try {
      return new URL(value);
    } catch {
      ctx.addIssue(HOST_MESSAGE);
      return z.NEVER;
    }
  })
  .refine(
    (host) =>
      ["https:", "http:"].includes(host.protocol) &&
      !host.username &&
      !host.password &&
      host.pathname === "/" &&
      !host.search &&
      !host.hash,
    HOST_MESSAGE,
  )
  .transform((host) => host.origin);

const workspaceSlug = z
  .string({ error: WORKSPACE_MESSAGE })
  .regex(/^[a-zA-Z0-9_-]+$/, WORKSPACE_MESSAGE);

const deviceToken = z
  .string({ error: TOKEN_MESSAGE })
  .refine((token) => !/[\s:]/.test(token), TOKEN_MESSAGE);

const taskId = z
  .string()
  .regex(/^(?:ses_)?[a-zA-Z0-9_-]+$/, "Leverage session must be a task ID.")
  .optional();

const folderIn = (workspace: string) =>
  z
    .string()
    .regex(
      new RegExp(`^/${workspace}(?:/[a-zA-Z0-9_.-]+)?$`),
      "Leverage folder must be /workspace or /workspace/channel.",
    )
    .optional();

const configError = (issue: z.ZodError) =>
  new ConfigError(issue.issues[0]?.message ?? "");

function readConfig(env: NodeJS.ProcessEnv) {
  const directory =
    env.LEVERAGE_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "leverage");
  return Effect.try({
    try: (): unknown =>
      JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) =>
      missingFile.safeParse(error).success
        ? Effect.succeed(undefined)
        : Effect.fail(
            new ConfigError(
              "Cannot read Leverage login settings. Run leverage login again.",
            ),
          ),
    ),
    Effect.map((raw) => configFile.parse(raw)),
  );
}

export function resolveConnection(
  flags: ConnectionFlags,
  env: NodeJS.ProcessEnv = process.env,
): LeverageConnection {
  const program = Effect.gen(function* () {
    const configuredHost =
      optionalText.parse(flags.host) ?? optionalText.parse(env.LEVERAGE_HOST);
    const configuredWorkspace =
      optionalText.parse(flags.workspace) ??
      optionalText.parse(env.LEVERAGE_WORKSPACE);
    const tokenOverride = optionalText.parse(env.LEVERAGE_TOKEN);
    // The login file is only read when a setting is missing.
    const config =
      configuredHost && configuredWorkspace && tokenOverride
        ? { currentHost: undefined, hosts: {} }
        : yield* readConfig(env);
    const host = yield* decode(
      origin,
      configuredHost ?? config.currentHost ?? DEFAULT_HOST,
    ).pipe(Effect.mapError(configError));
    const saved = config.hosts[host] ?? noProfile;
    const workspace = yield* decode(
      workspaceSlug,
      configuredWorkspace ?? saved.workspaceSlug,
    ).pipe(Effect.mapError(configError));
    const token = yield* decode(
      deviceToken,
      tokenOverride ?? saved.accessToken,
    ).pipe(Effect.mapError(configError));
    const refreshToken = tokenOverride
      ? optionalText.parse(env.LEVERAGE_REFRESH_TOKEN)
      : saved.refreshToken;
    const sessionId = yield* decode(
      taskId,
      optionalText.parse(flags.session) ??
        optionalText.parse(env.LEVERAGE_SESSION),
    ).pipe(Effect.mapError(configError));
    const directory = yield* decode(
      folderIn(workspace),
      optionalText.parse(flags.directory) ??
        optionalText.parse(env.LEVERAGE_DIRECTORY),
    ).pipe(Effect.mapError(configError));
    return {
      host,
      workspace,
      token,
      ...(refreshToken ? { refreshToken } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(directory ? { directory } : {}),
    } satisfies LeverageConnection;
  });
  return runSync(program);
}
