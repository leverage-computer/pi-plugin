import { afterEach, describe, expect, test } from "bun:test";
import type {
  ExtensionContext,
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { viewRemoteHistory } from "../src/session";
import { input, workspaceFixture } from "./workspace/fixture";

let fixture: ReturnType<typeof workspaceFixture> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

// A Leverage server that records which page each history request asked for.
function serve() {
  const pages: Array<{ before: string | null; limit: string | null }> = [];
  const f = workspaceFixture((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events/history")) {
      pages.push({
        before: url.searchParams.get("beforeTranscriptSeq"),
        limit: url.searchParams.get("limit"),
      });
    }
    return undefined;
  });
  fixture = f;
  f.client();
  return { f, pages };
}

function context(
  ui: Partial<ExtensionUIContext>,
  mode: "tui" | "print" = "tui",
): ExtensionContext {
  return { hasUI: mode === "tui", mode, ui } as ExtensionContext;
}

// Pi's custom view. It presses the given keys on each page it opens, then calls `opened`.
function viewer(pages: string[][], opened?: () => void) {
  const rendered: string[] = [];
  const ui: Partial<ExtensionUIContext> = {
    async custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) =>
        | (Component & { dispose?(): void })
        | Promise<Component & { dispose?(): void }>,
    ): Promise<T> {
      let finish!: (value: T) => void;
      const completed = new Promise<T>((resolve) => {
        finish = resolve;
      });
      const component = await factory(
        { requestRender() {} } as TUI,
        {
          fg: (_color: string, text: string) => text,
          bg: (_color: string, text: string) => text,
          bold: (text: string) => text,
          italic: (text: string) => text,
        } as Theme,
        {} as KeybindingsManager,
        finish,
      );
      rendered.push(component.render(100).join("\n"));
      for (const key of pages.shift() ?? []) {
        component.handleInput?.(key);
      }
      opened?.();
      const result = await completed;
      component.dispose?.();
      return result;
    },
  };
  return { ui, rendered };
}

describe("Leverage history pages", () => {
  test("names authors from members and closes with Enter", async () => {
    const { f } = serve();
    const message = input("Please check the project", { status: "consumed" });
    f.emit(
      "user",
      { content: "### Alice (<@owner>)\n\nPlease check the project" },
      { authorId: "owner", sourceInputUuids: [message.uuid] },
    );
    f.emit("text", { content: "Done.", eventId: "evt_done", finalized: true });
    // Neither paging key applies to a single page, so only Enter closes it.
    const { ui, rendered } = viewer([["n", "p", "\r"]]);
    await viewRemoteHistory(
      context(ui),
      f.session,
      new AbortController().signal,
      {
        messages: [message],
        members: [{ id: "owner", name: "Alice" }],
        viewerId: "owner",
      },
    );
    expect(rendered).toHaveLength(1);
    expect(rendered[0]).toContain("Alice");
    expect(rendered[0]).toContain("(you)");
    expect(rendered[0]).toContain("Please check the project");
    expect(rendered[0]).not.toContain("###");
    expect(rendered[0]).toContain("Done.");
    expect(rendered[0]).toContain("↑/↓ scroll · Esc close");
  });
});
