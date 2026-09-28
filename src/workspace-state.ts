import type { WorkspaceClient } from "./workspace-api";
import { nativeId } from "./workspace-api";
import type {
	SessionInput,
	Viewer,
	WorkspaceEvent,
	WorkspaceMember,
	WorkspaceSession,
} from "./workspace-schema";
import type { WorkspaceSocket } from "./workspace-socket";

export class SharedSession {
	session?: WorkspaceSession;
	canWrite = false;
	revoked = false;
	version = -1;
	connection = "connecting";
	readonly messages = new Map<string, SessionInput>();
	readonly viewers = new Map<string, Viewer>();
	readonly typing = new Map<string, string>();
	members: WorkspaceMember[] = [];
	private socket?: WorkspaceSocket;
	private readonly lifetime = new AbortController();
	private disposals: Array<() => void> = [];
	private refreshing?: Promise<void>;
	private refreshAgain = false;
	private typingTimer?: ReturnType<typeof setTimeout>;
	private idleTimer?: ReturnType<typeof setTimeout>;
	private typingAt = 0;
	constructor(
		readonly api: WorkspaceClient,
		readonly id: string,
		private readonly changed: () => void,
		private readonly failed: (error: unknown) => void,
		private readonly denied: () => void,
	) {}
	get userId(): string | undefined {
		return this.socket?.userId;
	}
	async start(signal: AbortSignal): Promise<void> {
		signal.addEventListener("abort", () => this.close(), { once: true });
		if (signal.aborted) {
			this.close();
			return;
		}
		this.socket = await this.api.socket(this.lifetime.signal);
		this.disposals.push(
			this.socket.onEvent((event) => this.apply(event)),
			this.socket.onState((state) => {
				this.connection = state;
				if (state !== "live") {
					this.viewers.clear();
					this.typing.clear();
				} else void this.refresh().catch(this.failed);
				this.changed();
			}),
		);
		await Promise.all([this.socket.connect(), this.refresh()]);
		if (this.lifetime.signal.aborted) return;
		const poll = setInterval(() => {
			void this.refresh().catch(this.failed);
		}, 15_000);
		this.disposals.push(() => clearInterval(poll));
		this.touch(false);
	}
	refresh(): Promise<void> {
		if (this.lifetime.signal.aborted || this.revoked) return Promise.resolve();
		if (this.refreshing) {
			this.refreshAgain = true;
			return this.refreshing;
		}
		this.refreshing = (async () => {
			do {
				this.refreshAgain = false;
				try {
					const [snapshot, members] = await Promise.all([
						this.api.bootstrap(this.id, this.lifetime.signal),
						this.api.members(this.lifetime.signal),
					]);
					if (this.lifetime.signal.aborted || this.revoked) return;
					this.canWrite = snapshot.viewerCanWrite;
					this.members = members;
					if (snapshot.version >= this.version) {
						this.session = snapshot.session;
						this.version = snapshot.version;
						for (const message of snapshot.messages)
							this.messages.set(message.uuid, message);
					}
					this.trim();
					this.socket?.subscribe(
						nativeId(this.id),
						snapshot.lastCursorIncluded,
					);
					this.changed();
				} catch (error) {
					if (this.lifetime.signal.aborted) return;
					if (
						error &&
						typeof error === "object" &&
						"status" in error &&
						(error.status === 403 || error.status === 404)
					) {
						this.revoke();
						return;
					}
					throw error;
				}
			} while (this.refreshAgain);
		})().finally(() => {
			this.refreshing = undefined;
		});
		return this.refreshing;
	}
	apply(event: WorkspaceEvent): void {
		if (
			!("sessionId" in event) ||
			event.sessionId !== nativeId(this.id) ||
			this.revoked ||
			this.lifetime.signal.aborted
		)
			return;
		if (
			event.type === "session.messages.updated" &&
			event.version >= this.version
		) {
			this.version = event.version;
			for (const message of event.messages)
				this.messages.set(message.uuid, message);
			this.trim();
		} else if (event.type === "session.presence.snapshot") {
			this.viewers.clear();
			for (const viewer of event.viewers)
				this.viewers.set(viewer.userId, viewer);
		} else if (event.type === "session.presence.update") {
			if (event.active)
				this.viewers.set(event.viewer.userId, {
					...event.viewer,
					state: event.state,
				});
			else this.viewers.delete(event.viewer.userId);
		} else if (event.type === "session.typing.snapshot") {
			this.typing.clear();
			for (const user of event.users)
				this.typing.set(user.userId, user.userName);
		} else if (event.type === "session.typing.update") {
			if (event.active) this.typing.set(event.userId, event.userName);
			else this.typing.delete(event.userId);
		} else if (event.type === "session.access_revoked") this.revoke();
		else if (
			event.type === "session.updated" ||
			event.type === "session.list.changed"
		)
			void this.refresh().catch(this.failed);
		this.changed();
	}
	touch(typing: boolean): void {
		if (this.revoked || this.lifetime.signal.aborted) return;
		this.socket?.sendIfOpen({
			type: "session.presence.set",
			sessionId: nativeId(this.id),
			state: "active",
		});
		clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(
			() =>
				this.socket?.sendIfOpen({
					type: "session.presence.set",
					sessionId: nativeId(this.id),
					state: "idle",
				}),
			60_000,
		);
		clearTimeout(this.typingTimer);
		if (typing && this.canWrite && Date.now() - this.typingAt > 2500) {
			this.typingAt = Date.now();
			this.socket?.sendIfOpen({
				type: "session.typing.start",
				sessionId: nativeId(this.id),
			});
		}
		if (!typing && this.typingAt) {
			this.typingAt = 0;
			this.socket?.sendIfOpen({
				type: "session.typing.stop",
				sessionId: nativeId(this.id),
			});
		} else if (typing)
			this.typingTimer = setTimeout(
				() =>
					this.socket?.sendIfOpen({
						type: "session.typing.stop",
						sessionId: nativeId(this.id),
					}),
				4000,
			);
	}
	private trim(): void {
		while (this.messages.size > 1000)
			this.messages.delete(this.messages.keys().next().value!);
	}
	private revoke(): void {
		this.revoked = true;
		this.canWrite = false;
		this.messages.clear();
		this.viewers.clear();
		this.typing.clear();
		this.close();
		this.denied();
	}
	close(): void {
		this.lifetime.abort();
		clearTimeout(this.typingTimer);
		clearTimeout(this.idleTimer);
		for (const dispose of this.disposals.splice(0)) dispose();
		this.socket?.sendIfOpen({
			type: "session.typing.stop",
			sessionId: nativeId(this.id),
		});
		this.socket?.unsubscribe(nativeId(this.id));
	}
}
