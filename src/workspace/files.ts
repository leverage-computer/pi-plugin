import { existsSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chooseDrawer, type DrawerItem, textDrawer } from "../drawers";
import { workspace } from "./api";
import type {
  Channel,
  Connector,
  FileEntry,
  FileResource,
  FileSources,
} from "./schema";

// Folders a person browses. Caches and runtime content are the machine's own.
const BROWSABLE = new Set([
  "task_workspace",
  "channel",
  "repo_checkout",
  "workspace",
  "user_home",
]);

function placeName(resource: FileResource, channels: Channel[]): string {
  switch (resource.kind) {
    case "task_workspace":
      return "Outputs";
    case "channel":
      return `#${channels.find((one) => one.id === resource.channelId)?.name ?? "channel"}`;
    case "repo_checkout":
      return `${resource.repositoryName ?? "Repository"}${resource.branch ? ` / ${resource.branch}` : ""}`;
    case "workspace":
      return "Workspace files";
    case "user_home":
      return "Your files";
    default:
      return resource.kind;
  }
}

function size(bytes: number | null | undefined): string {
  if (typeof bytes !== "number") {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// A name in the folder Pi runs in that no file has yet.
function freeName(folder: string, name: string): string {
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = join(folder, name);
  for (let n = 2; existsSync(candidate); n++) {
    candidate = join(folder, `${stem} (${n})${extension}`);
  }
  return candidate;
}

type Place = { sessionId: string; resource: FileResource };

async function download(
  ctx: ExtensionContext,
  place: Place,
  entry: FileEntry,
  signal: AbortSignal,
): Promise<void> {
  const { data } = await workspace.downloadFile(
    place.sessionId,
    { resourceId: place.resource.resourceId, path: entry.path },
    signal,
  );
  const saved = freeName(ctx.cwd, basename(entry.name));
  writeFileSync(saved, data);
  ctx.ui.notify(`Saved ${saved}`, "info");
}

async function show(
  ctx: ExtensionContext,
  place: Place,
  entry: FileEntry,
  signal: AbortSignal,
): Promise<void> {
  const file = await workspace.readFile(
    place.sessionId,
    { resourceId: place.resource.resourceId, path: entry.path },
    signal,
  );
  const reason = file.tooLarge
    ? "This file is too large to show here."
    : file.isBinary || typeof file.content !== "string"
      ? "This file is not text."
      : undefined;
  if (reason) {
    const picked = await chooseDrawer(ctx, {
      title: `${file.path}\n${reason}`,
      items: [{ value: "download", label: "Download to this folder" }],
      signal,
    });
    if (picked === "download") {
      await download(ctx, place, entry, signal);
    }
    return;
  }
  await textDrawer(ctx, {
    title: file.path,
    read: () => file.content ?? "",
    signal,
  });
}

// One folder at a time. Enter opens, Tab downloads, Escape goes back.
async function browse(
  ctx: ExtensionContext,
  place: Place,
  signal: AbortSignal,
  title: string,
): Promise<void> {
  let path = "";
  while (!signal.aborted) {
    const entries: FileEntry[] = [];
    let pageToken: string | undefined;
    do {
      const tree = await workspace.fileTree(
        place.sessionId,
        { resourceId: place.resource.resourceId, path, pageToken },
        signal,
      );
      entries.push(...tree.entries);
      pageToken = tree.nextPageToken ?? undefined;
    } while (pageToken && entries.length < 2000);
    const sorted = entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === "dir"
          ? -1
          : 1,
    );
    const items: DrawerItem[] = [
      ...(path ? [{ value: "..", label: ".." }] : []),
      ...sorted.map((entry) => ({
        value: entry.path,
        label: entry.type === "dir" ? `${entry.name}/` : entry.name,
        detail: size(entry.size),
      })),
    ];
    const picked = await chooseDrawer(ctx, {
      title: path ? `${title} / ${path}` : title,
      items,
      signal,
      more: "download",
    });
    if (picked === undefined) {
      return;
    }
    if (picked === "..") {
      path = path.split("/").slice(0, -1).join("/");
      continue;
    }
    const wanted = picked.replace(/^more:/, "");
    const entry = entries.find((one) => one.path === wanted);
    if (!entry) {
      continue;
    }
    if (entry.type === "dir") {
      path = entry.path;
      continue;
    }
    if (picked.startsWith("more:")) {
      await download(ctx, place, entry, signal);
    } else {
      await show(ctx, place, entry, signal);
    }
  }
}

async function search(
  ctx: ExtensionContext,
  place: Place,
  signal: AbortSignal,
): Promise<void> {
  const query = await ctx.ui.input(
    "Find a file by name",
    "At least 2 letters",
    {
      signal,
    },
  );
  if (!query || query.trim().length < 2) {
    return;
  }
  const found = await workspace.searchFiles(
    place.sessionId,
    { resourceId: place.resource.resourceId, query: query.trim() },
    signal,
  );
  const picked = await chooseDrawer(ctx, {
    title: `Files named like "${query.trim()}"`,
    subtitle: found.truncated ? "Showing the first matches." : "",
    items: found.entries.map((entry) => ({
      value: entry.path,
      label: entry.path,
      detail: size(entry.size),
    })),
    signal,
    more: "download",
  });
  const entry = found.entries.find(
    (one) => one.path === picked?.replace(/^more:/, ""),
  );
  if (!entry) {
    return;
  }
  if (picked?.startsWith("more:")) {
    await download(ctx, place, entry, signal);
  } else {
    await show(ctx, place, entry, signal);
  }
}

/**
 * The session's files, as the web app's files panel shows them: outputs,
 * channel folders, repositories and home. Reading one may wake the sandbox.
 */
export async function filesDrawer(
  ctx: ExtensionContext,
  sessionId: string,
  signal: AbortSignal,
  start?: "outputs",
): Promise<void> {
  const [{ resources }, channels] = await Promise.all([
    workspace.fileResources(sessionId, signal),
    workspace.channels(signal),
  ]);
  const places = resources.filter((one) => BROWSABLE.has(one.kind));
  if (start === "outputs") {
    const outputs = places.find((one) => one.kind === "task_workspace");
    if (!outputs) {
      throw new Error("This session has no outputs yet.");
    }
    await browse(ctx, { sessionId, resource: outputs }, signal, "Outputs");
    return;
  }
  const home = places.find((one) => one.isWorkingRoot) ?? places[0];
  while (!signal.aborted) {
    const picked = await chooseDrawer(ctx, {
      title: "Session files",
      items: [
        ...(home ? [{ value: "search", label: "Find a file by name" }] : []),
        ...places.map((one) => ({
          value: one.resourceId,
          label: placeName(one, channels),
          detail: one.mountPath,
        })),
      ],
      signal,
    });
    if (picked === undefined) {
      return;
    }
    if (picked === "search" && home) {
      await search(ctx, { sessionId, resource: home }, signal);
      continue;
    }
    const resource = places.find((one) => one.resourceId === picked);
    if (resource) {
      await browse(
        ctx,
        { sessionId, resource },
        signal,
        placeName(resource, channels),
      );
    }
  }
}

/** What the session changed in each source, with branches and pull requests. */
export function describeChanges(sources: FileSources): string {
  const blocks = sources.sources.map((source) => {
    const pull = source.publication;
    return [
      [
        source.label,
        source.branch ? `branch ${source.branch}` : "",
        source.unpublished
          ? `${source.unpublished} unpublished commit${source.unpublished === 1 ? "" : "s"}`
          : "",
        source.sourceOutOfDate ? "behind its base" : "",
      ]
        .filter(Boolean)
        .join(" · "),
      ...(pull
        ? [
            `Pull request #${pull.number} (${pull.draft ? "draft, " : ""}${pull.state}): ${pull.url}`,
          ]
        : []),
      ...(source.error ? [`Could not check: ${source.error}`] : []),
      ...(source.changes.length
        ? source.changes.flatMap((change) => [
            `  ${change.state.padEnd(9)} ${change.oldPath ? `${change.oldPath} → ` : ""}${change.path}${
              typeof change.additions === "number"
                ? `  +${change.additions} -${change.deletions ?? 0}`
                : ""
            }`,
            ...(change.patch
              ? change.patch.split("\n").map((line) => `      ${line}`)
              : []),
          ])
        : ["  No changes"]),
    ].join("\n");
  });
  return [
    ...(sources.working
      ? ["The agent is still working. This may change."]
      : []),
    ...(blocks.length ? blocks : ["This session has no files yet."]),
  ].join("\n\n");
}

/** The workspace's connections to other apps, and whether each works. */
export function describeConnectors(connectors: Connector[]): string {
  if (!connectors.length) {
    return "This workspace has no connections yet. Add them in Leverage Settings.";
  }
  return connectors
    .map((one) =>
      [
        `${one.label || one.namespace}${one.disabled ? " (off)" : ""}`,
        [
          one.scope === "user" ? "yours" : "workspace",
          one.runtimeStatus.replace(/_/g, " "),
          typeof one.catalogToolCount === "number"
            ? `${one.catalogToolCount} tools`
            : "",
        ]
          .filter(Boolean)
          .join(" · "),
        ...(one.description ? [one.description] : []),
      ].join("\n  "),
    )
    .join("\n\n");
}
