import type { WorkspaceClient } from "./api";
import { nativeId } from "./api";
import type {
	SessionInput,
	WorkspaceEvent,
	WorkspaceMember,
	WorkspaceSession,
} from "./schema";
import type { WorkspaceSocket } from "./socket";

export class SharedSession {
	session?: WorkspaceSession;
	canWrite = false;
	revoked = false;
	version = -1;
	readonly messages = new Map<string, SessionInput>();
	members: WorkspaceMember[] = [];
	private socket?: WorkspaceSocket;
	private readonly lifetime = new AbortController();
	private disposals: Array<() => void> = [];
	private refreshing?: Promise<void>;
	private refreshAgain = false;
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
				if (state === "live") void this.refresh().catch(this.failed);
				this.changed();
			}),
		);
		await Promise.all([this.socket.connect(), this.refresh()]);
		if (this.lifetime.signal.aborted) return;
		const poll = setInterval(() => {
			void this.refresh().catch(this.failed);
		}, 15_000);
		this.disposals.push(() => clearInterval(poll));
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
		} else if (event.type === "session.access_revoked") this.revoke();
		else if (
			event.type === "session.updated" ||
			event.type === "session.list.changed"
		)
			void this.refresh().catch(this.failed);
		this.changed();
	}
	private trim(): void {
		while (this.messages.size > 1000)
			this.messages.delete(this.messages.keys().next().value!);
	}
	private revoke(): void {
		this.revoked = true;
		this.canWrite = false;
		this.messages.clear();
		this.close();
		this.denied();
	}
	close(): void {
		this.lifetime.abort();
		for (const dispose of this.disposals.splice(0)) dispose();
		this.socket?.unsubscribe(nativeId(this.id));
	}
}
