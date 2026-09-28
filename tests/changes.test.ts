import { afterEach, expect, test } from "bun:test";
import { numberedDiff, reviewChanges, textDiff } from "../src/changes";
import { SESSION, workspaceFixture } from "./workspace-fixture";

const fixtures: ReturnType<typeof workspaceFixture>[] = [];
afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.close();
});

test("combines saved and live edits, preserving deletions, renames and binary status", async () => {
	const f = workspaceFixture((request) => {
		const url = new URL(request.url);
		if (url.pathname.endsWith("/file-sources"))
			return Response.json({
				sources: [
					{
						id: "source",
						resourceId: "repo",
						kind: "repository",
						label: "Project",
						mountPath: "/work/project",
						candidateCommit: "saved",
						baseCommit: "base",
						checkedAt: new Date().toISOString(),
						changes: [
							{
								path: "app.ts",
								state: "modified",
								patch: "stale patch",
								additions: 1,
								deletions: 1,
							},
						],
						updates: [],
					},
				],
				working: false,
			});
		if (url.pathname.endsWith("/live-file-status"))
			return Response.json({
				available: true,
				files: [
					{ path: "/work/project/app.ts", state: "modified" },
					{
						path: "/work/project/new.ts",
						oldPath: "/work/project/old.ts",
						state: "renamed",
					},
					{ path: "/work/project/gone.ts", state: "deleted" },
					{ path: "/work/project/image.png", state: "modified" },
					{ path: "/work/project/same.ts", state: "modified" },
				],
			});
		if (url.pathname.endsWith("/files/read")) {
			const path = url.searchParams.get("path");
			const commit = url.searchParams.get("commit");
			return Response.json({
				content:
					path === "app.ts"
						? commit
							? "keep\nold\n"
							: "keep\nnew\nextra\n"
						: "same\n",
				isBinary: path === "image.png",
				tooLarge: false,
				encoding: "utf-8",
			});
		}
	});
	fixtures.push(f);
	const review = await reviewChanges(
		f.client(),
		SESSION,
		new AbortController().signal,
		true,
	);
	expect(review.files.map((f) => f.path)).toEqual([
		"app.ts",
		"gone.ts",
		"image.png",
		"new.ts",
	]);
	expect(review.files[0]).toMatchObject({ additions: 2, deletions: 1 });
	expect(review.files[0].patch).toContain("-old");
	expect(review.files[0].patch).toContain("+extra");
	expect(review.files[1]).toMatchObject({ additions: 0, deletions: 1 });
	expect(review.files[2].unavailable).toContain("binary");
	expect(review.files[3].oldPath).toBe("old.ts");
	expect(f.requests.filter((r) => r.path.endsWith("/files/read"))).toHaveLength(
		9,
	);
});

test("unavailable live files are distinct from an unchanged workspace", async () => {
	const f = workspaceFixture((request) =>
		new URL(request.url).pathname.endsWith("/live-file-status")
			? Response.json({ available: false, files: [] })
			: undefined,
	);
	fixtures.push(f);
	const result = await reviewChanges(
		f.client(),
		SESSION,
		new AbortController().signal,
		true,
	);
	expect(result.note).toContain("unavailable");
	expect(result.files).toEqual([]);
	const diff = textDiff("empty.txt", "", "first\n");
	expect(diff.additions).toBe(1);
	expect(diff.deletions).toBe(0);
	expect(diff.patch).toContain("+first");
});

test("numbers diff lines from each hunk's own position in the old and new file", () => {
	const before = Array.from({ length: 20 }, (_, n) => `line ${n + 1}`);
	const after = [...before];
	after[1] = "second";
	after.splice(15, 1);
	const { patch = "" } = textDiff(
		"notes.txt",
		`${before.join("\n")}\n`,
		`${after.join("\n")}\n`,
	);
	const numbered = numberedDiff(patch).split("\n");
	expect(numbered).toContain("- 2 line 2");
	expect(numbered).toContain("+ 2 second");
	expect(numbered).toContain("  5 line 5");
	expect(numbered).toContain("    ...");
	expect(numbered).toContain("-16 line 16");
	expect(numbered).toContain(" 16 line 17");
	expect(numberedDiff("not a patch")).toBe("");
});
