import { describe, expect, test } from "bun:test";
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";
import { splitHunksAtChangeGroups } from "./changeGroups";
import { buildDiffFile } from "./diffFile";
import { formatHunkHeader } from "./hunkHeader";
import { hunkRows } from "./hunkLayout";

/** Parse `before` → `after` the way Git would with `context` lines around each change. */
function metadataFromTexts(before: string, after: string, context = 3): FileDiffMetadata {
  return parseDiffFromFile(
    { cacheKey: "before", contents: before, name: "f.txt" },
    { cacheKey: "after", contents: after, name: "f.txt" },
    { context },
    true,
  );
}

/** Parse one git patch for `path` into its file metadata. */
function metadataFromPatch(patchBody: string, path = "f.txt"): FileDiffMetadata {
  const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${patchBody}`;
  const metadata = parsePatchFiles(patch, "patch", true)[0]?.files[0];
  if (!metadata) {
    throw new Error("patch did not parse");
  }
  return metadata;
}

function headers(metadata: FileDiffMetadata) {
  return metadata.hunks.map((hunk) => formatHunkHeader(hunk).trim());
}

function lines(text: string) {
  return text.split("\n").slice(0, -1);
}

/** Pierre keeps each parsed line's newline; drop it so lines compare by text. */
function lineText(line: string | undefined) {
  return line?.replace(/\r?\n$/, "");
}

/**
 * Check that every hunk's line numbers, line indices, and block walk agree with the
 * texts they claim to describe: each context line must appear at its number on both
 * sides, each changed line at its number on its side.
 */
function expectHunksToAddressTexts(metadata: FileDiffMetadata, before: string, after: string) {
  const oldLines = lines(before);
  const newLines = lines(after);
  for (const hunk of metadata.hunks) {
    let oldNumber = hunk.deletionStart;
    let newNumber = hunk.additionStart;
    expect(hunk.hunkContent[0]?.additionLineIndex).toBe(hunk.additionLineIndex);
    expect(hunk.hunkContent[0]?.deletionLineIndex).toBe(hunk.deletionLineIndex);
    for (const block of hunk.hunkContent) {
      if (block.type === "context") {
        for (let offset = 0; offset < block.lines; offset += 1) {
          const text = lineText(metadata.additionLines[block.additionLineIndex + offset]);
          expect(text).toBe(lineText(metadata.deletionLines[block.deletionLineIndex + offset]));
          expect(text).toBe(newLines[newNumber + offset - 1]);
          expect(text).toBe(oldLines[oldNumber + offset - 1]);
        }
        oldNumber += block.lines;
        newNumber += block.lines;
        continue;
      }
      for (let offset = 0; offset < block.deletions; offset += 1) {
        expect(lineText(metadata.deletionLines[block.deletionLineIndex + offset])).toBe(
          oldLines[oldNumber + offset - 1],
        );
      }
      for (let offset = 0; offset < block.additions; offset += 1) {
        expect(lineText(metadata.additionLines[block.additionLineIndex + offset])).toBe(
          newLines[newNumber + offset - 1],
        );
      }
      oldNumber += block.deletions;
      newNumber += block.additions;
    }
    expect(oldNumber - hunk.deletionStart).toBe(hunk.deletionCount);
    expect(newNumber - hunk.additionStart).toBe(hunk.additionCount);
  }
}

const NUMBERED = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

/** Return the numbered file with `edits` applied, keyed by 1-based line number. */
function edited(edits: Record<number, string | null>) {
  return `${NUMBERED.flatMap((line, index) => {
    const edit = edits[index + 1];
    return edit === undefined ? [line] : edit === null ? [] : [edit];
  }).join("\n")}\n`;
}

describe("splitHunksAtChangeGroups", () => {
  test("returns the same metadata when every hunk is already one change group", () => {
    const metadata = metadataFromTexts(edited({}), edited({ 5: "changed 5", 20: "changed 20" }));
    expect(metadata.hunks).toHaveLength(2);
    expect(splitHunksAtChangeGroups(metadata)).toBe(metadata);
  });

  test("splits a git hunk with several edits into one hunk per edit", () => {
    const before = edited({});
    const after = edited({
      10: "changed 10",
      13: "changed 13",
      25: "changed 25",
      27: "changed 27",
    });
    const metadata = metadataFromTexts(before, after);
    expect(headers(metadata)).toEqual(["@@ -7,10 +7,10 @@", "@@ -22,9 +22,9 @@"]);

    const split = splitHunksAtChangeGroups(metadata);

    expect(headers(split)).toEqual([
      "@@ -7,5 +7,5 @@",
      "@@ -12,5 +12,5 @@",
      "@@ -22,4 +22,4 @@",
      "@@ -26,5 +26,5 @@",
    ]);
    expect(split.hunks.map((hunk) => hunk.collapsedBefore)).toEqual([6, 0, 5, 0]);
    expectHunksToAddressTexts(split, before, after);
  });

  test("shares the context between two edits, later edit taking the larger half", () => {
    // Parsed from whole files, so line indices are absolute: line 7 is index 6.
    const before = edited({});
    const after = edited({ 10: "changed 10", 14: "changed 14" });
    const split = splitHunksAtChangeGroups(metadataFromTexts(before, after));

    expect(split.hunks.map((hunk) => hunk.hunkContent)).toEqual([
      [
        { type: "context", lines: 3, additionLineIndex: 6, deletionLineIndex: 6 },
        { type: "change", additions: 1, deletions: 1, additionLineIndex: 9, deletionLineIndex: 9 },
        { type: "context", lines: 1, additionLineIndex: 10, deletionLineIndex: 10 },
      ],
      [
        { type: "context", lines: 2, additionLineIndex: 11, deletionLineIndex: 11 },
        {
          type: "change",
          additions: 1,
          deletions: 1,
          additionLineIndex: 13,
          deletionLineIndex: 13,
        },
        { type: "context", lines: 3, additionLineIndex: 14, deletionLineIndex: 14 },
      ],
    ]);
    expectHunksToAddressTexts(split, before, after);
  });

  test("keeps the file's row totals and lays later hunks out consistently", () => {
    const metadata = metadataFromTexts(
      edited({}),
      edited({ 3: "changed 3", 5: "changed 5", 20: "changed 20", 22: null, 23: null }),
    );
    const split = splitHunksAtChangeGroups(metadata);

    expect(split.hunks).toHaveLength(4);
    expect(split.splitLineCount).toBe(metadata.splitLineCount);
    expect(split.unifiedLineCount).toBe(metadata.unifiedLineCount);
    expect(hunkRows(split.hunks, "splitLineCount")).toBe(
      hunkRows(metadata.hunks, "splitLineCount"),
    );
    expect(hunkRows(split.hunks, "unifiedLineCount")).toBe(
      hunkRows(metadata.hunks, "unifiedLineCount"),
    );
    for (const [index, hunk] of split.hunks.entries()) {
      const previous = split.hunks[index - 1];
      const expectedSplitStart = previous
        ? previous.splitLineStart + previous.splitLineCount + hunk.collapsedBefore
        : hunk.collapsedBefore;
      const expectedUnifiedStart = previous
        ? previous.unifiedLineStart + previous.unifiedLineCount + hunk.collapsedBefore
        : hunk.collapsedBefore;
      expect(hunk.splitLineStart).toBe(expectedSplitStart);
      expect(hunk.unifiedLineStart).toBe(expectedUnifiedStart);
    }
  });

  test("names the line before a group that has no lines on one side, as git does", () => {
    const before = "alpha\nbeta\n";
    const after = "inserted\nalpha\nalso inserted\nbeta\n";
    const metadata = metadataFromTexts(before, after);
    expect(headers(metadata)).toEqual(["@@ -1,2 +1,4 @@"]);

    const split = splitHunksAtChangeGroups(metadata);

    expect(headers(split)).toEqual(["@@ -0,0 +1,1 @@", "@@ -1,2 +2,3 @@"]);
    expect(split.hunks.map((hunk) => hunk.collapsedBefore)).toEqual([0, 0]);
    expectHunksToAddressTexts(split, before, after);
  });

  test("keeps the header context on the first group and end-of-file markers on the last", () => {
    const metadata = metadataFromPatch(
      [
        "@@ -1,5 +1,5 @@ fn main",
        " a",
        "-b",
        "+B",
        " c",
        "-d",
        "+D",
        " e",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(metadata.hunks[0]?.noEOFCRAdditions).toBe(true);

    const split = splitHunksAtChangeGroups(metadata);

    expect(headers(split)).toEqual(["@@ -1,2 +1,2 @@ fn main", "@@ -3,3 +3,3 @@"]);
    expect(split.hunks.map((hunk) => hunk.hunkSpecs)).toEqual([undefined, undefined]);
    expect(split.hunks.map((hunk) => hunk.noEOFCRAdditions)).toEqual([false, true]);
    expect(split.hunks.map((hunk) => hunk.noEOFCRDeletions)).toEqual([false, true]);
    expect(split.hunks.map((hunk) => [hunk.additionLines, hunk.deletionLines])).toEqual([
      [1, 1],
      [1, 1],
    ]);
  });

  test("buildDiffFile reviews change groups as hunks without changing the file stats", () => {
    const metadata = metadataFromPatch(
      ["@@ -1,7 +1,8 @@", " a", "-b", "+B", " c", " d", " e", "+extra", " f", " g", ""].join("\n"),
    );
    const file = buildDiffFile(metadata, "", 0, "test", null);

    expect(file.metadata.hunks).toHaveLength(2);
    expect(headers(file.metadata)).toEqual(["@@ -1,3 +1,3 @@", "@@ -4,4 +4,5 @@"]);
    expect(file.stats).toEqual({ additions: 2, deletions: 1 });
  });
});
