import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import { type SessionClient, type SessionInfo, sameSessionId } from "./api";
import { clean } from "./drawers";
import { createHistoryComponent, SharedHistory } from "./history";
import { nativeId } from "./workspace/api";
import type { SessionInput, WorkspaceMember } from "./workspace/schema";

export const LINK_ENTRY = "leverage-session";

export type SessionLink = {
	version: 1;
	host: string;
	workspace: string;
	sessionId: string;
	cwd?: string;
};

export function sessionLink(
	entries: readonly SessionEntry[],
): SessionLink | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== LINK_ENTRY) continue;
		const data = entry.data as Partial<SessionLink> | undefined;
		if (
			data?.version === 1 &&
			typeof data.host === "string" &&
			typeof data.workspace === "string" &&
			typeof data.sessionId === "string" &&
			(data.cwd === undefined || typeof data.cwd === "string")
		)
			return data as SessionLink;
	}
	return undefined;
}

export function sameSession(one: SessionLink, other: SessionLink): boolean {
	return (
		one.host === other.host &&
		one.workspace === other.workspace &&
		sameSessionId(one.sessionId, other.sessionId)
	);
}

export async function viewRemoteHistory(
	api: SessionClient,
	ctx: ExtensionContext,
	session: SessionInfo,
	signal: AbortSignal,
	attribution?: {
		messages: SessionInput[];
		members: WorkspaceMember[];
		viewerId?: string;
	},
): Promise<void> {
	const cursors: Array<string | undefined> = [undefined];
	let pageNumber = 0;
	while (!signal.aborted) {
		const page = await api.history(session.id, {
			order: "desc",
			limit: 50,
			cursor: cursors[pageNumber],
			signal,
		});
		if (signal.aborted) return;
		const projection = new SharedHistory(session.id);
		if (attribution) {
			const ids = new Set(page.data.map((one) => nativeId(one.id)));
			projection.attribute(
				attribution.messages.filter((one) => ids.has(one.uuid)),
				attribution.members,
				attribution.viewerId,
			);
		}
		projection.merge(page.data);
		const content =
			projection
				.entries()
				.map((entry) => entry.content)
				.join("\n\n") || "This session has no messages yet.";
		if (ctx.mode !== "tui") {
			ctx.ui.notify(clean(content), "info");
			return;
		}
		const action = await ctx.ui.custom<"older" | "newer" | "close">(
			(tui, theme, _keys, done) => {
				let offset = 0;
				let maximum = 0;
				let height = 20;
				const abort = () => done("close");
				signal.addEventListener("abort", abort, { once: true });
				const text = new Container();
				for (const entry of projection.entries())
					text.addChild(createHistoryComponent(() => entry, true, theme));
				if (!projection.entries().length)
					text.addChild(new Text(content, 0, 0));
				return {
					render(width) {
						const lines = text.render(width);
						height = Math.max(5, (process.stdout.rows || 24) - 5);
						maximum = Math.max(0, lines.length - height);
						offset = Math.min(offset, maximum);
						return [
							...new Text(
								theme.fg(
									"accent",
									clean(
										`${session.title || "Leverage history"} · Page ${pageNumber + 1}`,
									),
								),
								0,
								0,
							).render(width),
							...lines.slice(offset, offset + height),
							...new Text(
								theme.fg(
									"dim",
									`↑/↓ scroll · ${page.cursor.next ? "n older · " : ""}${pageNumber ? "p newer · " : ""}Esc close`,
								),
								0,
								0,
							).render(width),
						];
					},
					invalidate() {
						text.invalidate();
					},
					handleInput(data) {
						if (matchesKey(data, "escape") || matchesKey(data, "enter"))
							return done("close");
						if (data === "n" && page.cursor.next) return done("older");
						if (data === "p" && pageNumber) return done("newer");
						if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
						if (matchesKey(data, "down"))
							offset = Math.min(maximum, offset + 1);
						if (matchesKey(data, "pageUp"))
							offset = Math.max(0, offset - height);
						if (matchesKey(data, "pageDown"))
							offset = Math.min(maximum, offset + height);
						tui.requestRender();
					},
					dispose() {
						signal.removeEventListener("abort", abort);
					},
				};
			},
		);
		if (action === "close" || signal.aborted) return;
		if (action === "older") cursors[++pageNumber] = page.cursor.next;
		else pageNumber -= 1;
	}
}
