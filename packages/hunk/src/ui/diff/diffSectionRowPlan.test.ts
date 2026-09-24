import { describe, expect, test } from "bun:test";
import { createTestDiffFile } from "../../../../../test/helpers/diff-helpers";
import { resolveTheme } from "../themes";
import { buildDiffSectionRowPlan } from "./diffSectionRowPlan";
import type { PlannedReviewRow } from "./reviewRenderPlan";

const theme = resolveTheme("github-dark-default", null);

/** Thirty lines with the fifth changed: a leading gap of one line and a trailing gap of many. */
function createGappedFile() {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}\n`).join("");
  const after = before.replace("line 5\n", "line 5 modified\n");
  return { file: createTestDiffFile({ after, before, id: "alpha", path: "alpha.ts" }), after };
}

/** The same file as a git diff reports it: only the hunk lines, no per-side totals. */
function createPartialGappedFile() {
  const { file, after } = createGappedFile();
  return { file: { ...file, metadata: { ...file.metadata, isPartial: true } }, after };
}

function rowTypes(plannedRows: PlannedReviewRow[]) {
  return plannedRows.map((row) => (row.kind === "diff-row" ? row.row.type : row.kind));
}

describe("buildDiffSectionRowPlan", () => {
  test("keeps hunk chrome while any gap stays collapsed", () => {
    const { file, after } = createGappedFile();
    const { plannedRows } = buildDiffSectionRowPlan({
      expandedKeys: new Set(["before:0"]),
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loaded", text: after },
      theme,
    });

    expect(rowTypes(plannedRows)).toContain("hunk-header");
    expect(rowTypes(plannedRows)).toContain("collapsed");
  });

  test("keeps hunk chrome until the source that fills the gaps has loaded", () => {
    const { file } = createGappedFile();
    const { plannedRows } = buildDiffSectionRowPlan({
      expandedKeys: new Set(["before:0", "trailing:0"]),
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loading" },
      theme,
      wholeFile: true,
    });

    expect(rowTypes(plannedRows)).toContain("hunk-header");
  });

  test("keeps hunk chrome on a fully expanded file the reviewer did not ask to read whole", () => {
    const { file, after } = createGappedFile();
    const { plannedRows } = buildDiffSectionRowPlan({
      expandedKeys: new Set(["before:0", "trailing:0"]),
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loaded", text: after },
      theme,
    });

    expect(rowTypes(plannedRows)).toContain("hunk-header");
    expect(rowTypes(plannedRows)).toContain("collapsed");
  });

  test("renders a whole file as one listing without hunk headers or gap toggles", () => {
    const { file, after } = createGappedFile();
    const { plannedRows } = buildDiffSectionRowPlan({
      expandedKeys: new Set(["before:0", "trailing:0"]),
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loaded", text: after },
      theme,
      wholeFile: true,
    });

    const diffRows = plannedRows.filter((row) => row.kind === "diff-row");
    expect(diffRows).toHaveLength(plannedRows.length);
    expect(diffRows.every((row) => row.row.type === "unified-line")).toBe(true);
    // Every source line plus the removed one; the changed line renders as a pair.
    expect(diffRows).toHaveLength(31);
    // The hunk still anchors navigation, now on its first code row.
    expect(diffRows.filter((row) => row.anchorId !== undefined)).toHaveLength(1);
  });
});

describe("buildDiffSectionRowPlan for a partial patch", () => {
  test("offers the tail after the last hunk as a gap once the source is loaded", () => {
    const { file, after } = createPartialGappedFile();
    const unsized = buildDiffSectionRowPlan({
      file,
      layout: "unified",
      showHunkHeaders: true,
      theme,
    });
    const sized = buildDiffSectionRowPlan({
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loaded", text: after },
      theme,
    });

    expect(rowTypes(unsized.plannedRows).filter((type) => type === "collapsed")).toHaveLength(1);
    expect(rowTypes(sized.plannedRows).filter((type) => type === "collapsed")).toHaveLength(2);
  });

  test("renders the whole file through to its last source line", () => {
    const { file, after } = createPartialGappedFile();
    const { plannedRows } = buildDiffSectionRowPlan({
      expandedKeys: new Set(["before:0", "trailing:0"]),
      file,
      layout: "unified",
      showHunkHeaders: true,
      sourceStatus: { kind: "loaded", text: after },
      theme,
      wholeFile: true,
    });

    const diffRows = plannedRows.filter((row) => row.kind === "diff-row");
    expect(diffRows).toHaveLength(plannedRows.length);
    expect(diffRows.every((row) => row.row.type === "unified-line")).toBe(true);
    expect(diffRows).toHaveLength(31);
  });
});
