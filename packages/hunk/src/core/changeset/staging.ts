/**
 * Marks the hunks of a working-copy review as staged, partly staged, or unstaged.
 *
 * A staging-aware review shows one patch from the base revision to the working copy, so a hunk
 * can hold changes on both sides of the index. The VCS adapter splits the same changes at the
 * index into two zero-context patches; a hunk touched only by base→index changes is staged, one
 * touched only by index→working-copy changes is unstaged, and one touched by both is partly
 * staged. Base→index changes are compared on the old side, index→working-copy changes on the
 * new side: those are the sides each patch shares with the review patch.
 */
import { spanTouchesHunk, type LineSpan } from "@hunk/vcs/hunk-span";
import type { ExtensionVcsHunkTarget } from "../../extension-api/types";
import { changesetFromPatch } from "./fromPatch";
import type { DiffHunk } from "./hunkLayout";
import type { DiffFile, DiffFileStaging } from "./model";

/** Where one displayed hunk's changes sit relative to the index. */
export type HunkStagingState = "staged" | "partly-staged" | "unstaged";

/** The two zero-context patches an adapter reports for a staging-aware review. */
export interface StagingPatches {
  stagedPatchText: string;
  unstagedPatchText: string;
}

/** Collect each file's hunk spans on one side of a zero-context patch, keyed by new-side path. */
function spansByPath(patchText: string, side: "old" | "new") {
  const spans = new Map<string, LineSpan[]>();
  for (const file of changesetFromPatch(patchText, "staging", "staging", null).files) {
    spans.set(
      file.path,
      file.metadata.hunks.map((hunk) =>
        side === "old"
          ? { start: hunk.deletionStart, count: hunk.deletionCount }
          : { start: hunk.additionStart, count: hunk.additionCount },
      ),
    );
  }
  return spans;
}

/**
 * Attach index state to every file of a staging-aware review.
 *
 * Files absent from both patches — untracked files, and files whose changes were reverted in the
 * working copy after staging — get empty staging, which reads as unstaged.
 */
export function withStaging(files: readonly DiffFile[], patches: StagingPatches): DiffFile[] {
  const staged = spansByPath(patches.stagedPatchText, "old");
  const unstaged = spansByPath(patches.unstagedPatchText, "new");
  return files.map((file) => ({
    ...file,
    staging: {
      stagedOldSpans: staged.get(file.path) ?? [],
      unstagedNewSpans: unstaged.get(file.path) ?? [],
    },
  }));
}

/** Return the old- and new-side spans of one displayed hunk, as its `@@` header states them. */
export function hunkSpans(hunk: DiffHunk) {
  return {
    oldSpan: { start: hunk.deletionStart, count: hunk.deletionCount },
    newSpan: { start: hunk.additionStart, count: hunk.additionCount },
  };
}

/** Classify one displayed hunk of a file in a staging-aware review. */
export function hunkStagingState(staging: DiffFileStaging, hunk: DiffHunk): HunkStagingState {
  const { oldSpan, newSpan } = hunkSpans(hunk);
  const hasStaged = staging.stagedOldSpans.some((span) => spanTouchesHunk(oldSpan, span));
  const hasUnstaged = staging.unstagedNewSpans.some((span) => spanTouchesHunk(newSpan, span));
  if (hasStaged && hasUnstaged) return "partly-staged";
  return hasStaged ? "staged" : "unstaged";
}

/**
 * Find the patch hunk a displayed review unit belongs to.
 *
 * Line review splits each hunk into one unit per changed line, but staging stays per hunk, so
 * a line unit is classified and toggled through the hunk whose spans contain it.
 */
export function containingPatchHunk(patchFile: DiffFile, unit: DiffHunk) {
  const { oldSpan, newSpan } = hunkSpans(unit);
  return (
    patchFile.metadata.hunks.find((hunk) => {
      const spans = hunkSpans(hunk);
      return spanTouchesHunk(spans.oldSpan, oldSpan) && spanTouchesHunk(spans.newSpan, newSpan);
    }) ?? unit
  );
}

/** Address one displayed hunk for the provider's index operations. */
export function hunkTarget(file: DiffFile, hunk: DiffHunk): ExtensionVcsHunkTarget {
  return {
    path: file.path,
    ...(file.previousPath !== undefined ? { previousPath: file.previousPath } : {}),
    untracked: file.isUntracked === true,
    ...hunkSpans(hunk),
  };
}
