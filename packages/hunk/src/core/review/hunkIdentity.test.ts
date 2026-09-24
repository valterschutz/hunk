import { describe, expect, test } from "bun:test";
import { createTestDiffFile, lines } from "../../../../../test/helpers/diff-helpers";
import { diffHunkIdentity, diffHunkLines } from "../changeset/hunkDecisions";
import { projectReviewDocument } from "./document";
import { isHunkIdentity, reviewHunkIdentity, reviewHunkLines } from "./hunkIdentity";

const BEFORE = lines(...Array.from({ length: 20 }, (_, index) => `line ${index + 1}`));
const AFTER = BEFORE.replace("line 3\n", "first change\n").replace("line 15\n", "second change\n");

describe("reviewHunkIdentity", () => {
  test("agrees between the rendered file model and the projected review document", () => {
    const file = createTestDiffFile({ after: AFTER, before: BEFORE, context: 2, path: "a.txt" });
    const [reviewFile] = projectReviewDocument([file], { sourceLabel: "repo" }).files;

    expect(reviewFile?.hunks).toHaveLength(2);
    reviewFile?.hunks.forEach((hunk, index) => {
      const rendered = file.metadata.hunks[index]!;
      expect(reviewHunkIdentity(reviewFile, hunk)).toBe(diffHunkIdentity(file, rendered));
      expect(reviewHunkLines(reviewFile, hunk)).toEqual(diffHunkLines(file, rendered));
    });
  });

  test("renders every line with its kind, in display order", () => {
    const file = createTestDiffFile({ after: AFTER, before: BEFORE, context: 1, path: "a.txt" });
    const [reviewFile] = projectReviewDocument([file]).files;

    expect(reviewHunkLines(reviewFile!, reviewFile!.hunks[0]!)).toEqual([
      " line 2",
      "-line 3",
      "+first change",
      " line 4",
    ]);
    expect(isHunkIdentity(reviewHunkIdentity(reviewFile!, reviewFile!.hunks[0]!))).toBe(true);
    expect(isHunkIdentity("not-an-identity")).toBe(false);
  });
});
