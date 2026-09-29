import { stripVTControlCharacters } from "node:util";
import {
	type ExtensionContext,
	keyHint,
	rawKeyHint,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
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
export function report(ctx: ExtensionContext, error: unknown): void {
	ctx.ui.notify(
		clean(error instanceof Error ? error.message : "Leverage request failed"),
		"error",
	);
}

// Pi's own selectors: a rule, an accent title, the content, a hint line and a rule.
function selector(
	theme: Theme,
	width: number,
	title: string,
	content: string[],
	hint: string,
): string[] {
	const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
	return [
		rule,
		"",
		...wrapTextWithAnsi(
			theme.fg("accent", theme.bold(title)),
			Math.max(1, width - 2),
		).map((line) => ` ${line}`),
		"",
		...content.map((line) => ` ${line}`),
		"",
		` ${hint}`,
		"",
		rule,
	].map((line) => truncateToWidth(line, width));
}
function paragraph(
	theme: Theme,
	text: string,
	width: number,
	color: ThemeColor = "muted",
): string[] {
	return text
		.split("\n")
		.flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]))
		.map((line) => theme.fg(color, line));
}

export async function chooseDrawer(
	ctx: ExtensionContext,
	title: string,
	items: DrawerItem[],
	signal: AbortSignal,
	subtitle = "",
	query = "",
): Promise<string | undefined> {
	if (!ctx.hasUI) throw new Error("This drawer requires interactive Pi.");
	if (signal.aborted) return;
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		let selected = 0;
		const search = new Input();
		search.setValue(query);
		search.focused = true;
		const values = () =>
			items.filter((one) =>
				`${one.label} ${one.detail ?? ""}`
					.toLowerCase()
					.includes(search.getValue().toLowerCase()),
			);
		const abort = () => done(undefined);
		signal.addEventListener("abort", abort, { once: true });
		return {
			focused: true,
			render(width) {
				const inner = Math.max(1, width - 2);
				const rows = values();
				selected = Math.min(selected, Math.max(0, rows.length - 1));
				const [heading = "", ...body] = clean(title).split("\n");
				const text = body.join("\n").trim();
				const bodyLines = text ? paragraph(theme, text, inner) : [];
				const bodyLimit = Math.max(3, Math.floor(tui.terminal.rows * 0.3));
				const marks = rows.some((one) => one.current);
				const start = Math.max(0, Math.min(selected - 5, rows.length - 10));
				const row = (item: DrawerItem, active: boolean) => {
					const label = clean(item.label).replace(/\s+/g, " ");
					const detail = clean(item.detail ?? "").replace(/\s+/g, " ");
					const line = `${active ? theme.fg("accent", "→ ") : "  "}${marks ? (item.current ? theme.fg("accent", "✓ ") : "  ") : ""}${theme.fg(active ? "accent" : "text", label)}${detail ? ` ${theme.fg("muted", detail)}` : ""}`;
					return { line, cut: visibleWidth(line) > inner, label, detail };
				};
				const active = rows[selected] ? row(rows[selected], true) : undefined;
				return selector(
					theme,
					width,
					clean(heading),
					[
						...(subtitle
							? paragraph(theme, clean(subtitle).replace(/\s+/g, " "), inner)
							: []),
						...bodyLines.slice(0, bodyLimit),
						...(bodyLines.length > bodyLimit
							? [
									theme.fg(
										"muted",
										`... (${bodyLines.length - bodyLimit} more lines)`,
									),
								]
							: []),
						...(subtitle || bodyLines.length ? [""] : []),
						...search.render(inner),
						"",
						...rows
							.slice(start, start + 10)
							.map((item, index) =>
								start + index === selected
									? active!.line
									: row(item, false).line,
							),
						...(rows.length > 10
							? [theme.fg("muted", `  (${selected + 1}/${rows.length})`)]
							: []),
						...(!rows.length ? [theme.fg("muted", "  No matching items")] : []),
						...(active?.cut
							? [
									"",
									...paragraph(
										theme,
										[active.label, active.detail].filter(Boolean).join("\n"),
										inner,
									).slice(0, 3),
								]
							: []),
					],
					`${rawKeyHint("↑↓", "navigate")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "cancel")}`,
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
					if (item) done(item.value);
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
				signal.removeEventListener("abort", abort);
			},
		};
	});
}

export async function textDrawer(
	ctx: ExtensionContext,
	title: string,
	read: () => string,
	signal: AbortSignal,
): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(clean(read()), "info");
		return;
	}
	if (signal.aborted) return;
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let offset = 0;
		let max = 0;
		let height = 10;
		const abort = () => done();
		signal.addEventListener("abort", abort, { once: true });
		const timer = setInterval(() => tui.requestRender(), 500);
		return {
			render(width) {
				const lines = paragraph(
					theme,
					clean(read()),
					Math.max(1, width - 2),
					"text",
				);
				height = Math.max(3, Math.floor(tui.terminal.rows * 0.6));
				max = Math.max(0, lines.length - height);
				offset = Math.min(offset, max);
				return selector(
					theme,
					width,
					clean(title),
					[
						...lines.slice(offset, offset + height),
						...(lines.length > height
							? [
									theme.fg(
										"muted",
										`(${offset + 1}–${Math.min(lines.length, offset + height)}/${lines.length})`,
									),
								]
							: []),
					],
					`${rawKeyHint("↑↓", "scroll")}  ${keyHint("tui.select.cancel", "close")}`,
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
	});
}
