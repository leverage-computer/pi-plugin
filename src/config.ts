import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type LeverageConnection, record } from "./api";

export type ConnectionFlags = {
	host?: string;
	workspace?: string;
	session?: string;
	cwd?: string;
	directory?: string;
};

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConfig(env: NodeJS.ProcessEnv): Record<string, unknown> {
	const directory =
		env.LEVERAGE_CONFIG_DIR ??
		join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "leverage");
	try {
		return record(
			JSON.parse(readFileSync(join(directory, "config.json"), "utf8")),
		);
	} catch (error) {
		if (record(error).code === "ENOENT") return {};
		throw new Error(
			"Cannot read Leverage login settings. Run leverage login again.",
		);
	}
}

export function resolveConnection(
	flags: ConnectionFlags,
	env: NodeJS.ProcessEnv = process.env,
): LeverageConnection {
	const configuredHost = text(flags.host) ?? text(env.LEVERAGE_HOST);
	const configuredWorkspace =
		text(flags.workspace) ?? text(env.LEVERAGE_WORKSPACE);
	const tokenOverride = text(env.LEVERAGE_TOKEN);
	const config =
		configuredHost && configuredWorkspace && tokenOverride
			? {}
			: readConfig(env);
	const host = new URL(
		configuredHost ??
			text(config.currentHost) ??
			"https://app.leverage.computer",
	);
	if (
		!["https:", "http:"].includes(host.protocol) ||
		host.username ||
		host.password ||
		host.pathname !== "/" ||
		host.search ||
		host.hash
	) {
		throw new Error(
			"Leverage host must be an HTTP(S) origin without a path or credentials.",
		);
	}
	const profile = record(record(config.hosts)[host.origin]);
	const workspace = configuredWorkspace ?? text(profile.workspaceSlug);
	if (!workspace || !/^[a-zA-Z0-9_-]+$/.test(workspace)) {
		throw new Error(
			"Set --leverage-workspace to your Leverage workspace slug.",
		);
	}
	const token = tokenOverride ?? text(profile.accessToken);
	if (!token || /[\s:]/.test(token)) {
		throw new Error("Sign in with leverage login, or set LEVERAGE_TOKEN.");
	}
	const refreshToken = tokenOverride
		? text(env.LEVERAGE_REFRESH_TOKEN)
		: text(profile.refreshToken);
	const sessionId = text(flags.session) ?? text(env.LEVERAGE_SESSION);
	if (sessionId && !/^(?:ses_)?[a-zA-Z0-9_-]+$/.test(sessionId)) {
		throw new Error("Leverage session must be a task ID.");
	}
	const cwd = text(flags.cwd) ?? text(env.LEVERAGE_CWD);
	if (cwd && (!cwd.startsWith("/") || /[\u0000-\u001f\u007f]/.test(cwd))) {
		throw new Error(
			"Leverage working directory must be an absolute remote path.",
		);
	}
	const directory = text(flags.directory) ?? text(env.LEVERAGE_DIRECTORY);
	if (
		directory &&
		(!directory.startsWith(`/${workspace}`) ||
			!new RegExp(`^/${workspace}(?:/[a-zA-Z0-9_.-]+)?$`).test(directory))
	) {
		throw new Error(
			"Leverage folder must be /workspace or /workspace/channel.",
		);
	}

	return {
		host: host.origin,
		workspace,
		token,
		...(refreshToken ? { refreshToken } : {}),
		...(sessionId ? { sessionId } : {}),
		...(cwd ? { cwd } : {}),
		...(directory ? { directory } : {}),
	};
}
