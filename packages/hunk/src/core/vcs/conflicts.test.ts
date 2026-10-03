import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildConflictPatch,
  buildConflictedDiffFile,
  conflictResolutionLines,
  parseConflictRegions,
  resolveConflictRegion,
  splitFileLines,
} from "./conflicts";

const MERGE_STYLE = [
  "a",
  "<<<<<<< HEAD",
  "MAIN",
  "=======",
  "FEAT",
  ">>>>>>> ac674f9 (feat)",
  "c",
].join("\n");

const DIFF3_STYLE = [
  "a",
  "<<<<<<< HEAD",
  "MAIN",
  "||||||| parent of ac674f9 (feat)",
  "b",
  "=======",
  "FEAT",
  ">>>>>>> ac674f9 (feat)",
  "c",
].join("\n");

describe("parseConflictRegions", () => {
  test("reads merge-style markers into ours and theirs", () => {
    const regions = parseConflictRegions(MERGE_STYLE.split("\n"));
    expect(regions).toEqual([
      {
        markerStart: 1,
        markerEnd: 5,
        ours: ["MAIN"],
        theirs: ["FEAT"],
        oursLabel: "HEAD",
        theirsLabel: "ac674f9 (feat)",
      },
    ]);
  });

  test("reads diff3-style markers with a base section", () => {
    const regions = parseConflictRegions(DIFF3_STYLE.split("\n"));
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({ markerStart: 1, markerEnd: 7, base: ["b"] });
  });

  test("treats an opening marker that never closes as content", () => {
    expect(parseConflictRegions(["<<<<<<< HEAD", "x", "=======", "y"])).toEqual([]);
  });

  test("ignores a separator outside any region, such as a Markdown underline", () => {
    expect(parseConflictRegions(["Title", "=======", "body"])).toEqual([]);
  });

  test("keeps empty sides empty", () => {
    const regions = parseConflictRegions(["<<<<<<< ours", "=======", "added", ">>>>>>> theirs"]);
    expect(regions[0]).toMatchObject({ ours: [], theirs: ["added"] });
  });
});

