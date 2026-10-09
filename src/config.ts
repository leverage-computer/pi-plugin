import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { z } from "zod";
import type { LeverageConnection } from "./api";
import { ConfigError } from "./errors";
import { decode, runSync } from "./runtime";
import { familySchema, type ProviderFamily } from "./workspace/schema";

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

const TOKEN_MESSAGE = "Sign in with /leverage login, or set LEVERAGE_TOKEN.";

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

const emptyConfig: z.output<typeof configFile> = {
  currentHost: undefined,
  hosts: {},
};

// The sign-in `/leverage login` keeps for Pi alone.
const piLogin = z.object({
  host: optionalText,
  workspace: optionalText,
  accessToken: optionalText,
  refreshToken: optionalText,
});

export type PiLogin = {
  host: string;
  workspace: string;
  accessToken: string;
  refreshToken: string;
};

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

// Where `leverage login` keeps its settings.
function configDirectory(env: NodeJS.ProcessEnv): string {
  return (
    env.LEVERAGE_CONFIG_DIR ??
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "leverage")
  );
}

// Where `/leverage login` keeps Pi's own sign-in, beside Pi's settings.
function loginFile(env: NodeJS.ProcessEnv): string {
  const agent = optionalText.parse(env.PI_CODING_AGENT_DIR);
  return join(
    agent?.replace(/^~(?=$|\/)/, homedir()) ?? join(homedir(), ".pi", "agent"),
    "leverage.json",
  );
}

function readLogin(env: NodeJS.ProcessEnv) {
  try {
    const saved = piLogin.parse(
      JSON.parse(readFileSync(loginFile(env), "utf8")),
    );
    return saved.host ? saved : undefined;
  } catch {
    return undefined;
  }
}

/** Keeps a `/leverage login` sign-in where only this person reads it. */
export function saveLogin(
  login: PiLogin,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const file = loginFile(env);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(login, null, 2)}\n`, { mode: 0o600 });
  // A file kept before keeps its mode, so set it again.
  chmodSync(file, 0o600);
}

/** Forgets the `/leverage login` sign-in, and says what it was. */
export function forgetLogin(
  env: NodeJS.ProcessEnv = process.env,
): PiLogin | undefined {
  const saved = readLogin(env);
  rmSync(loginFile(env), { force: true });
  return saved?.host &&
    saved.workspace &&
    saved.accessToken &&
    saved.refreshToken
    ? {
        host: saved.host,
        workspace: saved.workspace,
        accessToken: saved.accessToken,
        refreshToken: saved.refreshToken,
      }
    : undefined;
}

/** The server `/leverage login` signs in to. */
export function loginHost(
  flag?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return runSync(
    decode(
      origin,
      optionalText.parse(flag) ??
        optionalText.parse(env.LEVERAGE_HOST) ??
        DEFAULT_HOST,
    ).pipe(Effect.mapError(configError)),
  );
}

export type ModelPick = {
  providerFamily?: ProviderFamily;
  model?: string;
  reasoningEffort?: string;
};

// The model a person last picked for a new session, per host and workspace.
// The web app keeps the same pick in the browser.
const picksSchema = z
  .record(
    z.string(),
    z.object({
      providerFamily: familySchema.optional().catch(undefined),
      model: z.string().optional().catch(undefined),
      reasoningEffort: z.string().optional().catch(undefined),
    }),
  )
  .catch({});

function readPicks(env: NodeJS.ProcessEnv) {
  try {
    return picksSchema.parse(
      JSON.parse(readFileSync(join(configDirectory(env), "pi.json"), "utf8")),
    );
  } catch {
    return {};
  }
}

/** The last model picked for new sessions here, if any. */
export function rememberedModel(
  connection: Pick<LeverageConnection, "host" | "workspace">,
  env: NodeJS.ProcessEnv = process.env,
): ModelPick {
  return readPicks(env)[`${connection.host}/${connection.workspace}`] ?? {};
}

/** Keeps a new session's model as the pick for the next one. */
export function rememberModel(
  connection: Pick<LeverageConnection, "host" | "workspace">,
  pick: ModelPick,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const directory = configDirectory(env);
  const picks = {
    ...readPicks(env),
    [`${connection.host}/${connection.workspace}`]: pick,
  };
  try {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "pi.json"), JSON.stringify(picks, null, 2));
  } catch {
    // The pick is a convenience. The session works without it.
  }
}

function readConfig(env: NodeJS.ProcessEnv) {
  const directory = configDirectory(env);
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
    // The login files are only read when a setting is missing.
    const complete = configuredHost && configuredWorkspace && tokenOverride;
    // Pi's own sign-in comes first. The CLI's is used without it.
    const own = complete ? undefined : readLogin(env);
    const cli = complete
      ? emptyConfig
      : own
        ? yield* readConfig(env).pipe(
            Effect.catch(() => Effect.succeed(emptyConfig)),
          )
        : yield* readConfig(env);
    const config = own?.host
      ? {
          currentHost: own.host,
          hosts: {
            ...cli.hosts,
            [own.host]: {
              workspaceSlug: own.workspace,
              accessToken: own.accessToken,
              refreshToken: own.refreshToken,
            },
          },
        }
      : cli;
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
