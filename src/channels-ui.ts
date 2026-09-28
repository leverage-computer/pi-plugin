import { randomUUID } from "node:crypto";
import {
	CustomEditor,
	type ExtensionContext,
	getMarkdownTheme,
	getSelectListTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { chooseDrawer, clean, keyHints } from "./drawers";
import type { WorkspaceClient } from "./workspace-api";
import type {
	Channel,
	ChannelMessage,
	WorkspaceMember,
} from "./workspace-schema";
import { sessionsDrawer, visibilityName } from "./workspace-ui";

export class ChannelConversation {
	readonly messages = new Map<string, ChannelMessage>();
	revision = 0;
	before?: number | null;
	hasOlder = false;
	draft = "";
	// Browse mode returns to this message after older messages load.
	browsing?: string;
	failed?: { id: string; text: string };
	merge(messages: ChannelMessage[]): void {
		this.revision++;
		for (const message of messages) this.messages.set(message.id, message);
		while (this.messages.size > 500)
			this.messages.delete(this.messages.keys().next().value!);
	}
	reconcile(
		messages: ChannelMessage[],
		complete = false,
		revision = this.revision,
	): void {
		if (revision !== this.revision) return;
		const ids = new Set(messages.map((one) => one.id));
		const oldest = messages.map((one) => one.createdAt).sort()[0];
		for (const [id, message] of this.messages)
			if (!ids.has(id) && (complete || (oldest && message.createdAt >= oldest)))
				this.messages.delete(id);
		this.merge(messages);
	}
	remove(id: string): void {
		this.revision++;
		this.messages.delete(id);
	}
	entries(): ChannelMessage[] {
		return [...this.messages.values()].sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		);
	}
	async send(
		api: WorkspaceClient,
		channelId: string,
		signal: AbortSignal,
		parentMessageId?: string,
	): Promise<void> {
		const text = this.draft.trim();
		if (!text) return;
		if (this.failed && this.failed.text !== text)
			throw new Error(
				"The previous send is unconfirmed. Retry its original text first.",
			);
		this.failed ??= { id: randomUUID(), text };
		await api.sendMessage(
			channelId,
			text,
			this.failed.id,
			signal,
			parentMessageId,
		);
		this.failed = undefined;
		this.draft = "";
	}
}

type ChannelAction =
	| { type: "back" | "sessions" | "older" | "revoked" }
	| { type: "message"; message: ChannelMessage };
export type ChannelDestination =
	| { sessionId: string }
	| { newInChannel: string };

