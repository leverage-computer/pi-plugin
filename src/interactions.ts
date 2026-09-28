import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	FormAnswer,
	PermissionRequest,
	SessionClient,
	SessionEvent,
	SessionForm,
} from "./api";

type Field = SessionForm["fields"][number];
type Value = FormAnswer[string];
type Interaction = "approvals" | "questions" | "inbox" | "model";

function displayText(text: string): string {
	return stripVTControlCharacters(text).replace(
		/[\u0000-\u0008\u000b-\u001f\u007f]/g,
		"",
	);
}

async function choose(
	ctx: ExtensionContext,
	title: string,
	choices: string[],
	options: { signal: AbortSignal },
): Promise<string | undefined> {
	const labels = choices.map(displayText);
	const picked = await ctx.ui.select(displayText(title), labels, options);
	return picked === undefined ? undefined : choices[labels.indexOf(picked)];
}

function input(
	ctx: ExtensionContext,
	title: string,
	placeholder: string | undefined,
	options: { signal: AbortSignal },
): Promise<string | undefined> {
	return ctx.ui.input(
		displayText(title),
		placeholder === undefined ? undefined : displayText(placeholder),
		options,
	);
}

function confirm(
	ctx: ExtensionContext,
	title: string,
	body: string,
	options: { signal: AbortSignal },
): Promise<boolean> {
	return ctx.ui.confirm(displayText(title), displayText(body), options);
}

function sameId(one: string, other: string): boolean {
	return one.replace(/^ses_/, "") === other.replace(/^ses_/, "");
}

function fieldError(
	field: Field,
	value: Value | undefined,
): string | undefined {
	if (field.type === "external") return;
	if (
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && !value.length)
	)
		return field.required ? "An answer is required." : undefined;
	if (field.type === "string" && typeof value === "string") {
		if (field.minLength !== undefined && value.length < field.minLength)
			return `Enter at least ${field.minLength} characters.`;
		if (field.maxLength !== undefined && value.length > field.maxLength)
			return `Enter no more than ${field.maxLength} characters.`;
		if (field.pattern && !new RegExp(field.pattern).test(value))
			return "This answer does not match the required format.";
		if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
			return "Enter an email address.";
		if (field.format === "uri") {
			try {
				new URL(value);
			} catch {
				return "Enter a complete URL.";
			}
		}
		if (
			field.format === "date" &&
			(!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
				!Number.isFinite(Date.parse(value)))
		)
			return "Enter a date as YYYY-MM-DD.";
		if (field.format === "date-time" && !Number.isFinite(Date.parse(value)))
			return "Enter a date and time.";
	}
	if (field.type === "integer" || field.type === "number") {
		if (typeof value !== "number" || !Number.isFinite(value))
			return "Enter a number.";
		if (field.type === "integer" && !Number.isInteger(value))
			return "Enter a whole number.";
		if (field.minimum !== undefined && value < field.minimum)
			return `Enter at least ${field.minimum}.`;
		if (field.maximum !== undefined && value > field.maximum)
			return `Enter no more than ${field.maximum}.`;
	}
	if (field.type === "multiselect" && Array.isArray(value)) {
		if (field.minItems !== undefined && value.length < field.minItems)
			return `Select at least ${field.minItems} answers.`;
		if (field.maxItems !== undefined && value.length > field.maxItems)
			return `Select no more than ${field.maxItems} answers.`;
	}
	return undefined;
}

