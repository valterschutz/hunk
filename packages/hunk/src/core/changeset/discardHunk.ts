import { formatHunkHeader } from "./hunkHeader";
import type { DiffHunk } from "./hunkLayout";
import type { DiffFile } from "./model";

const NO_FINAL_NEWLINE_MARKER = "\\ No newline at end of file\n";

/** Build content-only file headers, without rename or mode changes that belong to the whole file. */
function filePatchHeaders(patch: string) {
  const hunkStart = patch.search(/^@@ /m);
  if (hunkStart < 0) {
    throw new Error("The selected file has no patch hunk header.");
  }

  const headers = patch.slice(0, hunkStart).split(/(?<=\n)/);
  const oldFile = headers.find((line) => line.startsWith("--- "));
  const newFile = headers.find((line) => line.startsWith("+++ "));
  if (!oldFile || !newFile) {
    throw new Error("The selected file has no unified patch file headers.");
  }

  const oldPath = oldFile.slice(4).trimEnd();
  const newPath = newFile.slice(4).trimEnd();
  const changesFileIdentity =
    oldPath !== newPath && oldPath !== "/dev/null" && newPath !== "/dev/null";
  const diff = headers.find((line) => line.startsWith("diff --git ")) ?? "";
  const index = headers.find((line) => line.startsWith("index ")) ?? "";
  const fileMode =
    oldPath === "/dev/null" || newPath === "/dev/null"
      ? (headers.find(
          (line) => line.startsWith("new file mode ") || line.startsWith("deleted file mode "),
        ) ?? "")
      : "";

  return `${changesFileIdentity ? "" : diff}${fileMode}${index}${changesFileIdentity ? `--- ${newFile.slice(4)}` : oldFile}${newFile}`;
}

/** Render one parsed source line as a unified-patch row. */
function patchLine(prefix: " " | "+" | "-", line: string) {
  return line.endsWith("\n") ? `${prefix}${line}` : `${prefix}${line}\n${NO_FINAL_NEWLINE_MARKER}`;
}

/** Read a bounded run of parsed lines or fail when hunk metadata is inconsistent. */
function sourceLines(lines: readonly string[], start: number, count: number, label: string) {
  const selected = lines.slice(start, start + count);
  if (selected.length !== count) {
    throw new Error(`The selected hunk references ${label} lines outside the parsed patch.`);
  }
  return selected;
}

/** Build an applicable one-file patch containing exactly one displayed hunk. */
export function buildSelectedHunkPatch(file: DiffFile, hunk: DiffHunk) {
  const rows: string[] = [filePatchHeaders(file.patch), `${formatHunkHeader(hunk)}\n`];

  for (const block of hunk.hunkContent) {
    if (block.type === "context") {
      rows.push(
        ...sourceLines(
          file.metadata.additionLines,
          block.additionLineIndex,
          block.lines,
          "context",
        ).map((line) => patchLine(" ", line)),
      );
      continue;
    }

    rows.push(
      ...sourceLines(
        file.metadata.deletionLines,
        block.deletionLineIndex,
        block.deletions,
        "deleted",
      ).map((line) => patchLine("-", line)),
      ...sourceLines(
        file.metadata.additionLines,
        block.additionLineIndex,
        block.additions,
        "added",
      ).map((line) => patchLine("+", line)),
    );
  }

  return rows.join("");
}
