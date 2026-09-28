import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createTwoFilesPatch, diffLines, parsePatch } from "diff";
import { chooseDrawer, textDrawer } from "./drawers";
import type { WorkspaceClient } from "./workspace-api";
import type { FileChange, FileSource } from "./workspace-schema";

export interface ReviewedFile extends FileChange {
	sourceId: string;
	sourceLabel: string;
	unavailable?: string;
}
export function textDiff(
	path: string,
	before: string,
	after: string,
): Pick<FileChange, "patch" | "additions" | "deletions"> {
	const lines = diffLines(before, after);
	return {
		patch: createTwoFilesPatch(
			`a/${path}`,
			`b/${path}`,
			before,
			after,
			undefined,
			undefined,
			{ context: 3 },
		),
		additions: lines.reduce((n, line) => n + (line.added ? line.count : 0), 0),
		deletions: lines.reduce(
			(n, line) => n + (line.removed ? line.count : 0),
			0,
		),
	};
}
function savedFiles(sources: FileSource[]): ReviewedFile[] {
	return sources.flatMap((source) => {
		const changes = new Map(
			(source.publicationComparison?.changes ?? []).map((file) => [
				file.path,
				file,
			]),
		);
		for (const file of source.changes) changes.set(file.path, file);
		return [...changes.values()].map((file) => {
			let additions = file.additions;
			let deletions = file.deletions;
			if (file.patch && (additions === undefined || deletions === undefined)) {
				try {
					const lines = parsePatch(file.patch).flatMap((patch) =>
						patch.hunks.flatMap((hunk) => hunk.lines),
					);
					additions = lines.filter((line) => line.startsWith("+")).length;
					deletions = lines.filter((line) => line.startsWith("-")).length;
				} catch {
					/* Keep unknown counts when the patch cannot be read. */
				}
			}
			return {
				...file,
				additions,
				deletions,
				sourceId: source.resourceId,
				sourceLabel: source.label,
			};
		});
	});
}
export async function reviewChanges(
	api: WorkspaceClient,
	sessionId: string,
	signal: AbortSignal,
	wake = false,
): Promise<{ files: ReviewedFile[]; sources: FileSource[]; note: string }> {
	const snapshot = await api.sources(sessionId, signal);
	const sources = snapshot.sources;
	const files = new Map(
		savedFiles(sources).map((file) => [`${file.sourceId}:${file.path}`, file]),
	);
	let note =
		snapshot.error ??
		sources
			.filter((source) => source.error || !source.checkedAt)
			.map((source) => `${source.label}: ${source.error ?? "Checking files…"}`)
			.join("\n");
	const live = await api
		.liveFiles(sessionId, signal, wake)
		.catch((error: unknown) => {
			if (signal.aborted) throw error;
			note += `\nLive changes unavailable: ${error instanceof Error ? error.message : "request failed"}`;
			return undefined;
		});
	if (live && !live.available)
		note += "\nLive files are unavailable; showing saved changes.";
	for (const file of live?.available ? live.files : []) {
		signal.throwIfAborted();
		const source = sources
			.filter(
				(one) =>
					file.path === one.mountPath ||
					file.path.startsWith(`${one.mountPath}/`),
			)
			.sort((a, b) => b.mountPath.length - a.mountPath.length)[0];
		if (!source) {
			files.set(file.path, {
				...file,
				sourceId: "",
				sourceLabel: "Working files",
				unavailable: "The source for this file is unavailable.",
			});
			continue;
		}
		const relative = (path: string) => path.replace(`${source.mountPath}/`, "");
		const path = relative(file.path);
		const key = `${source.resourceId}:${path}`;
		const saved = files.get(key);
		const change: ReviewedFile = {
			...file,
			path,
			oldPath: file.oldPath ? relative(file.oldPath) : saved?.oldPath,
			sourceId: source.resourceId,
			sourceLabel: source.label,
		};
		files.set(key, change);
		if (!wake) {
			change.patch = saved?.patch;
			continue;
		}
		const commit = saved ? source.baseCommit : source.candidateCommit;
		if (!commit) {
			change.unavailable = "No baseline is available for this file.";
			continue;
		}
		try {
			const before =
				(file.state === "added" && !saved) || saved?.state === "added"
					? ""
					: await api.file(
							sessionId,
							change.oldPath ?? path,
							source.resourceId,
							commit,
							signal,
						);
			const after =
				file.state === "deleted"
					? ""
					: await api.file(
							sessionId,
							path,
							source.resourceId,
							undefined,
							signal,
						);
			const text = (
				value: Awaited<ReturnType<WorkspaceClient["file"]>> | string,
			) =>
				typeof value === "string"
					? value
					: !value.isBinary && !value.tooLarge && value.encoding === "utf-8"
						? value.content
						: undefined;
			const oldText = text(before);
			const newText = text(after);
			if (oldText === undefined || newText === undefined)
				change.unavailable =
					"No text diff: this file is binary, too large, or unreadable.";
			else if (oldText === newText && file.state !== "renamed")
				files.delete(key);
			else Object.assign(change, textDiff(path, oldText, newText));
		} catch (error) {
			if (signal.aborted) throw error;
			change.unavailable =
				error instanceof Error ? error.message : "Could not load this diff.";
		}
	}
	return {
		files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		sources,
		note: note.trim(),
	};
}

