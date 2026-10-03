import { useCallback, useMemo, useState } from "react";
import { buildSelectedHunkPatch } from "../../core/changeset/discardHunk";
import type { DiffFile } from "../../core/changeset/model";
import type { CliInput } from "../../core/run/commandInputs";
import { canDiscardVcsHunk, discardVcsHunk } from "../../core/vcs";
import type { VcsCatalog } from "../../core/vcs/types";
import type { ExtensionDialogs } from "../../extension-api/types";
import type { DiffHunk } from "../../core/changeset/hunkLayout";

export interface DiscardSelectedHunkController {
  canDiscardSelectedHunk: boolean;
  discardSelectedHunk: () => void;
}

/** Confirm and discard one selected hunk through the provider that loaded current changes. */
export function useDiscardSelectedHunk({
  catalog,
  cwd,
  dialogs,
  file,
  hunk,
  input,
  refresh,
  showNotice,
  unitLabel,
}: {
  catalog?: VcsCatalog;
  cwd: string;
  dialogs: ExtensionDialogs;
  file: DiffFile | undefined;
  hunk: DiffHunk | undefined;
  input: CliInput;
  refresh: () => Promise<void>;
  showNotice: (message: string) => void;
  unitLabel: "hunk" | "line";
}): DiscardSelectedHunkController {
  const [discarding, setDiscarding] = useState(false);
  const supported =
    input.kind === "vcs" && catalog !== undefined && canDiscardVcsHunk(input, catalog);
  const canDiscardSelectedHunk =
    supported && file !== undefined && hunk !== undefined && !discarding;

  const confirmation = useMemo(() => {
    if (input.kind !== "vcs") return "";
    return input.staged
      ? `This removes the ${unitLabel} from the index. Your working tree is unchanged.`
      : `This reverts the ${unitLabel} in your working tree. This cannot be undone.`;
  }, [input, unitLabel]);

  const discardSelectedHunk = useCallback(() => {
    if (
      input.kind !== "vcs" ||
      catalog === undefined ||
      file === undefined ||
      hunk === undefined ||
      discarding
    ) {
      return;
    }

    let patchText: string;
    try {
      patchText = buildSelectedHunkPatch(file, hunk);
    } catch (error) {
      showNotice(
        `Could not prepare selected ${unitLabel}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    setDiscarding(true);
    void dialogs
      .confirm({
        title: `Discard selected ${unitLabel}?`,
        body: confirmation,
        confirmLabel: "discard",
      })
      .then(async (confirmed) => {
        if (!confirmed) {
          setDiscarding(false);
          return;
        }

        try {
          await discardVcsHunk(input, patchText, { cwd }, catalog);
          showNotice(
            input.staged
              ? `Removed selected ${unitLabel} from the index`
              : `Discarded selected ${unitLabel}`,
          );
          setDiscarding(false);
          await refresh();
        } catch (error) {
          setDiscarding(false);
          showNotice(
            `Could not discard selected ${unitLabel}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      });
  }, [
    catalog,
    confirmation,
    cwd,
    dialogs,
    discarding,
    file,
    hunk,
    input,
    refresh,
    showNotice,
    unitLabel,
  ]);

  return { canDiscardSelectedHunk, discardSelectedHunk };
}
