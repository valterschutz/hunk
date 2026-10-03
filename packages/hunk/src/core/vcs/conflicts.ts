import fs from "node:fs";
import { join } from "node:path";
import { createSkippedBinaryMetadata, isProbablyBinaryFile } from "../changeset/binary";
import { buildDiffFile } from "../changeset/diffFile";
import { createFileSourceFetcher, type FileSourceFetcher } from "../changeset/fileSource";
import type {
  ConflictRegion,
  ConflictResolutionChoice,
  DiffFile,
  DiffFileConflict,
} from "../changeset/model";
import type { ExtensionVcsConflictedFile } from "../../extension-api/types";
import { escapeUntrackedPatchPath } from "../../lib/patchPath";
import { parseSingleFilePatch } from "../patch/singleFile";

/**
 * Host-side synthesis of conflicted working copies into reviewable diffs, and
 * the resolution writes that take them apart again.
 *
 * This is the half of the `conflictedFiles` contract Hunk owns: an adapter says
 * which paths its VCS left with conflict markers, and everything below reads
 * each working copy, splits it at its markers, and builds one hunk per conflict
 * region — ours on the old side, theirs on the new side, the untouched text
 * between regions as context. Picking a side rewrites exactly that marker block
 * in the working copy; the VCS is never asked to do anything.
 */

const CONTEXT_LINES = 3;

const OPENING_MARKER = /^<{7,}(?: (.*))?$/;
const BASE_MARKER = /^\|{7,}(?: .*)?$/;
const SEPARATOR_MARKER = /^={7,}$/;
const CLOSING_MARKER = /^>{7,}(?: (.*))?$/;

/** The lines of one text file plus what is needed to write them back unchanged. */
export interface FileLines {
  lines: string[];
  eol: "\n" | "\r\n";
  endsWithNewline: boolean;
}

/** Split file text into lines, remembering the line ending and whether a final one existed. */
export function splitFileLines(text: string): FileLines {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const endsWithNewline = text.endsWith("\n");
  const lines = text === "" ? [] : text.split("\n");
  if (endsWithNewline) {
    lines.pop();
  }
  return {
    lines: eol === "\r\n" ? lines.map((line) => line.replace(/\r$/, "")) : lines,
    eol,
    endsWithNewline,
  };
}

/** Join lines back into file text with the ending `splitFileLines` recorded. */
export function joinFileLines({ lines, eol, endsWithNewline }: FileLines) {
  if (lines.length === 0) return "";
  return lines.join(eol) + (endsWithNewline ? eol : "");
}

/** One region as the markers delimit it, before the patch builder assigns its hunk. */
type ParsedRegion = Omit<ConflictRegion, "hunkIndex">;

/**
 * Find every complete conflict region in a file's lines.
 *
 * A region runs from a `<<<<<<<` line to the next `>>>>>>>` line, with an
 * optional `|||||||` base section before the `=======` separator. An opening
 * marker without a closing one is treated as ordinary content, as is any marker
 * met outside a region, so a file that merely quotes a separator is left alone.
 */
export function parseConflictRegions(lines: readonly string[]): ParsedRegion[] {
  const regions: ParsedRegion[] = [];
  let index = 0;
  while (index < lines.length) {
    const opening = OPENING_MARKER.exec(lines[index]!);
    if (!opening) {
      index += 1;
      continue;
    }
    const region = parseRegionAt(lines, index, opening[1] ?? "");
    if (!region) {
      index += 1;
      continue;
    }
    regions.push(region);
    index = region.markerEnd + 1;
  }
  return regions;
}

/** Parse one region opening at `start`, or return null when it never closes. */
function parseRegionAt(
  lines: readonly string[],
  start: number,
  oursLabel: string,
): ParsedRegion | null {
  const ours: string[] = [];
  const base: string[] = [];
  const theirs: string[] = [];
  let section: "ours" | "base" | "theirs" = "ours";
  let hasBase = false;

  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (section === "ours" && BASE_MARKER.test(line)) {
      section = "base";
      hasBase = true;
      continue;
    }
    if (section !== "theirs" && SEPARATOR_MARKER.test(line)) {
      section = "theirs";
      continue;
    }
    if (section === "theirs") {
      const closing = CLOSING_MARKER.exec(line);
      if (closing) {
        return {
          markerStart: start,
          markerEnd: index,
          ours,
          ...(hasBase ? { base } : {}),
          theirs,
          oursLabel,
          theirsLabel: closing[1] ?? "",
        };
      }
    }
    // A second opening marker before this region closed means the first was
    // not a real conflict; let the caller retry from the next line.
    if (OPENING_MARKER.test(line)) {
      return null;
    }
    (section === "ours" ? ours : section === "base" ? base : theirs).push(line);
  }
  return null;
}

