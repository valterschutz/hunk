import { useCallback } from "react";
import { diffHunkIdentity } from "../../core/changeset/hunkDecisions";
import type { DiffFile } from "../../core/changeset/model";
import type { ReviewFileStore } from "../../core/process/reviewFileStore";
import type { ExtensionDialogs } from "../../extension-api/types";

/** Approve original review units from file/menu commands without letting view filters narrow scope. */
export function useBulkHunkApproval({
  files,
  selectedFileId,
  repo,
  store,
  dialogs,
  refresh,
  notice,
}: {
  files: readonly DiffFile[];
  selectedFileId: string | undefined;
  repo: string;
  store: ReviewFileStore;
  dialogs: ExtensionDialogs;
  refresh: () => void;
  notice: (message: string) => void;
}) {
  /** Persist a scope in one batch; the store preserves decisions from its fresh read. */
  const approve = useCallback(
    (scope: readonly DiffFile[]) => {
      try {
        const count = store.acceptUndecidedHunks(
          scope.flatMap((file) =>
            file.metadata.hunks.map((hunk) => ({
              id: diffHunkIdentity(file, hunk),
              repo,
              path: file.path,
              oldStart: hunk.deletionStart,
              newStart: hunk.additionStart,
            })),
          ),
        );
        refresh();
        notice(`Approved ${count} undecided review unit${count === 1 ? "" : "s"}`);
      } catch (error) {
        notice(
          `Could not update the review file: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    [store, repo, refresh, notice],
  );

  /** Refuse both actions before opening a prompt when persistence is disabled. */
  const enabled = useCallback(() => {
    if (store.enabled) return true;
    notice("Set review_file in your config to approve hunks");
    return false;
  }, [store, notice]);

  const approveFile = useCallback(() => {
    if (!enabled()) return;
    const file = files.find((candidate) => candidate.id === selectedFileId);
    if (!file) {
      notice("No file selected");
      return;
    }
    approve([file]);
  }, [enabled, files, selectedFileId, notice, approve]);

  const approveReview = useCallback(async () => {
    if (!enabled()) return;
    if (
      await dialogs.confirm({
        title: "Approve entire review?",
        body: "Approve all undecided hunks, including hidden hunks. Existing decisions stay unchanged.",
      })
    )
      approve(files);
  }, [enabled, dialogs, approve, files]);

  return { approveFile, approveReview };
}
