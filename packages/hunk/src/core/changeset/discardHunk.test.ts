import { describe, expect, test } from "bun:test";
import { parsePatchFiles } from "@pierre/diffs";
import { createTwoFilesPatch } from "diff";
import { buildDiffFile } from "./diffFile";
import { buildSelectedHunkPatch } from "./discardHunk";

/** Parse one text change through the same patch path as a loaded VCS review. */
function fileFromTexts(before: string, after: string) {
  const patch = createTwoFilesPatch("sample.txt", "sample.txt", before, after, "", "", {
    context: 3,
  });
  const metadata = parsePatchFiles(patch, "patch", true)[0]?.files[0];
  if (!metadata) throw new Error("test patch did not parse");
  return buildDiffFile(metadata, patch, 0, "test", null);
}

const numberedLines = (count: number) =>
  `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")}\n`;

describe("buildSelectedHunkPatch", () => {
  test("emits only the selected edit when Git grouped nearby edits into one hunk", () => {
    const before = numberedLines(14);
    const after = before.replace("line 4\n", "line four\n").replace("line 9\n", "line nine\n");
    const file = fileFromTexts(before, after);

    expect(file.metadata.hunks).toHaveLength(2);
    expect(buildSelectedHunkPatch(file, file.metadata.hunks[1]!)).toContain(
      "@@ -7,6 +7,6 @@\n line 7\n line 8\n-line 9\n+line nine\n line 10\n line 11\n line 12\n",
    );
    expect(buildSelectedHunkPatch(file, file.metadata.hunks[1]!)).not.toContain("line four");
  });

  test("targets renamed-file content without reversing the rename", () => {
    const patch = [
      "diff --git a/before.txt b/after.txt",
      "similarity index 50%",
      "rename from before.txt",
      "rename to after.txt",
      "index 1111111..2222222 100644",
      "--- a/before.txt",
      "+++ b/after.txt",
      "@@ -1 +1 @@",
      "-before",
      "+after",
      "",
    ].join("\n");
    const metadata = parsePatchFiles(patch, "patch", true)[0]?.files[0];
    if (!metadata) throw new Error("test rename patch did not parse");
    const file = buildDiffFile(metadata, patch, 0, "test", null);

    expect(buildSelectedHunkPatch(file, file.metadata.hunks[0]!)).toBe(
      [
        "index 1111111..2222222 100644",
        "--- b/after.txt",
        "+++ b/after.txt",
        "@@ -1 +1 @@",
        "-before",
        "+after",
        "",
      ].join("\n"),
    );
  });

  test("preserves missing-final-newline markers on the selected hunk", () => {
    const file = fileFromTexts("before", "after");

    expect(buildSelectedHunkPatch(file, file.metadata.hunks[0]!)).toEndWith(
      "@@ -1,1 +1,1 @@\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n",
    );
  });
});
