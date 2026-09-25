/** Projects parsed diffs into the review unit selected for the current session. */
import { splitHunksAtChangedLines } from "./changeGroups";
import type { DiffFile } from "./model";
import { patchWithMetadataHunks } from "./patchHunks";

export type ReviewUnit = "hunk" | "line";

/** Keep standard patch hunks, or make each changed split-view row independently selectable. */
export function projectDiffFilesToReviewUnits(
  files: DiffFile[],
  reviewUnit: ReviewUnit,
): DiffFile[] {
  if (reviewUnit === "hunk") return files;

  return files.map((file) => {
    const metadata = splitHunksAtChangedLines(file.metadata);
    if (metadata === file.metadata) return file;
    return {
      ...file,
      metadata,
      patch: patchWithMetadataHunks(file.patch, metadata),
    };
  });
}
