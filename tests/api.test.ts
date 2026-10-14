import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import {
  ApiError,
  api,
  endSignIn,
  signedInWorkspaces,
  signIn,
} from "../src/api";

const disposals: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) {
    dispose();
  }
});

// A local server the shared client talks to.
function fixture(
  handler: (request: Request) => Response | Promise<Response>,
  refreshToken?: string,
) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  const connection = {
    host: server.url.origin,
    workspace: "alpha",
    token: "test-token",
    refreshToken,
  };
  api.connect(connection);
  disposals.push(() => {
    api.close();
    void server.stop(true);
  });
  return { connection };
}

describe("Leverage requests", () => {
  test("send the device token and read JSON, and a 204 reads as nothing", async () => {
    const seen: Array<string | null> = [];
    fixture((request) => {
      seen.push(request.headers.get("authorization"));
      return new URL(request.url).pathname === "/api/empty"
        ? new Response(null, { status: 204 })
        : Response.json([{ id: "workspace", slug: "alpha" }]);
    });
    expect(await api.json("/api/workspaces")).toEqual([
      { id: "workspace", slug: "alpha" },
    ]);
    expect(await api.json("/api/empty", "POST")).toBeUndefined();
    expect(seen).toEqual(["Bearer test-token", "Bearer test-token"]);
  });

  test("refuse paths outside the API and replies that are not JSON", async () => {
    fixture(() => new Response("not json", { status: 200 }));
    await assert.rejects(api.json("/elsewhere"), /Invalid Leverage API path/);
    await assert.rejects(api.json("/api/workspaces"), /invalid JSON/);
  });

  test("report a second rejection after renewal, and never renew without a refresh token", async () => {
    let refreshes = 0;
    fixture((request) => {
      if (new URL(request.url).pathname.endsWith("/refresh")) {
        refreshes++;
        return Response.json({ access_token: "still-rejected" });
      }
      return new Response(null, { status: 401 });
    }, "refresh-token");
    await assert.rejects(api.json("/api/workspaces"), /failed \(401\)/);
    expect(refreshes).toBe(1);
    api.close();
    const bare = fixture(() => new Response(null, { status: 401 }));
    expect(bare.connection.refreshToken).toBeUndefined();
    await assert.rejects(api.json("/api/workspaces"), /failed \(401\)/);
    expect(refreshes).toBe(1);
  });

  test("report the failing endpoint and the server's reason without payloads or query text", async () => {
    const { connection } = fixture(() =>
      Response.json(
        {
          message:
            "\u001b[31mthis folder could not be read just now\u001b[0m\n",
          data: { token: "private-response-data" },
        },
        {
          status: 503,
          headers: { "x-leverage-correlation-id": "test-request-123" },
        },
      ),
    );
    await assert.rejects(
      api.json("/api/sessions/abc/bootstrap?limit=200&secret=private-query"),
      (error) => {
        expect(error).toBeInstanceOf(ApiError);
        const failure = error as ApiError;
        expect(failure.status).toBe(503);
        expect(failure.message).toContain(
          "this folder could not be read just now",
        );
        expect(failure.message).toContain(
          `GET ${connection.host}/api/sessions/abc/bootstrap`,
        );
        expect(failure.message).toContain("Request ID: test-request-123");
        expect(failure.message).not.toMatch(
          /private-|test-token|\u001b|\?limit/,
        );
        return true;
      },
    );
  });
});

describe("Leverage connection", () => {
  test("rejects unsafe hosts and malformed credentials before any request", () => {
    for (const host of [
      "https://user:secret@one.example",
      "https://one.example/api",
      "file:///tmp",
    ]) {
      expect(() =>
        api.connect({ host, workspace: "alpha", token: "token" }),
      ).toThrow("HTTP or HTTPS origin");
    }
    expect(() =>
      api.connect({
        host: "https://one.example",
        workspace: "alpha",
        token: "has space",
      }),
    ).toThrow("device token");
  });
});

describe("Session IDs", () => {});

describe("Signing in through the browser", () => {
  // A local Leverage that answers each poll from a script.
  function server(polls: Response[]) {
    const seen: string[] = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        const body = request.method === "POST" ? await request.text() : "";
        seen.push(
          `${request.method} ${path} ${request.headers.get("authorization") ?? ""} ${body}`.trim(),
        );
        if (path === "/api/cli/auth/device") {
          return Response.json({
            device_code: "device-1",
            user_code: "ABCD-EFGH",
            expires_in: 30,
            interval: 0.01,
          });
        }
        if (path === "/api/cli/auth/token") {
          return (
            polls.shift() ??
            Response.json({ error: "expired" }, { status: 410 })
          );
        }
        if (path === "/api/workspaces") {
          return Response.json([{ id: "w-1", slug: "acme", name: "Acme" }]);
        }
        if (path === "/api/cli/auth/refresh") {
          return Response.json({ access_token: "renewed" });
        }
        if (path === "/api/cli/auth/revoke") {
          return request.headers.get("authorization") === "Bearer renewed"
            ? Response.json({ ok: true })
            : Response.json({ error: "invalid_token" }, { status: 401 });
        }
        return new Response(null, { status: 404 });
      },
    });
    disposals.push(() => void server.stop(true));
    return { host: server.url.origin, seen };
  }

  test("shows the code, waits for approval, and lists the workspaces", async () => {
    const { host, seen } = server([
      Response.json({ error: "authorization_pending" }, { status: 428 }),
      Response.json({ error: "authorization_pending" }, { status: 428 }),
      Response.json({ access_token: "access", refresh_token: "refresh" }),
    ]);
    const shown: string[] = [];
    const login = await signIn(host, (code, link) => shown.push(code, link));
    expect(login).toEqual({ accessToken: "access", refreshToken: "refresh" });
    expect(shown).toEqual(["ABCD-EFGH", `${host}/device?user_code=ABCD-EFGH`]);
    expect(seen[0]).toBe('POST /api/cli/auth/device  {"client_name":"Pi"}');
    expect(
      seen.filter((one) => one.startsWith("POST /api/cli/auth/token")),
    ).toHaveLength(3);
    expect(await signedInWorkspaces(host, login)).toEqual([
      { id: "w-1", slug: "acme", name: "Acme" },
    ]);
    expect(seen.at(-1)).toBe("GET /api/workspaces Bearer access");
  });

  test("says when the sign-in is denied or expires", async () => {
    const denied = server([
      Response.json({ error: "denied" }, { status: 410 }),
    ]);
    await assert.rejects(
      signIn(denied.host, () => {}),
      /denied/,
    );
    const expired = server([]);
    await assert.rejects(
      signIn(expired.host, () => {}),
      /expired/,
    );
  });

  test("ends a sign-in on Leverage, renewing a stale access token first", async () => {
    const { host, seen } = server([]);
    await endSignIn(host, { accessToken: "stale", refreshToken: "refresh" });
    expect(seen).toEqual([
      "POST /api/cli/auth/revoke Bearer stale {}",
      'POST /api/cli/auth/refresh  {"refresh_token":"refresh"}',
      "POST /api/cli/auth/revoke Bearer renewed {}",
    ]);
  });
});
