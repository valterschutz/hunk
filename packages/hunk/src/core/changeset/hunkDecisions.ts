/**
 * Projects hunk-state filters into visible diff content and eligible review targets.
 *
 * A reviewer working through a commit accepts or rejects each hunk; the decision has to
 * survive a restart, a rebase that shifts line numbers, and a sync to another machine, so a
 * hunk is identified by its content (`reviewHunkIdentity`) rather than by its position. By default only undecided hunks are shown;
 * the reviewer can show or hide each state (undecided, accepted, rejected, fixed) on its own.
 *
 * Folded files rebuild parsed metadata with excluded hunks removed. Whole-file requests
 * retain the complete metadata and identify eligible original hunk indices separately,
 * so rendering preserves decided changes without making them decision targets. The per-side line arrays are kept whole; only the hunk
 * list and the row geometry that Pierre derives from it are recomputed, the same way
 * Pierre's own parser lays hunks out. An exhausted folded file leaves the review;
 * an exhausted whole file remains visible as context.
 *
 * Known folded-file limitation: the gap between two kept hunks may contain hidden changes, so
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
  /** Visible files: complete whole-file diffs and filtered folded diffs. */
  files: DiffFile[];
  /** Content identities of rendered hunks in their rendered order. */
  hunkIdentitiesByFileId: ReadonlyMap<string, readonly string[]>;
  /** Eligible indices in each rendered file; whole-file content keeps its original indices. */
  eligibleHunkIndicesByFileId: ReadonlyMap<string, readonly number[]>;
  /** How many hunks the projection removed from view. */
  hiddenHunkCount: number;
  /** How many visible hunks are context rather than eligible review targets. */
  contextHunkCount: number;
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

/** Find the next eligible review unit after a decision, wrapping files only when this file is exhausted. */
export function nextEligibleReviewHunk(
  files: readonly DiffFile[],
  decisions: ReadonlyMap<string, HunkDecision>,
  shown: ReadonlySet<HunkState>,
  fileId: string,
  identity: string,
): { fileId: string; identity: string } | null {
  const fileIndex = files.findIndex((file) => file.id === fileId);
  if (fileIndex < 0) return null;
  const eligible = (file: DiffFile) =>
    file.metadata.hunks
      .map((hunk, index) => ({ identity: diffHunkIdentity(file, hunk), index }))
      .filter((hunk) => shown.has(hunkState(decisions.get(hunk.identity))));
  const file = files[fileIndex]!;
  const currentIndex = file.metadata.hunks.findIndex(
    (hunk) => diffHunkIdentity(file, hunk) === identity,
  );
  const remaining = eligible(file);
  const local = remaining.find((hunk) => hunk.index > currentIndex) ?? remaining.at(-1);
  if (local) return { fileId, identity: local.identity };
  for (let offset = 1; offset < files.length; offset += 1) {
    const next = files[(fileIndex + offset) % files.length]!;
    const target = eligible(next)[0];
    if (target) return { fileId: next.id, identity: target.identity };
  }
  return null;
}

/**
 * Remove excluded hunks in folded files; retain complete whole-file diffs with separate eligibility.
 *
 * A file that loses no hunk is returned as the same object, so memoized consumers keep their
 * work for it.
 */
export function filterHunksByState(
  files: readonly DiffFile[],
  decisions: ReadonlyMap<string, HunkDecision>,
  shown: ReadonlySet<HunkState>,
  wholeFileIds: ReadonlySet<string> = new Set(),
): HunkDecisionsProjection {
  const hunkIdentitiesByFileId = new Map<string, readonly string[]>();
  const eligibleHunkIndicesByFileId = new Map<string, readonly number[]>();
  let hiddenHunkCount = 0;
  let contextHunkCount = 0;
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
    if (wholeFileIds.has(file.id)) {
      // Keep the complete diff geometry: hidden changes cannot be reconstructed as source gaps.
      projected.push(file);
      hunkIdentitiesByFileId.set(file.id, identities);
      eligibleHunkIndicesByFileId.set(
        file.id,
        identities.flatMap((identity, index) =>
          shown.has(hunkState(decisions.get(identity))) ? [index] : [],
        ),
      );
      contextHunkCount += hiddenIdentities.length;
    } else {
      hiddenHunkCount += hiddenIdentities.length;
      if (hiddenIdentities.length === 0) {
        projected.push(file);
        hunkIdentitiesByFileId.set(file.id, keptIdentities);
      } else if (kept.length > 0) {
        projected.push(withHunks(file, kept, hiddenIdentities));
        hunkIdentitiesByFileId.set(file.id, keptIdentities);
      }
      if (hunkIdentitiesByFileId.has(file.id)) {
        eligibleHunkIndicesByFileId.set(
          file.id,
          keptIdentities.map((_identity, index) => index),
        );
      }
    }
  }

  return {
    files: projected,
    hunkIdentitiesByFileId,
    eligibleHunkIndicesByFileId,
    hiddenHunkCount,
    contextHunkCount,
  };
}
