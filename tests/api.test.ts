import { afterEach, describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { ApiError, api, sameSessionId, sessionId } from "../src/api";

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

  test("coalesce renewal across requests without cancelling another caller", async () => {
    let refreshes = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let began: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      began = resolve;
    });
    fixture(async (request) => {
      if (new URL(request.url).pathname.endsWith("/refresh")) {
        refreshes++;
        began();
        await gate;
        return Response.json({ access_token: "renewed-token" });
      }
      if (request.headers.get("authorization") !== "Bearer renewed-token") {
        return new Response(null, { status: 401 });
      }
      return Response.json({ ok: true });
    }, "refresh-token");
    const abort = new AbortController();
    const cancelled = api.json("/api/workspaces", "GET", abort.signal);
    const survivor = api.json("/api/workspaces");
    await started;
    await Bun.sleep(10);
    abort.abort(new Error("Cancelled picker"));
    await assert.rejects(cancelled, /Cancelled picker/);
    release();
    expect(await survivor).toEqual({ ok: true });
    expect(refreshes).toBe(1);
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

  test("keep failures readable with HTML, malformed JSON, or oversized error bodies", async () => {
    for (const [body, contentType] of [
      ["<html>private-gateway-page</html>", "text/html"],
      ['{"message":"private-invalid-json', "application/json"],
      [
        JSON.stringify({ message: "private-".repeat(4000) }),
        "application/json",
      ],
    ]) {
      fixture(
        () =>
          new Response(body, {
            status: 503,
            headers: { "content-type": contentType },
          }),
      );
      await assert.rejects(api.json("/api/workspaces"), (error) => {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as Error).message).toContain("request failed (503)");
        expect((error as Error).message).not.toContain("private-");
        return true;
      });
      api.close();
    }
  });
});

describe("Leverage connection", () => {
  test("instances with the same settings share one connection until the last lets go", async () => {
    fixture(() => Response.json({ ok: true }));
    const first = api.connection;
    const handle = api.connect(first);
    expect(api.connected).toBe(true);
    api.close(handle);
    expect(api.connected).toBe(true);
    api.close(handle);
    expect(api.connected).toBe(false);
    await assert.rejects(api.json("/api/workspaces"), /closed/);
  });

  test("different settings replace the connection and end requests on the old one", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connection } = fixture(async () => {
      await gate;
      return Response.json({ ok: true });
    });
    const pending = api.json("/api/workspaces");
    api.connect({ ...connection, token: "other-token" });
    await assert.rejects(pending, /closed/);
    release();
  });

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

describe("Session IDs", () => {
  test("drop the prefix older links carry and reject anything that is not an ID", () => {
    expect(sessionId("ses_11111111-1111-4111-8111-111111111111")).toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(sessionId("task-one")).toBe("task-one");
    expect(() => sessionId("../other")).toThrow("Invalid Leverage session");
    expect(sameSessionId("ses_task", "task")).toBe(true);
    expect(sameSessionId("task", "other")).toBe(false);
  });
});
