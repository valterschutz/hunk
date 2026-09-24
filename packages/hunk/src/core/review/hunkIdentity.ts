/**
 * Derives the content identity of one hunk, shared by the changeset and review models.
 *
 * A reviewer's decision on a hunk, and any note written beside it, must survive a restart,
 * a rebase that shifts line numbers, and a sync to another machine, so a hunk is identified
 * by its content rather than its position: the file path plus every line of the hunk with
 * its `+`/`-`/context kind. Line numbers and the `@@` header are deliberately left out, and
 * a hunk whose text changes in any way is a new hunk.
 *
 * Both `DiffFile` (renderer model) and `ReviewFileV1` (review document) carry the same line
 * arrays and hunk blocks, so one structural shape serves both and the digests agree.
 */
import { reviewContentDigest } from "./identity";
import type { ReviewHunkBlockV1 } from "./types";

/** The file facts identity reads: the path and the per-side line texts. */
export interface HunkIdentityFile {
  path: string;
  additionLines: readonly string[];
  deletionLines: readonly string[];
}

/** The hunk facts identity reads: its blocks, in display order. */
export interface HunkIdentityHunk {
  hunkContent: readonly ReviewHunkBlockV1[];
}

/** Strip the line ending the parser keeps on each line, so texts compare and print cleanly. */
export function stripLineEnding(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

/** Return every line of one hunk prefixed with its diff kind, in display order. */
export function reviewHunkLines(file: HunkIdentityFile, hunk: HunkIdentityHunk): string[] {
  const { additionLines, deletionLines } = file;
  const lines: string[] = [];
  const take = (source: readonly string[], start: number, count: number, kind: string) => {
    for (let index = start; index < start + count; index += 1) {
      const line = source[index];
      if (line === undefined) {
        throw new Error(
          `Hunk in ${file.path} references ${kind === "-" ? "deletion" : "addition"} line ${index} outside the parsed ${source.length} lines`,
        );
      }
      lines.push(`${kind}${stripLineEnding(line)}`);
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
export function reviewHunkIdentity(file: HunkIdentityFile, hunk: HunkIdentityHunk): string {
  return reviewContentDigest([file.path, ...reviewHunkLines(file, hunk)]);
}

/** Whether a string has the shape of a hunk identity. */
export function isHunkIdentity(value: string): boolean {
  return /^[0-9a-f]{32}$/u.test(value);
}
