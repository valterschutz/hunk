import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { buildDiffFile } from "./diffFile";
import type { DiffFile } from "./model";
import { diffHunkIdentity, fileReviewStatus, filterHunksByState } from "./hunkDecisions";

const HUNK_ONE = `@@ -1,6 +1,6 @@
 line 1
 line 2
-line 3
+line 3 changed
 line 4
 line 5
 line 6
`;
const HUNK_TWO = `@@ -12,7 +12,8 @@ ctx
 line 12
 line 13
 line 14
-line 15
+line 15 changed
+line 15b
 line 16
 line 17
 line 18
`;
const HUNK_THREE = `@@ -25,6 +26,5 @@
 line 25
 line 26
 line 27
-line 28
 line 29
 line 30
`;

/** Parse one git patch for `path` into the file model the app reviews. */
function fileFromHunks(hunks: string[], path = "f.txt"): DiffFile {
  const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.join("")}`;
  const metadata = parsePatchFiles(patch, "patch", true)[0]?.files[0];
  if (!metadata) throw new Error("patch did not parse");
  return buildDiffFile(metadata, patch, 0, "test", null);
}

/** The geometry a renderer reads from one hunk, without the array indices that change with the line arrays. */
function geometry(hunk: DiffFile["metadata"]["hunks"][number]) {
  const {
    collapsedBefore,
    splitLineStart,
    splitLineCount,
    unifiedLineStart,
    unifiedLineCount,
    additionStart,
    additionCount,
    deletionStart,
    deletionCount,
  } = hunk;
  return {
    collapsedBefore,
    splitLineStart,
    splitLineCount,
    unifiedLineStart,
    unifiedLineCount,
    additionStart,
    additionCount,
    deletionStart,
    deletionCount,
  };
}

describe("diffHunkIdentity", () => {
  test("ignores line numbers but not content, kind, or path", () => {
    const original = fileFromHunks([HUNK_ONE, HUNK_TWO]);
    const shifted = fileFromHunks([HUNK_TWO.replace("@@ -12,7 +12,8 @@", "@@ -40,7 +41,8 @@")]);
    const edited = fileFromHunks([HUNK_TWO.replace("line 15b", "line 15c")]);
    const contextBecameAddition = fileFromHunks([
      HUNK_TWO.replace(" line 16", "+line 16").replace("-12,7", "-12,6"),
    ]);
    const otherPath = fileFromHunks([HUNK_TWO], "g.txt");

    const identity = diffHunkIdentity(original, original.metadata.hunks[1]!);
    expect(identity).toMatch(/^[0-9a-f]{32}$/);
    expect(diffHunkIdentity(shifted, shifted.metadata.hunks[0]!)).toBe(identity);
    expect(diffHunkIdentity(edited, edited.metadata.hunks[0]!)).not.toBe(identity);
    expect(
      diffHunkIdentity(contextBecameAddition, contextBecameAddition.metadata.hunks[0]!),
    ).not.toBe(identity);
    expect(diffHunkIdentity(otherPath, otherPath.metadata.hunks[0]!)).not.toBe(identity);
  });

  test("agrees between a patch parse and a full-content parse of the same change", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 15\n", "line 15 changed\nline 15b\n");
    const fromContents = createTestDiffFile({ after, before, context: 3, path: "f.txt" });
    const fromPatch = fileFromHunks([HUNK_TWO]);

    expect(diffHunkIdentity(fromContents, fromContents.metadata.hunks[0]!)).toBe(
      diffHunkIdentity(fromPatch, fromPatch.metadata.hunks[0]!),
    );
  });
});

describe("fileReviewStatus", () => {
  test("approves a file only when every hunk is accepted or fixed", () => {
    const file = fileFromHunks([HUNK_ONE, HUNK_TWO]);
    const [first, second] = file.metadata.hunks.map((hunk) => diffHunkIdentity(file, hunk));

    expect(fileReviewStatus(file, new Map([[first!, "accepted"]]))).toBeUndefined();
    expect(
      fileReviewStatus(
        file,
        new Map([
          [first!, "accepted"],
          [second!, "rejected"],
        ]),
      ),
    ).toBeUndefined();
    expect(
      fileReviewStatus(
        file,
        new Map([
          [first!, "accepted"],
          [second!, "fixed"],
        ]),
      ),
    ).toBe("approved");
  });

  test("does not approve a file with no reviewable hunks", () => {
    expect(fileReviewStatus(fileFromHunks([]), new Map())).toBeUndefined();
  });
});

const UNDECIDED = new Set(["undecided"] as const);

describe("filterHunksByState", () => {
  test("returns the same file object and every hunk identity when nothing is decided", () => {
    const file = fileFromHunks([HUNK_ONE, HUNK_TWO, HUNK_THREE]);

    const projection = filterHunksByState([file], new Map(), UNDECIDED);

    expect(projection.files[0]).toBe(file);
    expect(projection.hiddenHunkCount).toBe(0);
    expect(projection.hunkIdentitiesByFileId.get(file.id)).toEqual(
      file.metadata.hunks.map((hunk) => diffHunkIdentity(file, hunk)),
    );
  });

  test("lays the kept hunks out as Pierre would have parsed them alone", () => {
    const file = fileFromHunks([HUNK_ONE, HUNK_TWO, HUNK_THREE]);
    const expected = fileFromHunks([HUNK_ONE, HUNK_THREE]);
    const hidden = diffHunkIdentity(file, file.metadata.hunks[1]!);

    const projection = filterHunksByState([file], new Map([[hidden, "accepted"]]), UNDECIDED);
    const [kept] = projection.files;

    expect(projection.hiddenHunkCount).toBe(1);
    expect(kept).not.toBe(file);
    expect(kept?.id).toBe(file.id);
    expect(kept?.metadata.hunks.map(geometry)).toEqual(expected.metadata.hunks.map(geometry));
    expect(kept?.metadata.splitLineCount).toBe(expected.metadata.splitLineCount);
    expect(kept?.metadata.unifiedLineCount).toBe(expected.metadata.unifiedLineCount);
    expect(kept?.stats).toEqual(expected.stats);
    expect(kept?.metadata.cacheKey).not.toBe(file.metadata.cacheKey);
    // The line arrays stay whole, so the kept hunks still index into them correctly.
    expect(kept?.metadata.additionLines).toBe(file.metadata.additionLines);
    expect(projection.hunkIdentitiesByFileId.get(file.id)).toEqual([
      diffHunkIdentity(file, file.metadata.hunks[0]!),
      diffHunkIdentity(file, file.metadata.hunks[2]!),
    ]);
  });

  test("keeps rows the parser counted after the last hunk", () => {
    const before = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before
      .replace("line 3\n", "line 3 changed\n")
      .replace("line 15\n", "line 15 changed\n");
    const file = createTestDiffFile({ after, before, context: 2, path: "f.txt" });
    const expected = createTestDiffFile({
      after: before.replace("line 15\n", "line 15 changed\n"),
      before,
      context: 2,
      path: "f.txt",
    });
    const hidden = diffHunkIdentity(file, file.metadata.hunks[0]!);

    const [kept] = filterHunksByState([file], new Map([[hidden, "accepted"]]), UNDECIDED).files;

    expect(kept?.metadata.hunks.map(geometry)).toEqual(expected.metadata.hunks.map(geometry));
    expect(kept?.metadata.splitLineCount).toBe(expected.metadata.splitLineCount);
    expect(kept?.metadata.unifiedLineCount).toBe(expected.metadata.unifiedLineCount);
  });

  test("drops a file whose every hunk is decided and keeps the rest in order", () => {
    const first = fileFromHunks([HUNK_ONE], "a.txt");
    const second = fileFromHunks([HUNK_ONE, HUNK_TWO], "b.txt");
    const third = fileFromHunks([HUNK_THREE], "c.txt");
    const decided = new Map<string, "accepted" | "rejected">([
      [diffHunkIdentity(second, second.metadata.hunks[0]!), "accepted"],
      [diffHunkIdentity(second, second.metadata.hunks[1]!), "rejected"],
      [diffHunkIdentity(third, third.metadata.hunks[0]!), "accepted"],
    ]);

    const projection = filterHunksByState([first, second, third], decided, UNDECIDED);

    expect(projection.files.map((file) => file.path)).toEqual(["a.txt"]);
    expect(projection.hiddenHunkCount).toBe(3);
    expect([...projection.hunkIdentitiesByFileId.keys()]).toEqual([first.id]);
  });

  test("shows exactly the hunks whose state is shown", () => {
    const file = fileFromHunks([HUNK_ONE, HUNK_TWO, HUNK_THREE]);
    const [one, two, three] = file.metadata.hunks.map((hunk) => diffHunkIdentity(file, hunk));
    const decisions = new Map<string, "accepted" | "rejected">([
      [one!, "accepted"],
      [two!, "rejected"],
    ]);

    const rejected = filterHunksByState([file], decisions, new Set(["rejected"] as const));
    expect(rejected.hunkIdentitiesByFileId.get(file.id)).toEqual([two!]);
    expect(rejected.hiddenHunkCount).toBe(2);

    const open = filterHunksByState([file], decisions, new Set(["undecided", "rejected"] as const));
    expect(open.hunkIdentitiesByFileId.get(file.id)).toEqual([two!, three!]);

    expect(filterHunksByState([file], decisions, new Set()).files).toEqual([]);
  });

  test("passes a file without hunks through untouched", () => {
    const file = fileFromHunks([]);

    const projection = filterHunksByState([file], new Map([["anything", "accepted"]]), UNDECIDED);

    expect(projection.files[0]).toBe(file);
    expect(projection.hunkIdentitiesByFileId.get(file.id)).toEqual([]);
  });
});
