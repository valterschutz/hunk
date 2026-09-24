/**
 * Hides the hunks a reviewer has already verified from the files a review renders.
 *
 * A reviewer working through a large commit marks each hunk they have read as verified;
 * the mark has to survive a restart, a rebase that shifts line numbers, and a sync to
 * another machine, so a hunk is identified by its content rather than by its position:
 * the file path plus every line of the hunk with its `+`/`-`/context kind. Line numbers
 * and the `@@` header are deliberately left out, and a hunk whose text changes in any
 * way is a new, unverified hunk.
 *
 * Hiding rebuilds each file's parsed metadata with the verified hunks removed, so every
 * downstream consumer (row planning, navigation, notes, identity) sees a smaller diff
 * rather than a special case. The per-side line arrays are kept whole; only the hunk
 * list and the row geometry that Pierre derives from it are recomputed, the same way
 * Pierre's own parser lays hunks out. A file whose every hunk is verified leaves the
 * review entirely.
 *
 * Known limitation: the gap between two kept hunks may now contain hidden changes, so
 * its old and new sides no longer span the same number of lines. The gap keeps the
 * new-side length, as Pierre's parser does, and expanding it pairs the two sides by
 * offset, which can misalign rows inside such a gap.
 */
import { reviewContentDigest } from "../review/identity";
import { hunkRows, relayoutHunks, type DiffHunk } from "./hunkLayout";
import type { DiffFile } from "./model";

export interface VerifiedHunksProjection {
  /** The files to review, with verified hunks removed and fully verified files dropped. */
  files: DiffFile[];
  /** For each kept file id, the identity of each kept hunk, in hunk order. */
  hunkIdentitiesByFileId: ReadonlyMap<string, readonly string[]>;
  /** How many hunks the projection removed. */
  hiddenHunkCount: number;
}

/** Return every line of one hunk prefixed with its diff kind, in display order. */
function hunkLines(file: DiffFile, hunk: DiffHunk): string[] {
  const { additionLines, deletionLines } = file.metadata;
  const lines: string[] = [];
  const take = (source: readonly string[], start: number, count: number, kind: string) => {
    for (let index = start; index < start + count; index += 1) {
      const line = source[index];
      if (line === undefined) {
        throw new Error(
          `Hunk in ${file.path} references ${kind === "-" ? "deletion" : "addition"} line ${index} outside the parsed ${source.length} lines`,
        );
      }
      lines.push(`${kind}${line}`);
    }
  };
  for (const block of hunk.hunkContent) {
    if (block.type === "context") {
      take(additionLines, block.additionLineIndex, block.lines, " ");
    } else {
      take(deletionLines, block.deletionLineIndex, block.deletions, "-");
      take(additionLines, block.additionLineIndex, block.additions, "+");
    }
  }
  return lines;
}

/** Derive the content identity of one hunk: its file path and its lines, kinds included. */
export function verifiedHunkIdentity(file: DiffFile, hunk: DiffHunk): string {
  return reviewContentDigest([file.path, ...hunkLines(file, hunk)]);
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
      cacheKey: `${metadata.cacheKey}:verified-hidden:${reviewContentDigest(hiddenIdentities)}`,
    },
  };
}

/**
 * Remove every verified hunk from the files, dropping files that have nothing left.
 *
 * A file with no verified hunks is returned as the same object, so memoized consumers
 * keep their work for it.
 */
export function hideVerifiedHunks(
  files: readonly DiffFile[],
  verified: ReadonlySet<string>,
): VerifiedHunksProjection {
  const hunkIdentitiesByFileId = new Map<string, readonly string[]>();
  let hiddenHunkCount = 0;
  const projected: DiffFile[] = [];

  for (const file of files) {
    if (hunkIdentitiesByFileId.has(file.id)) {
      throw new Error(`Duplicate diff file id ${file.id}`);
    }
    const identities = file.metadata.hunks.map((hunk) => verifiedHunkIdentity(file, hunk));
    const kept: DiffHunk[] = [];
    const keptIdentities: string[] = [];
    const hiddenIdentities: string[] = [];
    file.metadata.hunks.forEach((hunk, index) => {
      const identity = identities[index]!;
      if (verified.has(identity)) {
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
