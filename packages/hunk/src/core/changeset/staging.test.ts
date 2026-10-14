import { describe, expect, test } from "bun:test";
import { changesetFromPatch } from "./fromPatch";
import { projectDiffFilesToReviewUnits } from "./reviewUnits";
import { containingPatchHunk, hunkStagingState, withStaging } from "./staging";

// HEAD to working tree: two hunks of file.txt plus a new file.
const reviewPatch = [
  "diff --git a/file.txt b/file.txt",
  "--- a/file.txt",
  "+++ b/file.txt",
  "@@ -1,7 +1,7 @@",
  " line 1",
  " line 2",
  "-line 3",
  "+line three",
  "-line 4",
  "+line four",
  " line 5",
  " line 6",
  " line 7",
  "@@ -14,7 +14,7 @@",
  " line 14",
  " line 15",
  " line 16",
  "-line 17",
  "+line seventeen",
  " line 18",
  " line 19",
  " line 20",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+new",
  "",
].join("\n");

/** Build a one-file zero-context patch from its hunk lines. */
function zeroContextPatch(path: string, hunkLines: string[]) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunkLines,
    "",
  ].join("\n");
}

function reviewFiles(stagedPatchText: string, unstagedPatchText: string) {
  const files = changesetFromPatch(reviewPatch, "review", "test", null).files;
  return withStaging(files, { stagedPatchText, unstagedPatchText });
}

describe("hunk staging state", () => {
  test("classifies each hunk by the side of the index its changes are on", () => {
    // Line 3 is staged, line 4 is not; line 17 is fully staged; new.txt is untracked.
    const [file, newFile] = reviewFiles(
      zeroContextPatch("file.txt", [
        "@@ -3 +3 @@",
        "-line 3",
        "+line three",
        "@@ -17 +17 @@",
        "-line 17",
        "+line seventeen",
      ]),
      zeroContextPatch("file.txt", ["@@ -4 +4 @@", "-line 4", "+line four"]),
    );

    expect(file!.metadata.hunks.map((hunk) => hunkStagingState(file!.staging!, hunk))).toEqual([
      "partly-staged",
      "staged",
    ]);
    expect(newFile!.staging).toEqual({ stagedOldSpans: [], unstagedNewSpans: [] });
    expect(hunkStagingState(newFile!.staging!, newFile!.metadata.hunks[0]!)).toBe("unstaged");
  });

  test("marks a staged new file through its empty old side", () => {
    const [, newFile] = reviewFiles(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+new",
        "",
      ].join("\n"),
      "",
    );

    expect(hunkStagingState(newFile!.staging!, newFile!.metadata.hunks[0]!)).toBe("staged");
  });

  test("resolves a line review unit to the hunk it was split from", () => {
    const [file] = reviewFiles("", "");
    const [lineFile] = projectDiffFilesToReviewUnits([file!], "line");
    const units = lineFile!.metadata.hunks;

    expect(units.length).toBeGreaterThan(file!.metadata.hunks.length);
    for (const unit of units) {
      const hunk = containingPatchHunk(file!, unit);
      expect(file!.metadata.hunks).toContain(hunk);
      expect(hunk.additionStart <= unit.additionStart).toBe(true);
    }
    expect(containingPatchHunk(file!, units.at(-1)!)).toBe(file!.metadata.hunks[1]!);
  });
});