describe("buildConflictPatch", () => {
  test("shows one hunk per region with ours removed and theirs added", () => {
    const file = splitFileLines(`${MERGE_STYLE}\n`);
    const { patchText, regions } = buildConflictPatch(
      "f.txt",
      file,
      parseConflictRegions(file.lines),
      {
        ours: "HEAD",
        theirs: "feat",
      },
    );
    expect(patchText).toBe(
      [
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,3 +1,3 @@ conflict 1/1: HEAD | feat",
        " a",
        "-MAIN",
        "+FEAT",
        " c",
        "",
      ].join("\n"),
    );
    expect(regions[0]?.hunkIndex).toBe(0);
  });

  test("shares the context between two nearby regions and keeps line numbers per side", () => {
    const text = [
      "1",
      "<<<<<<< HEAD",
      "ours-a",
      "ours-b",
      "=======",
      "theirs-a",
      ">>>>>>> feat",
      "2",
      "3",
      "4",
      "<<<<<<< HEAD",
      "=======",
      "theirs-c",
      "theirs-d",
      ">>>>>>> feat",
      "5",
    ].join("\n");
    const file = splitFileLines(`${text}\n`);
    const { patchText } = buildConflictPatch("f.txt", file, parseConflictRegions(file.lines), {
      ours: "HEAD",
      theirs: "feat",
    });
    expect(patchText.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,4 +1,3 @@ conflict 1/2: HEAD | feat",
      // Ours: 1 ours-a ours-b 2 [3] 4 5 — the second hunk starts at "3" on both sides,
      // shifted by each side's own line count for the first region.
      "@@ -5,3 +4,5 @@ conflict 2/2: HEAD | feat",
    ]);
    expect(patchText).toContain(" 2\n@@");
    expect(patchText).toContain("feat\n 3\n 4\n+theirs-c\n+theirs-d\n 5\n");
  });

  test("marks a missing final newline after each side's last line", () => {
    const file = splitFileLines("a\n<<<<<<< HEAD\nM\n=======\nF\n>>>>>>> feat");
    const { patchText } = buildConflictPatch("f.txt", file, parseConflictRegions(file.lines), {
      ours: "HEAD",
      theirs: "feat",
    });
    expect(patchText).toBe(
      [
        "diff --git a/f.txt b/f.txt",
        "--- a/f.txt",
        "+++ b/f.txt",
        "@@ -1,2 +1,2 @@ conflict 1/1: HEAD | feat",
        " a",
        "-M",
        "\\ No newline at end of file",
        "+F",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
  });
});

describe("conflictResolutionLines", () => {
  const region = { ours: ["o"], base: ["b"], theirs: ["t"] };

  test("keeps the chosen side, or both in ours-then-theirs order", () => {
    expect(conflictResolutionLines(region, "ours")).toEqual(["o"]);
    expect(conflictResolutionLines(region, "theirs")).toEqual(["t"]);
    expect(conflictResolutionLines(region, "base")).toEqual(["b"]);
    expect(conflictResolutionLines(region, "both")).toEqual(["o", "t"]);
  });

  test("refuses the base when the markers did not record one", () => {
    expect(() => conflictResolutionLines({ ours: [], theirs: [] }, "base")).toThrow(/diff3/);
  });
});

describe("working copy synthesis and resolution", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hunk-conflicts-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("builds a diff file whose hunks are the regions", () => {
    writeFileSync(join(root, "f.txt"), `${DIFF3_STYLE}\n`);
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    expect(file.conflict?.regions).toHaveLength(1);
    expect(file.metadata.hunks).toHaveLength(1);
    expect(file.metadata.type).toBe("change");
    expect(file.stats).toEqual({ additions: 1, deletions: 1 });
    expect(file.conflict?.regions[0]).toMatchObject({ hunkIndex: 0, base: ["b"] });
  });

  test("serves each side's resolved text as the file's old and new source", async () => {
    writeFileSync(join(root, "f.txt"), `${MERGE_STYLE}\n`);
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    expect(await file.sourceFetcher?.getFullText("old")).toBe("a\nMAIN\nc\n");
    expect(await file.sourceFetcher?.getFullText("new")).toBe("a\nFEAT\nc\n");
  });

  test("shows a marker-free file through the adapter's patch and keeps it marked", () => {
    writeFileSync(join(root, "f.txt"), "a\nFEAT\nc\n");
    const patchText = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " a",
      "-MAIN",
      "+FEAT",
      " c",
      "",
    ].join("\n");
    const file = buildConflictedDiffFile(root, { path: "f.txt", patchText }, 0, root);
    expect(file.conflict).toEqual({ regions: [], unresolved: 0 });
    expect(file.metadata.hunks).toHaveLength(1);
  });

  test("lists a marker-free file without a patch as a resolved placeholder", () => {
    writeFileSync(join(root, "f.txt"), "a\n");
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    expect(file.conflict).toEqual({ regions: [], unresolved: 0 });
    expect(file.metadata.hunks).toHaveLength(0);
  });

  test("resolving a region rewrites only its marker block", () => {
    const path = join(root, "f.txt");
    writeFileSync(path, `${DIFF3_STYLE}\n`);
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    const region = file.conflict!.regions[0]!;

    resolveConflictRegion(path, region, "theirs");
    expect(readFileSync(path, "utf8")).toBe("a\nFEAT\nc\n");

    writeFileSync(path, `${DIFF3_STYLE}\n`);
    resolveConflictRegion(path, region, "both");
    expect(readFileSync(path, "utf8")).toBe("a\nMAIN\nFEAT\nc\n");

    writeFileSync(path, `${DIFF3_STYLE}\n`);
    resolveConflictRegion(path, region, "base");
    expect(readFileSync(path, "utf8")).toBe("a\nb\nc\n");
  });

  test("preserves CRLF endings and a missing final newline", () => {
    const path = join(root, "f.txt");
    writeFileSync(path, MERGE_STYLE.replaceAll("\n", "\r\n"));
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    resolveConflictRegion(path, file.conflict!.regions[0]!, "ours");
    expect(readFileSync(path, "utf8")).toBe("a\r\nMAIN\r\nc");
  });

  test("refuses to resolve a file that changed since it was read", () => {
    const path = join(root, "f.txt");
    writeFileSync(path, `${MERGE_STYLE}\n`);
    const file = buildConflictedDiffFile(root, { path: "f.txt" }, 0, root);
    writeFileSync(path, `extra line\n${MERGE_STYLE}\n`);
    expect(() => resolveConflictRegion(path, file.conflict!.regions[0]!, "ours")).toThrow(
      /changed since/,
    );
    expect(readFileSync(path, "utf8")).toBe(`extra line\n${MERGE_STYLE}\n`);
  });
});
