import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	Input,
	matchesKey,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";

export interface DrawerItem {
	value: string;
	label: string;
	detail?: string;
	disabled?: boolean;
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
function drawerOptions(columns: number) {
	return {
		anchor: "right-center" as const,
		width:
			columns >= 100
				? Math.min(70, Math.floor(columns * 0.6))
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
			const search = new Input({
				prompt: "Search: ",
				placeholder: "type to filter",
			});
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
			return {
				focused: true,
				render(width) {
					const rows = values();
					selected = Math.min(selected, Math.max(0, rows.length - 1));
					const heading = new Text(theme.fg("accent", clean(title)), 0, 0)
						.render(Math.max(1, width - 4))
						.slice(0, 5);
					const height = Math.max(
						1,
						(process.stdout.rows || 30) - 9 - heading.length,
					);
					const start = Math.max(
						0,
						Math.min(selected - Math.floor(height / 2), rows.length - height),
					);
					const lines = [
						...heading,
						...(subtitle
							? [theme.fg("dim", clean(subtitle).replace(/\s+/g, " "))]
							: []),
						...search.render(width - 4),
						"",
					];
					for (const [index, item] of rows
						.slice(start, start + height)
						.entries()) {
						const label = clean(
							`${start + index === selected ? "›" : " "} ${item.label}${item.detail ? ` · ${item.detail}` : ""}`,
						).replace(/\s+/g, " ");
						lines.push(
							theme.fg(
								item.disabled
									? "dim"
									: start + index === selected
										? "accent"
										: "text",
								label,
							),
						);
					}
					if (!rows.length) lines.push(theme.fg("dim", "No matching items"));
					lines.push(
						"",
						theme.fg("dim", "↑↓ choose · Enter open · F1 details · Esc back"),
					);
					return [
						theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
						...lines.map(
							(line) =>
								`│ ${truncateToWidth(line, Math.max(1, width - 4), "…", true)} │`,
						),
						theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
					];
				},
				handleInput(data) {
					if (matchesKey(data, "escape")) return done(undefined);
					if (matchesKey(data, "f1")) {
						void textDrawer(
							ctx,
							"Details",
							() =>
								`${title}\n\n${values()[selected]?.label ?? ""}\n${values()[selected]?.detail ?? ""}`,
							signal,
						);
						return;
					}
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
					const lines = new Text(clean(read()), 1, 0).render(width);
					height = Math.max(4, (process.stdout.rows || 30) - 7);
					max = Math.max(0, lines.length - height);
					offset = Math.min(offset, max);
					return [
						theme.fg("accent", truncateToWidth(clean(title), width)),
						"",
						...lines
							.slice(offset, offset + height)
							.map((line) =>
								theme.fg(
									line.trimStart().startsWith("+")
										? "success"
										: line.trimStart().startsWith("-")
											? "error"
											: "text",
									line,
								),
							),
						"",
						theme.fg("dim", "↑↓ / PgUp PgDn scroll · Esc back"),
					];
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
				width: "95%",
				maxHeight: "95%",
			}),
		},
	);
}