async function askField(
	ctx: ExtensionContext,
	field: Exclude<Field, { type: "external" }>,
	signal: AbortSignal,
): Promise<{ value?: Value } | undefined> {
	const title = [field.title || field.key, field.description]
		.filter(Boolean)
		.join("\n");
	let selected = field.type === "multiselect" ? [...(field.default ?? [])] : [];
	while (!signal.aborted) {
		let value: Value | undefined;
		if (field.type === "boolean") {
			const picked = await choose(
				ctx,
				title,
				["Yes", "No", ...(!field.required ? ["Skip"] : [])],
				{ signal },
			);
			if (picked === undefined || signal.aborted) return;
			value = picked === "Skip" ? undefined : picked === "Yes";
		} else if (field.type === "multiselect") {
			const choices = field.options.map(
				(option, index) =>
					`${selected.includes(option.value) ? "[x]" : "[ ]"} ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
			);
			const picked = await choose(
				ctx,
				title,
				[...choices, ...(field.custom ? ["Add another answer"] : []), "Done"],
				{ signal },
			);
			if (picked === undefined || signal.aborted) return;
			if (picked === "Add another answer") {
				const custom = await input(ctx, title, "Another answer", { signal });
				if (signal.aborted) return;
				if (custom?.trim() && !selected.includes(custom.trim()))
					selected.push(custom.trim());
				continue;
			}
			if (picked !== "Done") {
				const option = field.options[choices.indexOf(picked)];
				if (option)
					selected = selected.includes(option.value)
						? selected.filter((one) => one !== option.value)
						: [...selected, option.value];
				continue;
			}
			value = selected;
		} else if (field.type === "string" && field.options?.length) {
			const labels = field.options.map(
				(option, index) =>
					`${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}`,
			);
			const picked = await choose(
				ctx,
				title,
				[
					...labels,
					...(field.custom ? ["Write another answer"] : []),
					...(!field.required ? ["Skip"] : []),
				],
				{ signal },
			);
			if (picked === undefined || signal.aborted) return;
			if (picked === "Write another answer") {
				value = await input(ctx, title, field.placeholder, { signal });
				if (value === undefined || signal.aborted) return;
			} else value = field.options[labels.indexOf(picked)]?.value;
		} else {
			const entered = await input(
				ctx,
				title,
				field.type === "string"
					? (field.placeholder ?? field.default)
					: field.default?.toString(),
				{ signal },
			);
			if (entered === undefined || signal.aborted) return;
			value =
				entered.trim() === ""
					? undefined
					: field.type === "string"
						? entered
						: Number(entered);
		}
		const error = fieldError(field, value);
		if (error) {
			ctx.ui.notify(error, "warning");
			continue;
		}
		return { value };
	}
	return undefined;
}

async function collectAnswers(
	ctx: ExtensionContext,
	form: SessionForm,
	signal: AbortSignal,
): Promise<FormAnswer | undefined> {
	const answer: Record<string, Value> = {};
	for (const field of form.fields) {
		if (signal.aborted) return;
		if (field.type === "external") {
			ctx.ui.notify(
				displayText(
					`${field.title || form.title}: ${field.url}\nComplete this request in your browser.`,
				),
				"info",
			);
			return;
		}
		if (
			field.when?.some((condition) => {
				const other = answer[condition.key];
				if (other === undefined) return true;
				const equal = Array.isArray(other)
					? typeof condition.value === "string" &&
						other.includes(condition.value)
					: other === condition.value;
				return condition.op === "eq" ? !equal : equal;
			})
		)
			continue;
		if (field.hidden) {
			const error = fieldError(field, field.default);
			if (error) {
				ctx.ui.notify(
					displayText(`${field.title || field.key}: ${error}`),
					"warning",
				);
				return;
			}
			if (field.default !== undefined) answer[field.key] = field.default;
			continue;
		}
		const response = await askField(ctx, field, signal);
		if (!response || signal.aborted) return;
		if (response.value !== undefined) answer[field.key] = response.value;
	}
	return answer;
}

export class PendingInteractions {
	private readonly resolutions = new Map<string, string>();
	private permissions = new Map<string, PermissionRequest>();
	private forms = new Map<string, SessionForm>();
	private revision = 0;
	private refreshing?: Promise<void>;
	private refreshAgain = false;
	private active?: { id?: string; controller: AbortController };
	private closed = false;
	private lastCanWrite: boolean;
	private readonly abort = () => this.close();

	constructor(
		private readonly api: SessionClient,
		private readonly ctx: ExtensionContext,
		private readonly sessionId: string,
		private readonly signal: AbortSignal,
		private readonly canWrite: () => boolean = () => true,
	) {
		this.lastCanWrite = canWrite();
		signal.addEventListener("abort", this.abort, { once: true });
		if (signal.aborted) this.close();
	}

	get hasDialog(): boolean {
		return this.active !== undefined;
	}
	get approvalCount(): number {
		return this.permissions.size;
	}
	permissionsChanged(): void {
		const writable = this.canWrite();
		if (this.lastCanWrite && !writable) this.active?.controller.abort();
		this.lastCanWrite = writable;
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.active?.controller.abort();
		this.signal.removeEventListener("abort", this.abort);
		this.ctx.ui.setWidget("leverage-pending", undefined);
	}

	refresh(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				const revision = this.revision;
				const [permissions, forms] = await Promise.all([
					this.api.permissions(this.sessionId, this.signal),
					this.api.forms(this.sessionId, this.signal),
				]);
				if (this.closed) return;
				if (revision !== this.revision) {
					this.refreshAgain = true;
					continue;
				}
				const activeId = this.active?.id;
				const previous = activeId
					? (this.permissions.get(activeId) ?? this.forms.get(activeId))
					: undefined;
				this.permissions = new Map(permissions.map((one) => [one.id, one]));
				this.forms = new Map(forms.map((one) => [one.id, one]));
				if (
					activeId &&
					!isDeepStrictEqual(
						previous,
						this.permissions.get(activeId) ?? this.forms.get(activeId),
					)
				)
					this.dismiss(activeId);
				if (
					this.active?.id &&
					!this.permissions.has(this.active.id) &&
					!this.forms.has(this.active.id)
				)
					this.active.controller.abort();
				this.render();
			} while (this.refreshAgain && !this.closed);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}

	apply(event: SessionEvent): void {
		if (this.closed) return;
		if (event.type === "form.created") {
			if (!sameId(event.data.form.sessionID, this.sessionId)) return;
			if (
				this.forms.has(event.data.form.id) &&
				!isDeepStrictEqual(this.forms.get(event.data.form.id), event.data.form)
			)
				this.dismiss(event.data.form.id);
			this.forms.set(event.data.form.id, event.data.form);
		} else if (event.type === "permission.asked") {
			if (!sameId(event.data.sessionID, this.sessionId)) return;
			if (
				this.permissions.has(event.data.id) &&
				!isDeepStrictEqual(this.permissions.get(event.data.id), event.data)
			)
				this.dismiss(event.data.id);
			this.permissions.set(event.data.id, event.data);
		} else if (event.type === "permission.replied") {
			if (!sameId(event.data.sessionID, this.sessionId)) return;
			this.resolutions.set(
				event.data.requestID,
				`${this.permissions.get(event.data.requestID)?.action ?? "Tool approval"} · ${event.data.reply === "reject" ? "Denied" : "Approved"}`,
			);
			while (this.resolutions.size > 30)
				this.resolutions.delete(this.resolutions.keys().next().value!);
			this.permissions.delete(event.data.requestID);
			this.dismiss(event.data.requestID);
			const scopeId = `frm_scope_${event.data.requestID.replace(/^per_/, "")}`;
			this.forms.delete(scopeId);
			this.dismiss(scopeId);
		} else if (
			event.type === "form.replied" ||
			event.type === "form.cancelled"
		) {
			if (!sameId(event.data.sessionID, this.sessionId)) return;
			this.forms.delete(event.data.id);
			this.dismiss(event.data.id);
		} else return;
		this.revision++;
		this.render();
	}

	private dismiss(id: string): void {
		if (this.active?.id === id) this.active.controller.abort();
	}

	private render(): void {
		const lines: string[] = [];
		if (this.permissions.size)
			lines.push(
				`${this.permissions.size} approval${this.permissions.size === 1 ? "" : "s"} waiting · /leverage approvals`,
			);
		if (this.forms.size)
			lines.push(
				`${this.forms.size} question${this.forms.size === 1 ? "" : "s"} waiting · /leverage questions`,
			);
		this.ctx.ui.setWidget("leverage-pending", lines.length ? lines : undefined);
	}

	async show(kind: Interaction): Promise<void> {
		if (this.closed) return;
		if (!this.canWrite() && kind !== "approvals")
			throw new Error(
				"This session is read-only. Ask the owner for collaborator access.",
			);
		if (!this.ctx.hasUI)
			throw new Error(
				"Open Pi interactively to answer requests and choose session settings.",
			);
		if (this.active) {
			this.ctx.ui.notify("Close the current Leverage dialog first.", "info");
			return;
		}
		const active = {
			controller: new AbortController(),
			id: undefined as string | undefined,
		};
		this.active = active;
		const signal = AbortSignal.any([this.signal, active.controller.signal]);
		try {
			if (kind === "model") return await this.model(signal);
			if (kind === "inbox") return await this.inbox(signal);
			await this.refresh();
			if (signal.aborted) return;
			const items =
				kind === "approvals"
					? [...this.permissions.values()]
					: [...this.forms.values()];
			if (!items.length) {
				if (kind === "approvals" && this.resolutions.size)
					await choose(
						this.ctx,
						"Recent approval decisions",
						[...this.resolutions.values(), "Back"],
						{ signal },
					);
				else this.ctx.ui.notify(`No ${kind} are waiting.`, "info");
				return;
			}
			const labels = items.map(
				(one, index) =>
					`${index + 1}. ${"action" in one ? one.action : one.title} · ${one.id}`,
			);
			const picked =
				items.length === 1
					? labels[0]
					: await choose(this.ctx, `Leverage ${kind}`, labels, { signal });
			if (picked === undefined || signal.aborted) return;
			const item = items[labels.indexOf(picked)];
			if (!item) return;
			active.id = item.id;
			if ("action" in item) {
				const current = this.permissions.get(item.id);
				if (!current) return;
				await this.approval(current, signal);
			} else {
				const current = this.forms.get(item.id);
				if (!current) return;
				await this.question(current, signal);
			}
		} finally {
			if (this.active === active) this.active = undefined;
		}
	}

	private async approval(
		request: PermissionRequest,
		signal: AbortSignal,
	): Promise<void> {
		const detail = [
			request.action,
			request.message,
			...request.resources,
			request.metadata && JSON.stringify(request.metadata, null, 2),
		]
			.filter(Boolean)
			.join("\n");
		if (!this.canWrite()) {
			await choose(
				this.ctx,
				`${detail}\nRead-only · collaborator access is required to decide`,
				["Back"],
				{ signal },
			);
			return;
		}
		const picked = await choose(
			this.ctx,
			detail,
			[
				"Approve once",
				...(request.save?.length ? ["Approve and remember…"] : []),
				"Deny",
				"Leave pending",
			],
			{ signal },
		);
		if (
			picked === undefined ||
			picked === "Leave pending" ||
			signal.aborted ||
			!this.canWrite()
		)
			return;
		let reason: string | undefined;
		if (picked === "Deny") {
			reason = await input(this.ctx, "Reason for denial", "Optional reason", {
				signal,
			});
			if (reason === undefined || signal.aborted) return;
		}
		await this.api.decidePermission(
			this.sessionId,
			request.id,
			picked === "Approve once"
				? "once"
				: picked === "Deny"
					? "reject"
					: "always",
			reason,
			signal,
		);
		if (signal.aborted) return;
		await this.refresh();
		if (picked === "Approve and remember…" && !signal.aborted) {
			const form = this.forms.get(
				`frm_scope_${request.id.replace(/^per_/, "")}`,
			);
			if (form && this.active) {
				this.active.id = form.id;
				await this.question(form, signal);
			}
		}
	}

	private async question(
		form: SessionForm,
		signal: AbortSignal,
	): Promise<void> {
		const scope = form.id.startsWith("frm_scope_");
		const picked = await choose(
			this.ctx,
			form.title,
			["Answer", ...(!scope ? ["Cancel question"] : []), "Leave pending"],
			{ signal },
		);
		if (
			picked === undefined ||
			picked === "Leave pending" ||
			signal.aborted ||
			!this.canWrite()
		)
			return;
		if (picked === "Cancel question") {
			const confirmed = await confirm(
				this.ctx,
				"Cancel this question?",
				"The shared session receives no answers.",
				{ signal },
			);
			if (!confirmed || signal.aborted) return;
			await this.api.cancelForm(this.sessionId, form.id, signal);
		} else {
			const answer = await collectAnswers(this.ctx, form, signal);
			if (!answer || signal.aborted) return;
			const summary = Object.entries(answer)
				.map(
					([key, value]) =>
						`${form.fields.find((field) => field.key === key)?.title || key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`,
				)
				.join("\n");
			if (
				!(await confirm(
					this.ctx,
					"Send these answers?",
					summary || "No answers",
					{ signal },
				)) ||
				signal.aborted
			)
				return;
			await this.api.answerForm(this.sessionId, form.id, answer, signal);
		}
		if (!signal.aborted) await this.refresh();
	}

	private async model(signal: AbortSignal): Promise<void> {
		const models = (await this.api.models(signal)).filter(
			(model) => model.enabled && model.status !== "deprecated",
		);
		if (signal.aborted) return;
		if (!models.length) {
			this.ctx.ui.notify("No hosted models are available.", "warning");
			return;
		}
		const labels = models.map(
			(model, index) =>
				`${index + 1}. ${model.name} · ${model.providerID}/${model.id}`,
		);
		const picked = await choose(this.ctx, "Leverage session model", labels, {
			signal,
		});
		if (picked === undefined || signal.aborted) return;
		const model = models[labels.indexOf(picked)];
		if (!model) return;
		let variant: string | undefined;
		if (model.variants.length) {
			const variants = model.variants.map((one) => one.id);
			const chosen = await choose(
				this.ctx,
				"Reasoning effort",
				["Default", ...variants],
				{ signal },
			);
			if (chosen === undefined || signal.aborted) return;
			if (chosen !== "Default") variant = chosen;
		}
		await this.api.selectModel(
			this.sessionId,
			{
				providerID: model.providerID,
				id: model.id,
				...(variant ? { variant } : {}),
			},
			signal,
		);
		if (!signal.aborted)
			this.ctx.ui.notify(
				displayText(
					`Leverage model: ${model.name}${variant ? ` (${variant})` : ""}`,
				),
				"info",
			);
	}

	private async inbox(signal: AbortSignal): Promise<void> {
		while (!signal.aborted) {
			const items = await this.api.inbox(this.sessionId, signal);
			if (signal.aborted) return;
			if (!items.length) {
				this.ctx.ui.notify("No messages are waiting.", "info");
				return;
			}
			const labels = items.map(
				(item, index) =>
					`${index + 1}. ${item.delivery === "queue" ? "Queued" : "Sending"} · ${"text" in item.payload ? item.payload.text : item.type} · ${item.id}`,
			);
			const picked = await choose(
				this.ctx,
				"Leverage pending messages",
				[...labels, "Refresh"],
				{ signal },
			);
			if (picked === undefined || signal.aborted) return;
			if (picked === "Refresh") continue;
			const item = items[labels.indexOf(picked)];
			if (!item) return;
			if (item.delivery !== "queue") {
				this.ctx.ui.notify("This message is already on its way.", "info");
				continue;
			}
			const cancel = await confirm(
				this.ctx,
				"Cancel this queued message?",
				"text" in item.payload ? item.payload.text : item.type,
				{ signal },
			);
			if (!cancel || signal.aborted) return;
			await this.api.cancelInput(this.sessionId, item.id, signal);
		}
	}
}
