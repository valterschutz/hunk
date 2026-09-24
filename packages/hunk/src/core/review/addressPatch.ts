/**
 * Rebuilds a review of the hunks a reviewer rejected, from the review file alone.
 *
 * `hunk address` shows every open rejection of a repository so each can be fixed and marked
 * addressed. The commits those hunks came from may be rebased or merged away by then, so the
 * review is synthesized from the hunk text the file kept: one patch section per hunk, with
 * the same path and lines the hunk was recorded with, so its identity — and therefore its
 * decision and notes — matches exactly. Two records for one path stay separate sections;
 * the review model tolerates duplicate paths, and merging overlapping hunks from different
 * commits would change their identities.
 *
 * Only the new-side start is relocated: the hunk's new-side rows are looked for in the file
 * as it is now, so opening the editor from a note lands on today's line rather than the line
 * the commit had. A hunk whose rows are no longer found keeps its recorded start.
 */
import type { HunkRecord, NoteRecord, ReviewRecord } from "./reviewFile";

export interface OpenRejection {
  hunk: HunkRecord;
  /** The notes on the hunk, oldest first. */
  notes: NoteRecord[];
}

/** The rejected hunks of one repository (or all, when `repo` is undefined), with their notes. */
export function openRejections(
  records: readonly ReviewRecord[],
  options: { repo?: string; includeAddressed?: boolean } = {},
): OpenRejection[] {
  const notesByHunk = new Map<string, NoteRecord[]>();
  for (const record of records) {
    if (record.kind !== "note") continue;
    const list = notesByHunk.get(record.hunk) ?? [];
    list.push(record);
    notesByHunk.set(record.hunk, list);
  }
  const rejections: OpenRejection[] = [];
  for (const record of records) {
    if (record.kind !== "hunk") continue;
    if (options.repo !== undefined && record.repo !== options.repo) continue;
    const open = record.state === "rejected" || (options.includeAddressed && record.state === "addressed");
    if (!open) continue;
    const notes = [...(notesByHunk.get(record.id) ?? [])].toSorted((left, right) =>
      (left.createdAt ?? "") < (right.createdAt ?? "")
        ? -1
        : (left.createdAt ?? "") > (right.createdAt ?? "")
          ? 1
          : left.id < right.id
            ? -1
            : 1,
    );
    rejections.push({ hunk: record, notes });
  }
  return rejections.toSorted((left, right) =>
    left.hunk.path < right.hunk.path
      ? -1
      : left.hunk.path > right.hunk.path
        ? 1
        : left.hunk.newStart - right.hunk.newStart,
  );
}

/** The text of the rows a hunk shows on one side. */
function sideRows(lines: readonly string[], side: "old" | "new"): string[] {
  const kept = side === "new" ? [" ", "+"] : [" ", "-"];
  return lines.filter((line) => kept.includes(line.slice(0, 1))).map((line) => line.slice(1));
}

/**
 * Find where a hunk's new-side rows sit in the file as it is now.
 *
 * Every occurrence of the rows as a contiguous block qualifies; the one nearest the recorded
 * start wins, so a repeated block still resolves to the one the reviewer looked at. Undefined
 * when the block is not found, or the hunk has no new-side rows.
 */
export function relocateHunkStart(
  fileLines: readonly string[],
  lines: readonly string[],
  recordedStart: number,
): number | undefined {
  const rows = sideRows(lines, "new");
  if (rows.length === 0 || rows.length > fileLines.length) return undefined;
  let best: number | undefined;
  for (let start = 0; start + rows.length <= fileLines.length; start += 1) {
    let matches = true;
    for (let offset = 0; offset < rows.length; offset += 1) {
      if (fileLines[start + offset] !== rows[offset]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;
    const line = start + 1;
    if (best === undefined || Math.abs(line - recordedStart) < Math.abs(best - recordedStart)) {
      best = line;
    }
  }
  return best;
}

/**
 * Render one patch section per hunk record, relocating each new-side start when possible.
 *
 * `readFileLines` returns the current lines of a repo-relative path, or undefined when the
 * file cannot be read; the recorded start is then kept.
 */
export function synthesizeAddressPatch(
  hunks: readonly HunkRecord[],
  readFileLines: (path: string) => readonly string[] | undefined,
): string {
  const sections: string[] = [];
  for (const hunk of hunks) {
    if (!hunk.lines || hunk.lines.length === 0) {
      throw new Error(`Hunk ${hunk.id} of ${hunk.path} has no recorded lines to address`);
    }
    const oldCount = sideRows(hunk.lines, "old").length;
    const newCount = sideRows(hunk.lines, "new").length;
    const fileLines = readFileLines(hunk.path);
    const newStart =
      (fileLines ? relocateHunkStart(fileLines, hunk.lines, hunk.newStart) : undefined) ??
      hunk.newStart;
    sections.push(
      [
        `diff --git a/${hunk.path} b/${hunk.path}`,
        `--- a/${hunk.path}`,
        `+++ b/${hunk.path}`,
        `@@ -${hunk.oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...hunk.lines,
        "",
      ].join("\n"),
    );
  }
  return sections.join("");
}
