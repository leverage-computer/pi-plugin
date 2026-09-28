import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface DrawerItem {
	value: string;
	label: string;
	detail?: string;
	disabled?: boolean;
	current?: boolean;
}

export function drawerContext(ctx: ExtensionContext): ExtensionContext {
	return {
		...ctx,
		ui: {
			...ctx.ui,
			select: async (title, choices, options) => {
				const picked = await chooseDrawer(
					ctx,
					title,
					choices.map((label, index) => ({ value: String(index), label })),
					options?.signal ?? new AbortController().signal,
				);
				return picked === undefined ? undefined : choices[Number(picked)];
			},
		},
	};
}
export function clean(value: string): string {
	return stripVTControlCharacters(value).replace(
		/[\u0000-\u0008\u000b-\u001f\u007f]/g,
		"",
	);
}
// Truncation adds reset codes, and a reset ends a row highlight early.
function fit(text: string, width: number): string {
	return width > 0
		? stripVTControlCharacters(truncateToWidth(text, width, "…"))
		: "";
}
function wrap(text: string, width: number): string[] {
	return text
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

export function keyHints(theme: Theme, hints: Array<[string, string]>): string {
	return hints
		.map(
			([key, label]) =>
				`${theme.fg("accent", key)} ${theme.fg("muted", label)}`,
		)
		.join("   ");
}

// Draws a rounded panel with its title in the top border.
export function frame(
	theme: Theme,
	width: number,
	title: string,
	lines: string[],
	note = "",
): string[] {
	const inner = Math.max(1, width - 4);
	const heading = fit(title, width - 6);
	const corner = fit(note, width - 8);
	const border = (text: string) => theme.fg("borderAccent", text);
	return [
		`${border("╭─ ")}${theme.bold(theme.fg("accent", heading))}${border(` ${"─".repeat(Math.max(0, width - 5 - visibleWidth(heading)))}╮`)}`,
		...lines.map(
			(line) =>
				`${border("│")} ${truncateToWidth(line, inner, "…", true)} ${border("│")}`,
		),
		corner
			? border(
					`╰${"─".repeat(Math.max(0, width - 5 - visibleWidth(corner)))} ${theme.fg("dim", corner)}${border(" ─╯")}`,
				)
			: border(`╰${"─".repeat(Math.max(0, width - 2))}╯`),
	];
}

function drawerOptions(columns: number) {
	return {
		anchor: "right-center" as const,
		width:
			columns >= 100
				? Math.min(72, Math.floor(columns * 0.6))
				: Math.max(24, columns - 2),
		maxHeight: "95%" as const,
		margin: 1,
	};
}

export async function chooseDrawer(
	ctx: ExtensionContext,
	title: string,
	items: DrawerItem[] | (() => DrawerItem[]),
	signal: AbortSignal,
	subtitle = "",
	query = "",
): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("This drawer requires interactive Pi.");
	if (signal.aborted) return;
	let columns = process.stdout.columns || 100;
	return ctx.ui.custom<string | undefined>(
		(tui, theme, _keys, done) => {
			columns = tui.terminal.columns;
			let selected = 0;
			const search = new Input({ prompt: "/ " });
			search.setValue(query);
			search.focused = true;
			const values = () =>
				(typeof items === "function" ? items() : items).filter((one) =>
					`${one.label} ${one.detail ?? ""}`
						.toLowerCase()
						.includes(search.getValue().toLowerCase()),
				);
			const abort = () => done(undefined);
			signal.addEventListener("abort", abort, { once: true });
			const timer = setInterval(() => tui.requestRender(), 250);
			const row = (item: DrawerItem, active: boolean, inner: number) => {
				const label = clean(item.label).replace(/\s+/g, " ");
				const detail = clean(item.detail ?? "").replace(/\s+/g, " ");
				const check = item.current ? 2 : 0;
				const shownLabel = fit(label, inner - 2 - check);
				const room = inner - 2 - check - visibleWidth(shownLabel);
				const shownDetail = room >= 6 ? fit(detail, room - 3) : "";
				const text = `${active ? theme.fg("accent", "›") : " "} ${theme.fg(
					item.disabled ? "dim" : active ? "accent" : "text",
					active ? theme.bold(shownLabel) : shownLabel,
				)}${item.current ? theme.fg("success", " ✓") : ""}${" ".repeat(
					Math.max(0, room - visibleWidth(shownDetail)),
				)}${theme.fg(active ? "muted" : "dim", shownDetail)}`;
				return {
					line: active ? theme.bg("selectedBg", text) : text,
					cut: shownLabel !== label || shownDetail !== detail,
					full: [label, detail].filter(Boolean).join("\n"),
				};
			};
			return {
				focused: true,
				render(width) {
					const inner = Math.max(1, width - 4);
					const rows = values();
					selected = Math.min(selected, Math.max(0, rows.length - 1));
					const [heading = "", ...body] = clean(title).split("\n");
					const text = body.join("\n").trim();
					const bodyLines = text ? wrap(text, inner) : [];
					const bodyLimit = Math.max(3, Math.floor(tui.terminal.rows * 0.35));
					const top = [
						...(subtitle
							? wrap(clean(subtitle).replace(/\s+/g, " "), inner).map((line) =>
									theme.fg("dim", line),
								)
							: []),
						...bodyLines
							.slice(0, bodyLimit)
							.map((line) => theme.fg("muted", line)),
						...(bodyLines.length > bodyLimit
							? [
									theme.fg(
										"dim",
										`… ${bodyLines.length - bodyLimit} more lines`,
									),
								]
							: []),
					];
					const active = rows[selected]
						? row(rows[selected], true, inner)
						: undefined;
					const detail = active?.cut
						? [
								"",
								...wrap(active.full, inner)
									.slice(0, 3)
									.map((line) => theme.fg("dim", line)),
							]
						: [];
					const height = Math.max(
						3,
						Math.floor(tui.terminal.rows * 0.95) -
							top.length -
							detail.length -
							8,
					);
					const start = Math.max(
						0,
						Math.min(selected - Math.floor(height / 2), rows.length - height),
					);
					const list = rows
						.slice(start, start + height)
						.map((item, index) =>
							start + index === selected
								? active!.line
								: row(item, false, inner).line,
						);
					return frame(
						theme,
						width,
						clean(heading),
						[
							...top,
							...(top.length ? [""] : []),
							search.getValue()
								? (search.render(inner)[0] ?? "")
								: theme.fg("dim", "/ Type to filter"),
							"",
							...(list.length ? list : [theme.fg("dim", "  No matches")]),
							...detail,
							"",
							keyHints(theme, [
								["↑↓", "move"],
								["Enter", "select"],
								["Esc", "back"],
							]),
						],
						rows.length > height ? `${selected + 1}/${rows.length}` : "",
					);
				},
				handleInput(data) {
					if (matchesKey(data, "escape")) return done(undefined);
					if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
					else if (matchesKey(data, "down"))
						selected = Math.min(values().length - 1, selected + 1);
					else if (matchesKey(data, "pageDown"))
						selected = Math.min(values().length - 1, selected + 10);
					else if (matchesKey(data, "pageUp"))
						selected = Math.max(0, selected - 10);
					else if (matchesKey(data, "enter")) {
						const item = values()[selected];
						if (item && !item.disabled) done(item.value);
					} else {
						search.handleInput(data);
						selected = 0;
					}
					tui.requestRender();
				},
				invalidate() {
					search.invalidate();
				},
				dispose() {
					clearInterval(timer);
					signal.removeEventListener("abort", abort);
				},
			};
		},
		{ overlay: true, overlayOptions: () => drawerOptions(columns) },
	);
}