/** The side-complete text of a conflicted file: every region replaced by one side. */
function resolveAllRegions(
  file: FileLines,
  regions: readonly ParsedRegion[],
  side: "ours" | "theirs",
) {
  const lines: string[] = [];
  let cursor = 0;
  for (const region of regions) {
    lines.push(...file.lines.slice(cursor, region.markerStart), ...region[side]);
    cursor = region.markerEnd + 1;
  }
  lines.push(...file.lines.slice(cursor));
  return joinFileLines({ ...file, lines });
}

interface HunkLine {
  prefix: " " | "-" | "+";
  text: string;
}

/** Describe the start of one hunk side the way unified diff headers do. */
function hunkRange(start: number, count: number) {
  // A side with no lines names the line the change follows, as git does.
  return count === 0 ? `${start - 1},0` : count === 1 ? `${start}` : `${start},${count}`;
}

/**
 * Build the unified diff that shows every region as one hunk, ours versus
 * theirs, and record which hunk each region became.
 *
 * Context between two regions is shared out like Hunk's change groups: the
 * earlier region keeps up to three lines as trailing context, the later one
 * takes up to three as leading context, so neighboring hunks never overlap.
 */
export function buildConflictPatch(
  safePath: string,
  file: FileLines,
  regions: readonly ParsedRegion[],
  labels: { ours: string; theirs: string },
): { patchText: string; regions: ConflictRegion[] } {
  const header = [
    `diff --git a/${safePath} b/${safePath}`,
    `--- a/${safePath}`,
    `+++ b/${safePath}`,
  ];
  const hunks: string[] = [];
  const placed: ConflictRegion[] = [];
  const noNewline = "\\ No newline at end of file";

  // How far each side's line numbers have drifted from the working copy's,
  // after every region so far was replaced by that side.
  let oursOffset = 0;
  let theirsOffset = 0;

  regions.forEach((region, regionIndex) => {
    const previous = regions[regionIndex - 1];
    const next = regions[regionIndex + 1];
    const sharedBefore = file.lines.slice(
      previous ? previous.markerEnd + 1 : 0,
      region.markerStart,
    );
    const sharedAfter = file.lines.slice(
      region.markerEnd + 1,
      next ? next.markerStart : file.lines.length,
    );
    const trailingOfPrevious = previous
      ? Math.min(CONTEXT_LINES, Math.floor(sharedBefore.length / 2))
      : 0;
    const leading = Math.min(CONTEXT_LINES, sharedBefore.length - trailingOfPrevious);
    const trailing = next
      ? Math.min(CONTEXT_LINES, Math.floor(sharedAfter.length / 2))
      : Math.min(CONTEXT_LINES, sharedAfter.length);

    const hunkStart = region.markerStart - leading;
    const oursStart = hunkStart + 1 + oursOffset;
    const theirsStart = hunkStart + 1 + theirsOffset;

    const lines: HunkLine[] = [
      ...sharedBefore
        .slice(sharedBefore.length - leading)
        .map((text): HunkLine => ({ prefix: " ", text })),
      ...region.ours.map((text): HunkLine => ({ prefix: "-", text })),
      ...region.theirs.map((text): HunkLine => ({ prefix: "+", text })),
      ...sharedAfter.slice(0, trailing).map((text): HunkLine => ({ prefix: " ", text })),
    ];
    const oursCount = leading + region.ours.length + trailing;
    const theirsCount = leading + region.theirs.length + trailing;

    const isLastRegion = regionIndex === regions.length - 1;
    const reachesEnd = isLastRegion && trailing === sharedAfter.length;
    const body = lines.map((line) => `${line.prefix}${line.text}`);
    if (!file.endsWithNewline && reachesEnd && lines.length > 0) {
      if (trailing > 0) {
        body.push(noNewline);
      } else {
        // The last line differs per side: mark it after each side's final line.
        const oursEnd = leading + region.ours.length;
        if (region.theirs.length > 0) body.splice(oursEnd + region.theirs.length, 0, noNewline);
        if (region.ours.length > 0) body.splice(oursEnd, 0, noNewline);
      }
    }

    hunks.push(
      `@@ -${hunkRange(oursStart, oursCount)} +${hunkRange(theirsStart, theirsCount)} @@ conflict ${regionIndex + 1}/${regions.length}: ${labels.ours} | ${labels.theirs}`,
      ...body,
    );
    placed.push({ ...region, hunkIndex: regionIndex });

    const markerLines = region.markerEnd - region.markerStart + 1;
    oursOffset += region.ours.length - markerLines;
    theirsOffset += region.theirs.length - markerLines;
  });

  return { patchText: `${[...header, ...hunks].join("\n")}\n`, regions: placed };
}

/** Pick the label a side shows: the adapter's name for it, else what the markers say. */
function sideLabel(
  configured: string | undefined,
  fromMarkers: string | undefined,
  fallback: string,
) {
  return configured ?? (fromMarkers && fromMarkers.length > 0 ? fromMarkers : fallback);
}

