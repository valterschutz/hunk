import type { FileDiffMetadata } from "@pierre/diffs";
import { formatHunkHeader } from "./hunkHeader";
import type { DiffHunk } from "./hunkLayout";

const NO_FINAL_NEWLINE_MARKER = "\\ No newline at end of file\n";

/** Render one parsed source line as a unified-patch row. */
function patchLine(prefix: " " | "+" | "-", line: string) {
  return line.endsWith("\n") ? `${prefix}${line}` : `${prefix}${line}\n${NO_FINAL_NEWLINE_MARKER}`;
}

/** Read a bounded run of parsed lines or fail when hunk metadata is inconsistent. */
function sourceLines(lines: readonly string[], start: number, count: number, label: string) {
  const selected = lines.slice(start, start + count);
  if (selected.length !== count) {
    throw new Error(`The hunk references ${label} lines outside the parsed patch.`);
  }
  return selected;
}

/** Render one parsed hunk as applicable unified-patch text. */
export function renderMetadataHunk(metadata: FileDiffMetadata, hunk: DiffHunk) {
  const rows: string[] = [`${formatHunkHeader(hunk)}\n`];

  for (const block of hunk.hunkContent) {
    if (block.type === "context") {
      rows.push(
        ...sourceLines(metadata.additionLines, block.additionLineIndex, block.lines, "context").map(
          (line) => patchLine(" ", line),
        ),
      );
      continue;
    }

    rows.push(
      ...sourceLines(
        metadata.deletionLines,
        block.deletionLineIndex,
        block.deletions,
        "deleted",
      ).map((line) => patchLine("-", line)),
      ...sourceLines(metadata.additionLines, block.additionLineIndex, block.additions, "added").map(
        (line) => patchLine("+", line),
      ),
    );
  }

  return rows.join("");
}

/** Render the parsed hunks while preserving the producer's file-level patch headers. */
export function patchWithMetadataHunks(patch: string, metadata: FileDiffMetadata) {
  const firstHunkIndex = patch.search(/^@@ /m);
  if (firstHunkIndex < 0) {
    return patch;
  }

  return `${patch.slice(0, firstHunkIndex)}${metadata.hunks
    .map((hunk) => renderMetadataHunk(metadata, hunk))
    .join("")}`;
}