export async function changesDrawer(
	api: WorkspaceClient,
	ctx: ExtensionContext,
	sessionId: string,
	signal: AbortSignal,
	changed: (count: number, note: string) => void,
): Promise<void> {
	const lifetime = new AbortController();
	const active = AbortSignal.any([signal, lifetime.signal]);
	let review = await reviewChanges(api, sessionId, active, true);
	changed(review.files.length, review.note);
	let loading = false;
	let error = "";
	const refresh = async () => {
		if (loading || active.aborted) return;
		loading = true;
		try {
			review = await reviewChanges(api, sessionId, active, true);
			changed(review.files.length, review.note);
			error = "";
		} catch (cause) {
			if (!active.aborted)
				error = cause instanceof Error ? cause.message : "Refresh failed";
		} finally {
			loading = false;
		}
	};
	const timer = setInterval(() => {
		void refresh();
	}, 6000);
	try {
		while (!active.aborted) {
			const picked = await chooseDrawer(
				ctx,
				"Session changes",
				() => [
					{
						value: "refresh",
						label: loading ? "Refreshing…" : "Refresh changes",
					},
					...(error || review.note
						? [
								{
									value: "status",
									label: error ? "Refresh failed" : "File status",
									detail: error || review.note,
								},
							]
						: []),
					...review.files.map((file) => ({
						value: `${file.sourceId}:${file.path}`,
						label: file.oldPath ? `${file.oldPath} → ${file.path}` : file.path,
						detail: `${file.state} · ${file.additions === undefined ? "?" : `+${file.additions}`} ${file.deletions === undefined ? "?" : `−${file.deletions}`} · ${file.sourceLabel}`,
					})),
					...(!review.files.length
						? [
								{
									value: "empty",
									label: review.note
										? "File status is incomplete"
										: "No saved changes",
									disabled: true,
								},
							]
						: []),
				],
				active,
			);
			if (!picked) return;
			if (picked === "refresh") {
				await refresh();
				continue;
			}
			await textDrawer(
				ctx,
				picked === "status"
					? "File status"
					: picked.split(":").slice(1).join(":"),
				() => {
					if (picked === "status") return error || review.note;
					const file = review.files.find(
						(one) => `${one.sourceId}:${one.path}` === picked,
					);
					return file
						? `${file.sourceLabel} · ${file.state}\n\n${file.unavailable ?? file.patch ?? "No text diff is available for this file."}`
						: "This file no longer has changes.";
				},
				active,
			);
		}
	} finally {
		lifetime.abort();
		clearInterval(timer);
	}
}
