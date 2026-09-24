/**
 * Splits every parsed hunk into one hunk per contiguous run of changed lines.
 *
 * Git merges nearby changes into a single `@@` hunk whenever their context windows touch,
 * so with the default three lines of context two edits up to six lines apart arrive as one
 * hunk. For a reviewer stepping through a diff hunk by hunk that unit is too coarse: one
 * step can skip past several unrelated edits, and accepting the hunk vouches for all
 * of them at once. This transform makes the review unit the change group instead — what
 * a `-U0` diff would call a hunk — while keeping every context line on screen.
 *
 * The context between two change groups is shared out: the earlier group keeps the first
 * half as trailing context, the later group gets the rest as leading context, so each new
 * hunk still reads like a small unified diff of its own. No rows are added or removed, so
 * the file's total row counts are unchanged and the new hunks abut with no collapsed gap
 * between them.
 *
 * A hunk that Git already produced as a single change group is returned as the same object.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import {
  relayoutHunks,
  splitRowCount,
  unifiedRowCount,
  type DiffHunk,
  type DiffHunkBlock,
} from "./hunkLayout";

/** Group a hunk's blocks so each group holds exactly one change block. */
function groupBlocksByChange(hunk: DiffHunk): DiffHunkBlock[][] {
  const groups: DiffHunkBlock[][] = [[]];

  for (const block of hunk.hunkContent) {
    const current = groups[groups.length - 1]!;
    if (block.type === "context" || !current.some((member) => member.type === "change")) {
      current.push(block);
      continue;
    }

    const separator = current.pop();
    if (separator?.type !== "context" || separator.lines < 1) {
      throw new Error(
        `Hunk ${hunk.hunkSpecs?.trim() ?? ""} has two change blocks with no context between them`,
      );
    }
    const trailing = Math.floor(separator.lines / 2);
    const leading = separator.lines - trailing;
    if (trailing > 0) {
      current.push({ ...separator, lines: trailing });
    }
    groups.push([
      {
        ...separator,
        lines: leading,
        additionLineIndex: separator.additionLineIndex + trailing,
        deletionLineIndex: separator.deletionLineIndex + trailing,
      },
      block,
    ]);
  }

  return groups;
}

/** Count one side's lines across a block list: context plus that side's changed lines. */
function sideLineCount(blocks: readonly DiffHunkBlock[], side: "additions" | "deletions") {
  return blocks.reduce(
    (total, block) => total + (block.type === "context" ? block.lines : block[side]),
    0,
  );
}

/** Count one side's changed lines across a block list. */
function sideChangedLineCount(blocks: readonly DiffHunkBlock[], side: "additions" | "deletions") {
  return blocks.reduce((total, block) => total + (block.type === "context" ? 0 : block[side]), 0);
}

/**
 * Split one hunk at its change groups.
 *
 * Line numbers are assigned by walking each side's cursor across the groups. A group with
 * no lines on one side follows Pierre's boundary rule and names the line before it, which
 * is also what Git writes for a `-N,0` or `+N,0` header. Only the first group keeps the
 * header's function context, and only the last group can carry the end-of-file markers.
 * The row starts and collapsed gap are left for `relayoutHunks` to assign.
 */
function splitHunkAtChangeGroups(hunk: DiffHunk): DiffHunk[] {
  const groups = groupBlocksByChange(hunk);
  if (groups.length === 1) {
    return [hunk];
  }

  let additionCursor = hunk.additionStart + (hunk.additionCount === 0 ? 1 : 0);
  let deletionCursor = hunk.deletionStart + (hunk.deletionCount === 0 ? 1 : 0);
  const { hunkSpecs: _hunkSpecs, hunkContext, ...base } = hunk;

  return groups.map((blocks, index) => {
    const first = blocks[0]!;
    const isFirst = index === 0;
    const isLast = index === groups.length - 1;
    const additionCount = sideLineCount(blocks, "additions");
    const deletionCount = sideLineCount(blocks, "deletions");
    const additionStart = additionCount === 0 ? additionCursor - 1 : additionCursor;
    const deletionStart = deletionCount === 0 ? deletionCursor - 1 : deletionCursor;
    additionCursor += additionCount;
    deletionCursor += deletionCount;

    return {
      ...base,
      ...(isFirst && hunkContext !== undefined ? { hunkContext } : {}),
      hunkContent: blocks,
      additionLineIndex: first.additionLineIndex,
      deletionLineIndex: first.deletionLineIndex,
      additionStart,
      additionCount,
      additionLines: sideChangedLineCount(blocks, "additions"),
      deletionStart,
      deletionCount,
      deletionLines: sideChangedLineCount(blocks, "deletions"),
      splitLineCount: splitRowCount(blocks),
      unifiedLineCount: unifiedRowCount(blocks),
      noEOFCRAdditions: isLast && hunk.noEOFCRAdditions,
      noEOFCRDeletions: isLast && hunk.noEOFCRDeletions,
    };
  });
}

/**
 * Rebuild a file's metadata with every hunk split at its change groups.
 *
 * Returns the same object when no hunk needed splitting, so memoized consumers keep
 * their work for it.
 */
export function splitHunksAtChangeGroups(metadata: FileDiffMetadata): FileDiffMetadata {
  const hunks = metadata.hunks.flatMap(splitHunkAtChangeGroups);
  if (hunks.length === metadata.hunks.length) {
    return metadata;
  }

  return { ...metadata, hunks: relayoutHunks(hunks) };
}
