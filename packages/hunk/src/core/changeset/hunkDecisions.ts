/**
 * Hides the hunks whose decision state the reviewer filtered out from the files a review renders.
 *
 * A reviewer working through a commit accepts or rejects each hunk; the decision has to
 * survive a restart, a rebase that shifts line numbers, and a sync to another machine, so a
 * hunk is identified by its content (`reviewHunkIdentity`) rather than by its position. By default only undecided hunks are shown;
 * the reviewer can show or hide each state (undecided, accepted, rejected, fixed) on its own.
 *
 * Hiding rebuilds each file's parsed metadata with the decided hunks removed, so every
 * downstream consumer (row planning, navigation, notes, identity) sees a smaller diff
 * rather than a special case. The per-side line arrays are kept whole; only the hunk
 * list and the row geometry that Pierre derives from it are recomputed, the same way
 * Pierre's own parser lays hunks out. A file whose every hunk is decided leaves the
 * review entirely.
 *
 * Known limitation: the gap between two kept hunks may now contain hidden changes, so
 * its old and new sides no longer span the same number of lines. The gap keeps the
 * new-side length, as Pierre's parser does, and expanding it pairs the two sides by
 * offset, which can misalign rows inside such a gap.
 */
import { reviewHunkIdentity, reviewHunkLines } from "../review/hunkIdentity";
import { reviewContentDigest } from "../review/identity";
import type { HunkDecision, HunkState } from "../review/reviewFile";
import { hunkRows, relayoutHunks, type DiffHunk } from "./hunkLayout";
import type { DiffFile } from "./model";

export interface HunkDecisionsProjection {
  /** The files to review, with filtered-out hunks removed and files left empty dropped. */
  files: DiffFile[];
  /** For each kept file id, the identity of each kept hunk, in hunk order. */
  hunkIdentitiesByFileId: ReadonlyMap<string, readonly string[]>;
  /** How many hunks the projection removed. */
  hiddenHunkCount: number;
}

function identityFile(file: DiffFile) {
  return {
    path: file.path,
    additionLines: file.metadata.additionLines,
    deletionLines: file.metadata.deletionLines,
  };
}

/** Derive the content identity of one rendered hunk. */
export function diffHunkIdentity(file: DiffFile, hunk: DiffHunk): string {
  return reviewHunkIdentity(identityFile(file), hunk);
}

/** Return every line of one rendered hunk prefixed with its diff kind. */
export function diffHunkLines(file: DiffFile, hunk: DiffHunk): string[] {
  return reviewHunkLines(identityFile(file), hunk);
}

/** Report a file approved once every reviewable hunk is accepted or fixed. */
export function fileReviewStatus(
  file: DiffFile,
  decisions: ReadonlyMap<string, HunkDecision>,
): "approved" | undefined {
  if (file.metadata.hunks.length === 0) return undefined;
  const approved = file.metadata.hunks.every((hunk) => {
    const decision = decisions.get(diffHunkIdentity(file, hunk));
    return decision === "accepted" || decision === "fixed";
  });
  return approved ? "approved" : undefined;
}

/** Rebuild one file with only the given hunks, preserving rows the parser counted outside them. */
function withHunks(
  file: DiffFile,
  kept: readonly DiffHunk[],
  hiddenIdentities: string[],
): DiffFile {
  const { metadata } = file;
  const hunks = relayoutHunks(kept);
  const splitLineCount =
    metadata.splitLineCount -
    hunkRows(metadata.hunks, "splitLineCount") +
    hunkRows(hunks, "splitLineCount");
  const unifiedLineCount =
    metadata.unifiedLineCount -
    hunkRows(metadata.hunks, "unifiedLineCount") +
    hunkRows(hunks, "unifiedLineCount");
  const stats = { additions: 0, deletions: 0 };
  for (const hunk of hunks) {
    stats.additions += hunk.additionLines;
    stats.deletions += hunk.deletionLines;
  }
  return {
    ...file,
    stats,
    metadata: {
      ...metadata,
      hunks,
      splitLineCount,
      unifiedLineCount,
      // Highlight and render caches key on this value, so a different hidden set must differ.
      cacheKey: `${metadata.cacheKey}:decided-hidden:${reviewContentDigest(hiddenIdentities)}`,
    },
  };
}

/** The state a hunk is filtered by: its decision, or undecided without one. */
export function hunkState(decision: HunkDecision | undefined): HunkState {
  return decision ?? "undecided";
}

/**
 * Remove every hunk whose state is not shown, dropping files that have nothing left.
 *
 * A file that loses no hunk is returned as the same object, so memoized consumers keep their
 * work for it.
 */
export function filterHunksByState(
  files: readonly DiffFile[],
  decisions: ReadonlyMap<string, HunkDecision>,
  shown: ReadonlySet<HunkState>,
): HunkDecisionsProjection {
  const hunkIdentitiesByFileId = new Map<string, readonly string[]>();
  let hiddenHunkCount = 0;
  const projected: DiffFile[] = [];

  for (const file of files) {
    if (hunkIdentitiesByFileId.has(file.id)) {
      throw new Error(`Duplicate diff file id ${file.id}`);
    }
    const identities = file.metadata.hunks.map((hunk) => diffHunkIdentity(file, hunk));
    const kept: DiffHunk[] = [];
    const keptIdentities: string[] = [];
    const hiddenIdentities: string[] = [];
    file.metadata.hunks.forEach((hunk, index) => {
      const identity = identities[index]!;
      if (!shown.has(hunkState(decisions.get(identity)))) {
        hiddenIdentities.push(identity);
      } else {
        kept.push(hunk);
        keptIdentities.push(identity);
      }
    });
    hiddenHunkCount += hiddenIdentities.length;

    if (hiddenIdentities.length === 0) {
      projected.push(file);
      hunkIdentitiesByFileId.set(file.id, keptIdentities);
    } else if (kept.length > 0) {
      projected.push(withHunks(file, kept, hiddenIdentities));
      hunkIdentitiesByFileId.set(file.id, keptIdentities);
    }
  }

  return { files: projected, hunkIdentitiesByFileId, hiddenHunkCount };
}
