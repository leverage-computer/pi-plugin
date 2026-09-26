import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConnection } from "../src/config";

const directories: string[] = [];
function settings(config?: unknown) {
	const directory = mkdtempSync(join(tmpdir(), "pi-config-"));
	directories.push(directory);
	if (config !== undefined)
		writeFileSync(join(directory, "config.json"), JSON.stringify(config));
	return { LEVERAGE_CONFIG_DIR: directory };
}
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("Leverage connection settings", () => {
	test("uses the selected CLI host's workspace and device credential", () => {
		const env = settings({
			currentHost: "https://one.example",
			hosts: {
				"https://one.example": {
					workspaceSlug: "alpha",
					accessToken: "lev_at_example",
					refreshToken: "lev_rt_example",
				},
				"https://two.example": {
					workspaceSlug: "beta",
					accessToken: "lev_at_other",
					refreshToken: "lev_rt_other",
				},
			},
		});
		expect(resolveConnection({ session: "task-id" }, env)).toEqual({
			host: "https://one.example",
			workspace: "alpha",
			token: "lev_at_example",
			refreshToken: "lev_rt_example",
			sessionId: "task-id",
		});
		expect(
			resolveConnection(
				{ session: "task-id" },
				{ ...env, LEVERAGE_TOKEN: "explicit-token" },
			).refreshToken,
		).toBeUndefined();
		expect(
			resolveConnection(
				{ host: "https://two.example/", session: "task-id" },
				env,
			).token,
		).toBe("lev_at_other");
		expect(() =>
			resolveConnection(
				{
					host: "https://unknown.example",
					session: "task-id",
					workspace: "alpha",
				},
				env,
			),
		).toThrow("leverage login");
	});
	test("honors flags over environment without reading login settings when credentials are explicit", () => {
		const env = {
			...settings(),
			LEVERAGE_HOST: "https://one.example",
			LEVERAGE_WORKSPACE: "alpha",
			LEVERAGE_TOKEN: "test-token",
			LEVERAGE_REFRESH_TOKEN: "test-refresh-token",
			LEVERAGE_SESSION: "from-env",
			LEVERAGE_CWD: "/work/env",
		};
		writeFileSync(join(env.LEVERAGE_CONFIG_DIR, "config.json"), "invalid");
		expect(
			resolveConnection(
				{
					host: "http://localhost:8000",
					workspace: "beta",
					session: "from-flag",
					cwd: "/work/project",
				},
				env,
			),
		).toEqual({
			host: "http://localhost:8000",
			workspace: "beta",
			token: "test-token",
			refreshToken: "test-refresh-token",
			sessionId: "from-flag",
			cwd: "/work/project",
		});
	});
	test("reads the XDG CLI profile without changing it", () => {
		const env = settings();
		mkdirSync(join(env.LEVERAGE_CONFIG_DIR, "leverage"));
		writeFileSync(
			join(env.LEVERAGE_CONFIG_DIR, "leverage", "config.json"),
			JSON.stringify({
				currentHost: "https://one.example",
				hosts: {
					"https://one.example": {
						workspaceSlug: "alpha",
						accessToken: "lev_at_example",
						refreshToken: "lev_rt_example",
					},
				},
			}),
		);
		expect(
			resolveConnection(
				{ session: "task" },
				{ XDG_CONFIG_HOME: env.LEVERAGE_CONFIG_DIR },
			).workspace,
		).toBe("alpha");
	});
	test("allows session browsing and rejects malformed settings and unsafe origins", () => {
		const env = {
			...settings(),
			LEVERAGE_HOST: "https://one.example",
			LEVERAGE_WORKSPACE: "alpha",
			LEVERAGE_TOKEN: "secret-token",
		};
		expect(resolveConnection({}, env).sessionId).toBeUndefined();
		expect(() => resolveConnection({ session: "invalid/id" }, env)).toThrow(
			"task ID",
		);
		for (const host of [
			"https://user:secret@one.example",
			"https://one.example/api",
			"https://one.example?token=secret",
			"file:///tmp",
		]) {
			expect(() => resolveConnection({ host, session: "task" }, env)).toThrow(
				"HTTP(S) origin",
			);
		}
		expect(() =>
			resolveConnection({ session: "task", cwd: "./local" }, env),
		).toThrow("absolute remote path");
		writeFileSync(join(env.LEVERAGE_CONFIG_DIR, "config.json"), "{broken");
		expect(() =>
			resolveConnection(
				{ session: "task" },
				{ LEVERAGE_CONFIG_DIR: env.LEVERAGE_CONFIG_DIR },
			),
		).toThrow("Cannot read Leverage login settings");
	});
});