export async function channelScreen(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	channel: Channel,
	conversation: ChannelConversation,
	members: WorkspaceMember[],
	parentSignal: AbortSignal,
	threadId?: string,
): Promise<ChannelAction> {
	const lifetime = new AbortController();
	const signal = AbortSignal.any([parentSignal, lifetime.signal]);
	const socket = await api.socket(signal);
	await socket.connect();
	return ctx.ui.custom<ChannelAction>((tui, theme, keys, done) => {
		const editor = new CustomEditor(
			tui,
			{
				borderColor: (value) => theme.fg("border", value),
				selectList: getSelectListTheme(),
			},
			keys,
		);
		editor.setText(conversation.draft);
		let browse = conversation.browsing !== undefined;
		let selected = browse
			? Math.max(
					0,
					conversation
						.entries()
						.findIndex((one) => one.id === conversation.browsing),
				)
			: Math.max(0, conversation.entries().length - 1);
		conversation.browsing = undefined;
		editor.focused = !browse;
		let sending = false;
		let error = "";
		let refreshing = false;
		let typingAt = 0;
		let typingTimer: ReturnType<typeof setTimeout> | undefined;
		const typing = new Map<string, string>();
		const stopTyping = () =>
			socket.sendIfOpen({
				type: "typing.stop",
				channelId: channel.id,
				parentMessageId: threadId,
			});
		const refresh = async () => {
			if (refreshing || signal.aborted) return;
			refreshing = true;
			const revision = conversation.revision;
			try {
				if (threadId)
					conversation.reconcile(
						await api.thread(channel.id, threadId, signal),
						true,
						revision,
					);
				else {
					const page = await api.timeline(channel.id, undefined, signal);
					conversation.reconcile(page.messages, !page.hasMoreOlder, revision);
					if (conversation.before === undefined) {
						conversation.before = page.nextBeforeSeq;
						conversation.hasOlder = page.hasMoreOlder;
					}
				}
				if (!browse) selected = Math.max(0, conversation.entries().length - 1);
				const newest = Math.max(
					0,
					...conversation.entries().map((one) => one.topLevelSeq ?? 0),
				);
				if (!threadId && newest) await api.markRead(channel.id, newest, signal);
				error = "";
			} catch (cause) {
				if (
					cause &&
					typeof cause === "object" &&
					"status" in cause &&
					(cause.status === 403 || cause.status === 404)
				) {
					conversation.messages.clear();
					ctx.ui.notify("Channel access was removed.", "warning");
					done({ type: "revoked" });
				}
				if (!signal.aborted)
					error =
						cause instanceof Error ? cause.message : "Channel refresh failed";
			} finally {
				refreshing = false;
				tui.requestRender();
			}
		};
		const unlisten = socket.onEvent((event) => {
			if (
				event.type === "message.created" &&
				event.message.channelId === channel.id
			) {
				if ((event.message.parentMessageId ?? undefined) === threadId)
					conversation.merge([event.message]);
				void refresh();
			} else if (
				event.type === "message.content.updated" &&
				event.channelId === channel.id
			) {
				const message = conversation.messages.get(event.messageId);
				if (message)
					conversation.merge([{ ...message, content: event.content }]);
			} else if (
				event.type === "message.deleted" &&
				event.channelId === channel.id
			)
				conversation.remove(event.messageId);
			else if (
				event.type === "message.delta" &&
				event.channelId === channel.id
			) {
				const message = conversation.messages.get(event.messageId);
				if (
					message &&
					(event.offset === undefined ||
						event.offset === message.content.length)
				)
					conversation.merge([
						{ ...message, content: message.content + event.delta },
					]);
			} else if (
				event.type === "typing.update" &&
				event.channelId === channel.id &&
				(event.parentMessageId ?? undefined) === threadId &&
				event.userId !== socket.userId
			) {
				if (event.active) typing.set(event.userId, event.userName);
				else typing.delete(event.userId);
			}
			if (!browse) selected = Math.max(0, conversation.entries().length - 1);
			tui.requestRender();
		});
		const unstate = socket.onState((state) => {
			if (state === "live") void refresh();
			else typing.clear();
			tui.requestRender();
		});
		const timer = setInterval(() => {
			void refresh();
		}, 15_000);
		const abort = () => done({ type: "back" });
		signal.addEventListener("abort", abort, { once: true });
		editor.onChange = (text) => {
			conversation.draft = text;
			clearTimeout(typingTimer);
			if (text && Date.now() - typingAt > 2500) {
				typingAt = Date.now();
				socket.sendIfOpen({
					type: "typing.start",
					channelId: channel.id,
					parentMessageId: threadId,
				});
			}
			typingTimer = setTimeout(stopTyping, 4000);
		};
		editor.onSubmit = (text) => {
			conversation.draft = text;
			editor.setText(text);
			if (sending || !text.trim()) return;
			sending = true;
			stopTyping();
			void conversation
				.send(api, channel.id, signal, threadId)
				.then(() => {
					editor.setText("");
					return refresh();
				})
				.catch((cause: unknown) => {
					error = cause instanceof Error ? cause.message : "Send failed";
				})
				.finally(() => {
					sending = false;
					tui.requestRender();
				});
		};
		void refresh();
		return {
			focused: true,
			render(width) {
				const messages = conversation.entries();
				selected = Math.max(0, Math.min(selected, messages.length - 1));
				const editorLines = editor.render(width);
				const available = Math.max(
					4,
					(process.stdout.rows || 30) - editorLines.length - 8,
				);
				let lines: string[] = [];
				for (
					let index = browse
						? Math.max(0, selected - 2)
						: Math.max(0, messages.length - 30);
					index < (browse ? selected + 1 : messages.length);
					index++
				) {
					const message = messages[index];
					const active = browse && index === selected;
					const name = clean(
						members.find((one) => one.id === message.authorId)?.name ??
							message.authorName ??
							(message.authorId === null ? "Leverage" : "Unknown member"),
					);
					const replies = message.threadSummary?.replyCount ?? 0;
					const author = truncateToWidth(
						`${active ? theme.fg("accent", "› ") : ""}${theme.bold(
							theme.fg(
								message.authorId === socket.userId ? "accent" : "text",
								name,
							),
						)}${theme.fg(
							"dim",
							`  ${new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
						)}${
							message.harness === "codex" || message.harness === "claude"
								? theme.fg(
										"muted",
										` · Sent from ${message.harness === "codex" ? "Codex" : "Claude"}`,
									)
								: ""
						}${
							replies
								? theme.fg(
										"accent",
										` · ${replies === 1 ? "1 reply" : `${replies} replies`}`,
									)
								: ""
						}`,
						width,
						"…",
						true,
					);
					lines.push(
						"",
						active ? theme.bg("selectedBg", author) : author,
						...new Markdown(
							clean(message.content),
							active ? 2 : 0,
							0,
							getMarkdownTheme(),
						).render(width),
						...(message.attachments ?? []).map((attachment) =>
							theme.fg("muted", clean(`▸ ${attachment.filename}`)),
						),
					);
				}
				lines = lines.slice(-available);
				const title = `${theme.bold(theme.fg("accent", clean(`#${channel.name ?? "channel"}`)))}${threadId ? theme.fg("muted", " / Thread") : ""}`;
				const state = theme.fg(
					socket.status === "live" ? "success" : "warning",
					`● ${socket.status}`,
				);
				const names = [...typing.values()].map(clean);
				return [
					truncateToWidth(
						`${title}${" ".repeat(Math.max(2, width - visibleWidth(title) - visibleWidth(state)))}${state}`,
						width,
					),
					theme.fg("borderMuted", "─".repeat(width)),
					...lines,
					"",
					truncateToWidth(
						names.length
							? theme.italic(
									theme.fg(
										"muted",
										`${names.join(", ")} ${names.length === 1 ? "is" : "are"} typing…`,
									),
								)
							: "",
						width,
					),
					...(error
						? new Text(theme.fg("error", clean(error)), 0, 0)
								.render(width)
								.slice(0, 2)
						: []),
					...editorLines,
					truncateToWidth(
						[
							sending ? theme.fg("muted", "Sending…") : "",
							conversation.failed
								? theme.fg("warning", "Unconfirmed send · Enter retries")
								: "",
							keyHints(
								theme,
								browse
									? [
											["↑↓", "move"],
											...(selected === 0 && conversation.hasOlder && !threadId
												? ([["↑", "older"]] as Array<[string, string]>)
												: []),
											["Enter", "open"],
											["Tab", "compose"],
											["Esc", "back"],
										]
									: [
											["Enter", "send"],
											["Tab", "browse"],
											["F6", "sessions"],
											["Esc", "back"],
										],
							),
						]
							.filter(Boolean)
							.join("   "),
						width,
					),
				];
			},
			handleInput(data) {
				if (matchesKey(data, "escape")) return done({ type: "back" });
				if (matchesKey(data, "f6")) return done({ type: "sessions" });
				if (matchesKey(data, "tab")) {
					browse = !browse;
					editor.focused = !browse;
				} else if (browse) {
					if (
						matchesKey(data, "up") &&
						selected === 0 &&
						conversation.hasOlder &&
						!threadId
					) {
						conversation.browsing = conversation.entries()[0]?.id;
						return done({ type: "older" });
					}
					if (matchesKey(data, "up")) selected = Math.max(0, selected - 1);
					if (matchesKey(data, "down"))
						selected = Math.min(
							conversation.entries().length - 1,
							selected + 1,
						);
					if (matchesKey(data, "enter")) {
						const message = conversation.entries()[selected];
						if (message) return done({ type: "message", message });
					}
				} else if (!(sending && matchesKey(data, "enter")))
					editor.handleInput(data);
				tui.requestRender();
			},
			invalidate() {
				editor.invalidate();
			},
			dispose() {
				conversation.draft = editor.getText();
				clearInterval(timer);
				clearTimeout(typingTimer);
				stopTyping();
				unlisten();
				unstate();
				signal.removeEventListener("abort", abort);
				lifetime.abort();
			},
		};
	});
}

export async function channelsDrawer(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	signal: AbortSignal,
	conversations: Map<string, ChannelConversation>,
): Promise<ChannelDestination | undefined> {
	while (!signal.aborted) {
		const [channels, states, members] = await Promise.all([
			api.channels(signal),
			api.readStates(signal),
			api.members(signal),
		]);
		const unread = (id: string) =>
			states.find((one) => one.channelId === id)?.unreadCount ?? 0;
		const picked = await chooseDrawer(
			ctx,
			"Leverage channels",
			channels.map((channel) => ({
				value: channel.id,
				label: `#${channel.name ?? "channel"}`,
				detail: [
					unread(channel.id) ? `${unread(channel.id)} unread` : "",
					visibilityName(channel.visibility ?? channel.kind ?? "channel"),
				]
					.filter(Boolean)
					.join(" · "),
			})),
			signal,
		);
		const channel = channels.find((one) => one.id === picked);
		if (!channel) return;
		let threadId: string | undefined;
		while (!signal.aborted) {
			const key = `${channel.id}:${threadId ?? ""}`;
			if (!conversations.has(key))
				conversations.set(key, new ChannelConversation());
			const conversation = conversations.get(key)!;
			const action = await channelScreen(
				api,
				ctx,
				channel,
				conversation,
				members,
				signal,
				threadId,
			);
			if (action.type === "revoked") {
				for (const [key, saved] of conversations)
					if (key.startsWith(`${channel.id}:`)) saved.messages.clear();
				break;
			}
			if (action.type === "back") {
				if (threadId) {
					threadId = undefined;
					continue;
				}
				break;
			}
			if (action.type === "older") {
				if (!threadId && conversation.hasOlder) {
					const page = await api.timeline(
						channel.id,
						conversation.before,
						signal,
					);
					conversation.merge(page.messages);
					conversation.before = page.nextBeforeSeq;
					conversation.hasOlder = page.hasMoreOlder;
				}
				continue;
			}
			if (action.type === "sessions") {
				const selected = await sessionsDrawer(api, ctx, signal, channel.id);
				if (selected === "new") return { newInChannel: channel.id };
				if (selected) return { sessionId: selected };
			}
			if (action.type === "message") {
				const selected = await chooseDrawer(
					ctx,
					"Message",
					[
						{ value: "thread", label: "Open thread / reply" },
						...(action.message.sessionId
							? [{ value: "session", label: "Open agent session" }]
							: []),
					],
					signal,
				);
				if (selected === "thread")
					threadId = action.message.parentMessageId ?? action.message.id;
				else if (selected === "session" && action.message.sessionId)
					return { sessionId: action.message.sessionId };
			}
		}
	}
}
