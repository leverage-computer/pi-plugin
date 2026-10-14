import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConnection, saveLogin } from "../src/config";

const directories: string[] = [];
function settings(config?: unknown) {
  const directory = mkdtempSync(join(tmpdir(), "pi-config-"));
  directories.push(directory);
  if (config !== undefined) {
    writeFileSync(join(directory, "config.json"), JSON.stringify(config));
  }
  return { LEVERAGE_CONFIG_DIR: directory };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("remembered model", () => {});

describe("Leverage connection settings", () => {
  test("uses the selected CLI host's workspace and device credential", () => {
    const env = settings({
      currentHost: "https://one.example",
      hosts: {
        "https://one.example": {
          workspaceSlug: "alpha",
          accessToken: "access-example",
          refreshToken: "refresh-example",
        },
        "https://two.example": {
          workspaceSlug: "beta",
          accessToken: "access-other",
          refreshToken: "refresh-other",
        },
      },
    });
    expect(resolveConnection({ session: "task-id" }, env)).toEqual({
      host: "https://one.example",
      workspace: "alpha",
      token: "access-example",
      refreshToken: "refresh-example",
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
    ).toBe("access-other");
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
        },
        env,
      ),
    ).toEqual({
      host: "http://localhost:8000",
      workspace: "beta",
      token: "test-token",
      refreshToken: "test-refresh-token",
      sessionId: "from-flag",
    });
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
    writeFileSync(join(env.LEVERAGE_CONFIG_DIR, "config.json"), "{broken");
    expect(() =>
      resolveConnection(
        { session: "task" },
        { LEVERAGE_CONFIG_DIR: env.LEVERAGE_CONFIG_DIR },
      ),
    ).toThrow("Cannot read Leverage login settings");
  });
});

describe("Pi's own sign-in", () => {
  // A CLI login and a Pi login, each in its own scratch folder.
  function both() {
    const agent = mkdtempSync(join(tmpdir(), "pi-agent-"));
    directories.push(agent);
    return {
      ...settings({
        currentHost: "https://one.example",
        hosts: {
          "https://one.example": {
            workspaceSlug: "alpha",
            accessToken: "cli-access",
            refreshToken: "cli-refresh",
          },
        },
      }),
      PI_CODING_AGENT_DIR: agent,
    };
  }
  const login = {
    host: "https://two.example",
    workspace: "beta",
    accessToken: "pi-access",
    refreshToken: "pi-refresh",
  };

  test("comes before the CLI's, and only Pi's owner reads it", () => {
    const env = both();
    expect(resolveConnection({}, env).token).toBe("cli-access");
    saveLogin(login, env);
    const file = join(env.PI_CODING_AGENT_DIR, "leverage.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(resolveConnection({}, env)).toEqual({
      host: "https://two.example",
      workspace: "beta",
      token: "pi-access",
      refreshToken: "pi-refresh",
    });
    // The CLI's host still uses the CLI's login.
    expect(resolveConnection({ host: "https://one.example" }, env).token).toBe(
      "cli-access",
    );
  });

  test("tightens a file kept with a looser mode", () => {
    const env = both();
    const file = join(env.PI_CODING_AGENT_DIR, "leverage.json");
    writeFileSync(file, "{}", { mode: 0o644 });
    saveLogin(login, env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