/** A source fetcher serving fixed text for each side, for files that exist only in memory. */
function createTextSourceFetcher(oldText: string, newText: string): FileSourceFetcher {
  return {
    getFullText: (side) => Promise.resolve(side === "old" ? oldText : newText),
  };
}

/** Build the review of one conflicted working copy from its markers. */
export function buildConflictedDiffFile(
  repoRoot: string,
  entry: ExtensionVcsConflictedFile,
  index: number,
  sourcePrefix: string,
): DiffFile {
  const absolutePath = join(repoRoot, entry.path);
  const safePath = escapeUntrackedPatchPath(entry.path);

  if (isProbablyBinaryFile(absolutePath)) {
    return buildDiffFile(
      createSkippedBinaryMetadata(entry.path, "change"),
      `Binary file skipped: ${entry.path}\n`,
      index,
      sourcePrefix,
      null,
      { isBinary: true, conflict: { regions: [], unresolved: 0 } },
    );
  }

  const file = splitFileLines(fs.readFileSync(absolutePath, "utf8"));
  const regions = parseConflictRegions(file.lines);

  if (regions.length === 0) {
    const patchText = entry.patchText ?? "";
    const conflict: DiffFileConflict = { regions: [], unresolved: 0 };
    if (patchText.trim() === "") {
      // Nothing to show: the file matches the side the merge started from, or
      // the adapter chose not to diff it. List it so the reviewer sees it is done.
      return buildDiffFile(
        { ...createResolvedPlaceholderMetadata(entry.path) },
        "",
        index,
        sourcePrefix,
        null,
        { conflict, stats: { additions: 0, deletions: 0 } },
      );
    }
    return buildDiffFile(
      parseSingleFilePatch(patchText, entry.path),
      patchText,
      index,
      sourcePrefix,
      null,
      {
        conflict,
        sourceFetcherBuilder: () =>
          createFileSourceFetcher({
            old: { kind: "none" },
            new: { kind: "fs", absolutePath },
          }),
      },
    );
  }

  const labels = {
    ours: sideLabel(entry.labels?.ours, regions[0]?.oursLabel, "ours"),
    theirs: sideLabel(entry.labels?.theirs, regions[0]?.theirsLabel, "theirs"),
  };
  const { patchText, regions: placed } = buildConflictPatch(safePath, file, regions, labels);
  const oursText = resolveAllRegions(file, regions, "ours");
  const theirsText = resolveAllRegions(file, regions, "theirs");

  return buildDiffFile(
    parseSingleFilePatch(patchText, entry.path),
    patchText,
    index,
    sourcePrefix,
    null,
    {
      conflict: { regions: placed, unresolved: placed.length },
      sourceFetcherBuilder: () => createTextSourceFetcher(oursText, theirsText),
    },
  );
}

/** Placeholder metadata for a resolved file the adapter supplied no diff for. */
function createResolvedPlaceholderMetadata(filePath: string) {
  return {
    name: filePath,
    type: "change" as const,
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    additionLines: [],
    deletionLines: [],
    cacheKey: `${filePath}:conflict-resolved`,
  };
}

/** The lines one resolution choice keeps from a region. */
export function conflictResolutionLines(
  region: Pick<ConflictRegion, "ours" | "base" | "theirs">,
  choice: ConflictResolutionChoice,
): readonly string[] {
  switch (choice) {
    case "ours":
      return region.ours;
    case "theirs":
      return region.theirs;
    case "both":
      return [...region.ours, ...region.theirs];
    case "base":
      if (!region.base) {
        throw new Error(
          "This conflict has no base: set merge.conflictStyle to diff3 to record it.",
        );
      }
      return region.base;
  }
}

/**
 * Replace one conflict region in the working copy with the chosen side.
 *
 * The file is re-read and the markers re-checked at the recorded lines before
 * anything is written, so a working copy edited since the review loaded is
 * refused instead of being mangled; the caller reloads and tries again.
 */
export function resolveConflictRegion(
  absolutePath: string,
  region: ConflictRegion,
  choice: ConflictResolutionChoice,
) {
  const replacement = conflictResolutionLines(region, choice);
  const file = splitFileLines(fs.readFileSync(absolutePath, "utf8"));
  const opening = file.lines[region.markerStart];
  const closing = file.lines[region.markerEnd];
  if (
    opening === undefined ||
    closing === undefined ||
    !OPENING_MARKER.test(opening) ||
    !CLOSING_MARKER.test(closing)
  ) {
    throw new Error("The file changed since it was loaded; reload before resolving.");
  }
  const lines = [
    ...file.lines.slice(0, region.markerStart),
    ...replacement,
    ...file.lines.slice(region.markerEnd + 1),
  ];
  fs.writeFileSync(absolutePath, joinFileLines({ ...file, lines }));
}
