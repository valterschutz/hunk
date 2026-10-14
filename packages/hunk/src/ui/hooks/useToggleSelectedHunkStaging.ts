import { useCallback, useState } from "react";
import type { DiffHunk } from "../../core/changeset/hunkLayout";
import type { DiffFile } from "../../core/changeset/model";
import { containingPatchHunk, hunkStagingState, hunkTarget } from "../../core/changeset/staging";
import type { CliInput } from "../../core/run/commandInputs";
import { canStageVcsHunk, stageVcsHunk } from "../../core/vcs";
import type { VcsCatalog } from "../../core/vcs/types";

export interface ToggleSelectedHunkStagingController {
  toggleSelectedHunkStaging: () => void;
}

/**
 * Stage or unstage the selected hunk of a staging-aware working-copy review, then reload it.
 *
 * Space reaches this from the review stream and from the menu. A staged hunk is unstaged; an
 * unstaged or partly staged one is staged in full. Staging stays per hunk in line review: the
 * selected line unit acts through the patch hunk it was split from, which `patchFile` holds.
 * Every other review reports that it has nothing to stage instead of silently ignoring the key.
 */
export function useToggleSelectedHunkStaging({
  catalog,
  cwd,
  file,
  hunk,
  input,
  patchFile,
  refresh,
  showNotice,
}: {
  catalog?: VcsCatalog;
  cwd: string;
  file: DiffFile | undefined;
  hunk: DiffHunk | undefined;
  input: CliInput;
  /** The selected file as the patch described it, before line review split its hunks. */
  patchFile: DiffFile | undefined;
  refresh: () => Promise<void>;
  showNotice: (message: string) => void;
}): ToggleSelectedHunkStagingController {
  const [toggling, setToggling] = useState(false);

  const toggleSelectedHunkStaging = useCallback(() => {
    if (toggling) return;
    if (
      input.kind !== "vcs" ||
      catalog === undefined ||
      !canStageVcsHunk(input, catalog) ||
      !file?.staging
    ) {
      showNotice("Nothing to stage in this review");
      return;
    }
    if (!hunk) {
      showNotice("Select a hunk to stage");
      return;
    }

    const patchHunk = containingPatchHunk(patchFile ?? file, hunk);
    const action = hunkStagingState(file.staging, patchHunk) === "staged" ? "unstage" : "stage";
    setToggling(true);
    void (async () => {
      try {
        await stageVcsHunk(input, hunkTarget(file, patchHunk), action, { cwd }, catalog);
        showNotice(action === "stage" ? "Staged hunk" : "Unstaged hunk");
        setToggling(false);
        await refresh();
      } catch (error) {
        setToggling(false);
        showNotice(
          `Could not ${action} hunk: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })();
  }, [catalog, cwd, file, hunk, input, patchFile, refresh, showNotice, toggling]);

  return { toggleSelectedHunkStaging };
}
