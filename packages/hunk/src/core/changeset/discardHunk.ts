import type { DiffHunk } from "./hunkLayout";
import type { DiffFile } from "./model";
import { renderMetadataHunk } from "./patchHunks";

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

/** Build an applicable one-file patch containing exactly one displayed hunk. */
export function buildSelectedHunkPatch(file: DiffFile, hunk: DiffHunk) {
  return `${filePatchHeaders(file.patch)}${renderMetadataHunk(file.metadata, hunk)}`;
}
