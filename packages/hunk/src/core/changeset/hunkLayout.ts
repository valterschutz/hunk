/**
 * Row geometry for a hunk list, computed the way Pierre's parser computes it.
 *
 * Every transform that rebuilds a file's hunk list (splitting hunks, hiding decided
 * ones) has to re-derive the same three per-hunk facts Pierre derives while parsing:
 * the collapsed gap before the hunk and the hunk's first row in each layout. Keeping
 * that derivation here means all such transforms agree with the parser and with each
 * other, so row planning, navigation, and gap addressing see one consistent geometry.
 */
import type { FileDiffMetadata } from "@pierre/diffs";

export type DiffHunk = FileDiffMetadata["hunks"][number];
export type DiffHunkBlock = DiffHunk["hunkContent"][number];

/** Mirror Pierre's boundary rule: a zero-count side names the line before the change. */
export function hunkSideStartBoundary(start: number, count: number) {
  return start - (count === 0 ? 0 : 1);
}

/** Rows one hunk's blocks occupy in split view: paired changes share a row. */
export function splitRowCount(blocks: readonly DiffHunkBlock[]) {
  return blocks.reduce(
    (total, block) =>
      total + (block.type === "context" ? block.lines : Math.max(block.additions, block.deletions)),
    0,
  );
}

/** Rows one hunk's blocks occupy in unified view: every changed line is its own row. */
export function unifiedRowCount(blocks: readonly DiffHunkBlock[]) {
  return blocks.reduce(
    (total, block) =>
      total + (block.type === "context" ? block.lines : block.additions + block.deletions),
    0,
  );
}

/** Lay the hunks out again exactly as Pierre's parser would have, had it parsed only them. */
export function relayoutHunks(hunks: readonly DiffHunk[]): DiffHunk[] {
  let lastHunkEnd = 0;
  let splitLineCount = 0;
  let unifiedLineCount = 0;
  return hunks.map((hunk) => {
    const startBoundary = hunkSideStartBoundary(hunk.additionStart, hunk.additionCount);
    const collapsedBefore = Math.max(startBoundary - lastHunkEnd, 0);
    lastHunkEnd = startBoundary + hunk.additionCount;
    const relaid: DiffHunk = {
      ...hunk,
      collapsedBefore,
      splitLineStart: splitLineCount + collapsedBefore,
      unifiedLineStart: unifiedLineCount + collapsedBefore,
    };
    splitLineCount += collapsedBefore + hunk.splitLineCount;
    unifiedLineCount += collapsedBefore + hunk.unifiedLineCount;
    return relaid;
  });
}

/** Rows a hunk list occupies, including the collapsed gaps before each hunk. */
export function hunkRows(
  hunks: readonly DiffHunk[],
  layout: "splitLineCount" | "unifiedLineCount",
) {
  return hunks.reduce((total, hunk) => total + hunk.collapsedBefore + hunk[layout], 0);
}
