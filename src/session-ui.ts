import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, matchesKey, Text } from "@earendil-works/pi-tui";
import type { SessionClient, SessionInfo } from "./api";
import { createHistoryComponent, SharedHistory } from "./history";

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
		one.sessionId.replace(/^ses_/, "") === other.sessionId.replace(/^ses_/, "")
	);
}

export async function viewRemoteHistory(
	api: SessionClient,
	ctx: ExtensionContext,
	session: SessionInfo,
	signal: AbortSignal,
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
		projection.merge(page.data);
		const content =
			projection
				.entries()
				.map((entry) => entry.content)
				.join("\n\n") || "This session has no messages yet.";
		if (ctx.mode !== "tui") {
			ctx.ui.notify(stripVTControlCharacters(content), "info");
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
					text.addChild(createHistoryComponent(() => entry, true));
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
									stripVTControlCharacters(
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

export async function newRemoteSession(
	api: SessionClient,
	ctx: ExtensionContext,
	options: {
		title?: string;
		directory?: string;
		workspace: string;
		signal: AbortSignal;
	},
): Promise<SessionInfo | undefined> {
	let title = options.title?.trim();
	if (!title) {
		if (!ctx.hasUI)
			throw new Error("Use /leverage new <title> to create a session.");
		title = (
			await ctx.ui.input("New Leverage session", "Session title", {
				signal: options.signal,
			})
		)?.trim();
	}
	if (!title || options.signal.aborted) return;
	let directory = options.directory;
	if (!directory && ctx.hasUI) {
		const folders = await api.folders(options.signal);
		if (options.signal.aborted) return;
		directory = await ctx.ui.select("Session folder", folders, {
			signal: options.signal,
		});
		if (!directory || options.signal.aborted) return;
	}
	return api.create({
		title,
		directory: directory ?? `/${options.workspace}`,
		signal: options.signal,
	});
}

export async function pickRemoteSession(
	api: SessionClient,
	ctx: ExtensionContext,
	options: {
		workspace: string;
		directory?: string;
		search?: string;
		signal: AbortSignal;
	},
): Promise<SessionInfo | undefined> {
	if (!ctx.hasUI)
		throw new Error(
			"Use --leverage-session ID or /leverage open ID outside interactive mode.",
		);
	let search = options.search ?? "";
	let cursor: string | undefined;
	const previous: Array<string | undefined> = [];
	let archived = false;
	while (!options.signal.aborted) {
		const page = await api.list({
			search,
			cursor,
			limit: 30,
			directory: archived
				? `/${options.workspace}/.archive`
				: options.directory,
			signal: options.signal,
		});
		if (options.signal.aborted) return;
		const labels = page.data.map((session) => {
			const updated = new Date(session.time.updated).toLocaleString();
			return stripVTControlCharacters(
				`${session.title || "Untitled session"} · ${session.location.directory} · ${updated} · ${session.id}`,
			);
		});
		const actions = [
			"+ New session",
			"Search sessions",
			"Refresh",
			archived ? "Show active sessions" : "Show archived sessions",
		];
		if (previous.length) actions.push("Previous page");
		if (page.cursor.next) actions.push("Next page");
		const selected = await ctx.ui.select(
			`Leverage · ${options.workspace}${search ? ` · ${search}` : ""}${page.data.length ? "" : " · No sessions found"}`,
			[...actions, ...labels],
			{ signal: options.signal },
		);
		if (selected === undefined || options.signal.aborted) return;
		const index = labels.indexOf(selected);
		if (index !== -1) return page.data[index];
		if (selected === "+ New session")
			return newRemoteSession(api, ctx, options);
		if (selected === "Search sessions") {
			const entered = await ctx.ui.input("Search Leverage sessions", search, {
				signal: options.signal,
			});
			if (entered === undefined) continue;
			search = entered.trim();
			cursor = undefined;
			previous.length = 0;
		} else if (selected === "Next page") {
			previous.push(cursor);
			cursor = page.cursor.next;
		} else if (selected === "Previous page") {
			cursor = previous.pop();
		} else if (
			selected === "Show active sessions" ||
			selected === "Show archived sessions"
		) {
			archived = !archived;
			cursor = undefined;
			previous.length = 0;
		}
	}
	return undefined;
}
