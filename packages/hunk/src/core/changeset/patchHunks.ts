import type { FileDiffMetadata } from "@pierre/diffs";
import { formatHunkHeader } from "./hunkHeader";
import type { DiffHunk, DiffHunkBlock } from "./hunkLayout";

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** Remove the line ending Pierre retains on every parsed source line. */
function lineText(line: string | undefined) {
  if (line === undefined) {
    throw new Error("Cannot render a patch hunk whose source line is missing");
  }
  return line.replace(/\r?\n$/, "");
}

/** Render one unchanged block from the addition-side source shared by both sides. */
function renderContextBlock(
  metadata: FileDiffMetadata,
  hunk: DiffHunk,
  block: Extract<DiffHunkBlock, { type: "context" }>,
  isLastBlock: boolean,
) {
  const lines = Array.from(
    { length: block.lines },
    (_, offset) => ` ${lineText(metadata.additionLines[block.additionLineIndex + offset])}`,
  );
  if (isLastBlock && (hunk.noEOFCRAdditions || hunk.noEOFCRDeletions)) {
    lines.push(NO_NEWLINE_MARKER);
  }
  return lines;
}

/** Render one changed block in unified-diff order: deletions, then additions. */
function renderChangeBlock(
  metadata: FileDiffMetadata,
  hunk: DiffHunk,
  block: Extract<DiffHunkBlock, { type: "change" }>,
  isLastBlock: boolean,
) {
  const lines: string[] = [];
  for (let offset = 0; offset < block.deletions; offset += 1) {
    lines.push(`-${lineText(metadata.deletionLines[block.deletionLineIndex + offset])}`);
    if (isLastBlock && offset === block.deletions - 1 && hunk.noEOFCRDeletions) {
      lines.push(NO_NEWLINE_MARKER);
    }
  }
  for (let offset = 0; offset < block.additions; offset += 1) {
    lines.push(`+${lineText(metadata.additionLines[block.additionLineIndex + offset])}`);
    if (isLastBlock && offset === block.additions - 1 && hunk.noEOFCRAdditions) {
      lines.push(NO_NEWLINE_MARKER);
    }
  }
  return lines;
}

/** Render the parsed hunks while preserving the producer's file-level patch headers. */
export function patchWithMetadataHunks(patch: string, metadata: FileDiffMetadata) {
  const patchLines = patch.split("\n");
  const firstHunkIndex = patchLines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunkIndex < 0) {
    return patch;
  }

  const lines = patchLines.slice(0, firstHunkIndex);
  for (const hunk of metadata.hunks) {
    lines.push(formatHunkHeader(hunk));
    hunk.hunkContent.forEach((block, index) => {
      const isLastBlock = index === hunk.hunkContent.length - 1;
      lines.push(
        ...(block.type === "context"
          ? renderContextBlock(metadata, hunk, block, isLastBlock)
          : renderChangeBlock(metadata, hunk, block, isLastBlock)),
      );
    });
  }
  return `${lines.join("\n")}\n`;
}