export async function textDrawer(
	ctx: ExtensionContext,
	title: string,
	read: () => string,
	signal: AbortSignal,
	options: {
		subtitle?: () => string;
		format?: (text: string, width: number) => string[];
	} = {},
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(clean(read()), "info");
		return;
	}
	if (signal.aborted) return;
	await ctx.ui.custom<void>(
		(tui, theme, _keys, done) => {
			let offset = 0;
			let max = 0;
			let height = 10;
			const abort = () => done();
			signal.addEventListener("abort", abort, { once: true });
			const timer = setInterval(() => tui.requestRender(), 500);
			return {
				render(width) {
					const inner = Math.max(1, width - 4);
					const text = clean(read());
					const lines = options.format
						? options.format(text, inner)
						: wrap(text, inner);
					const subtitle = options.subtitle
						? [theme.fg("dim", fit(clean(options.subtitle()), inner)), ""]
						: [];
					height = Math.max(
						3,
						Math.floor(tui.terminal.rows * 0.95) - subtitle.length - 4,
					);
					max = Math.max(0, lines.length - height);
					offset = Math.min(offset, max);
					return frame(
						theme,
						width,
						clean(title),
						[
							...subtitle,
							...lines.slice(offset, offset + height),
							"",
							keyHints(theme, [
								["↑↓", "scroll"],
								["PgUp PgDn", "page"],
								["Esc", "back"],
							]),
						],
						lines.length > height
							? `${offset + 1}–${Math.min(lines.length, offset + height)} of ${lines.length}`
							: "",
					);
				},
				handleInput(data) {
					if (matchesKey(data, "escape")) return done();
					if (matchesKey(data, "up")) offset = Math.max(0, offset - 1);
					if (matchesKey(data, "down")) offset = Math.min(max, offset + 1);
					if (matchesKey(data, "pageUp")) offset = Math.max(0, offset - height);
					if (matchesKey(data, "pageDown"))
						offset = Math.min(max, offset + height);
					tui.requestRender();
				},
				invalidate() {},
				dispose() {
					clearInterval(timer);
					signal.removeEventListener("abort", abort);
				},
			};
		},
		{
			overlay: true,
			overlayOptions: () => ({
				anchor: "center",
				width: "100%",
				maxHeight: "95%",
			}),
		},
	);
}
