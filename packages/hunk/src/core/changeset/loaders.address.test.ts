import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { collapseHomePath, createReviewFileStore } from "../process/reviewFileStore";
import { diffHunkIdentity, diffHunkLines } from "./hunkDecisions";
import { loadAppBootstrap } from "./loaders";

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A repository directory holding `a.txt` as edited, and a review file rejecting its second hunk. */
function createRepo() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "hunk-address-")));
  tempDirs.push(repo);
  const reviewFile = join(repo, "review.jsonl");
  const file = createTestDiffFile({ after: AFTER, before: BEFORE, context: 2, path: "a.txt" });
  const store = createReviewFileStore(reviewFile);
  file.metadata.hunks.forEach((hunk, index) => {
    store.setHunkDecision({
      hunk: {
        id: diffHunkIdentity(file, hunk),
        repo: collapseHomePath(repo),
        path: "a.txt",
        oldStart: hunk.deletionStart,
        newStart: hunk.additionStart,
        lines: diffHunkLines(file, hunk),
      },
      state: index === 1 ? "rejected" : "accepted",
    });
  });
  return { repo, reviewFile, file };
}

describe("hunk address", () => {
  test("rebuilds a review of the repo's rejected hunks with relocated lines", async () => {
    const { repo, reviewFile, file } = createRepo();
    writeFileSync(join(repo, "a.txt"), `intro\nintro\n${AFTER}`);

    const bootstrap = await loadAppBootstrap({
      kind: "address",
      repo,
      options: { reviewFile },
    });

    expect(bootstrap.reloadContext.repoRoot).toBe(repo);
    expect(bootstrap.changeset.sourceLabel).toBe(repo);
    expect(bootstrap.changeset.files).toHaveLength(1);
    const [loaded] = bootstrap.changeset.files;
    expect(loaded?.path).toBe("a.txt");
    expect(loaded?.metadata.hunks).toHaveLength(1);
    expect(diffHunkIdentity(loaded!, loaded!.metadata.hunks[0]!)).toBe(
      diffHunkIdentity(file, file.metadata.hunks[1]!),
    );
    expect(loaded?.metadata.hunks[0]?.additionStart).toBe(
      file.metadata.hunks[1]!.additionStart + 2,
    );
  });

  test("refuses to run without a review file, and reports an empty repo", async () => {
    const { repo, reviewFile } = createRepo();

    await expect(
      loadAppBootstrap({ kind: "address", repo, options: {} }),
    ).rejects.toThrow(/review_file/);
    await expect(
      loadAppBootstrap({ kind: "address", repo: join(repo, "other"), options: { reviewFile } }),
    ).rejects.toThrow(/Nothing to address/);
  });
});
