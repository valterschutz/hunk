/**
 * Prints the open rejections of one repository from the review file, without a review.
 *
 * `hunk address --list` is the text overview of what is left to address: each rejected hunk
 * with its first changed line and the notes written beside it, grouped by path. `--json`
 * emits the records themselves for scripts and agents, and `--all` includes rejections
 * already marked addressed.
 */
import { openRejections, type OpenRejection } from "../core/review/addressPatch";
import { collapseHomePath, createReviewFileStore } from "../core/process/reviewFileStore";
import { resolveAddressRepoRoot } from "../core/changeset/loaders";
import type { AddressListCommandInput } from "../core/run/commandInputs";
import type { NoteRecord } from "../core/review/reviewFile";
import type { VcsCatalog } from "../core/vcs/types";

export interface AddressCommandIo {
  cwd: string;
  vcsCatalog: VcsCatalog;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** The first changed line of a hunk, additions first, as the one-line description of it. */
function headline(lines: readonly string[]): string {
  const added = lines.find((line) => line.startsWith("+"));
  const removed = lines.find((line) => line.startsWith("-"));
  return (added ?? removed ?? lines[0] ?? "").slice(1).trim();
}

function noteLabel(note: NoteRecord) {
  return note.author ?? note.source;
}

/** Render one rejection as its location, headline, and notes, indented by thread depth. */
function renderRejection({ hunk, notes }: OpenRejection): string[] {
  const state = hunk.state === "addressed" ? "  (addressed)" : "";
  const lines = [`${hunk.path}:${hunk.newStart}  ${headline(hunk.lines ?? [])}${state}`];
  for (const note of notes) {
    const marker = note.parentId ? "↳ " : "";
    const body = [note.summary, note.rationale].filter(Boolean).join("\n");
    const [first = "", ...rest] = body.split("\n");
    lines.push(`    ${marker}[${noteLabel(note)}] ${first}`);
    for (const continuation of rest) {
      lines.push(`    ${" ".repeat(marker.length)}${continuation}`);
    }
  }
  return lines;
}

/** Run `hunk address --list` and return the process exit code. */
export function runAddressListCommand(input: AddressListCommandInput, io: AddressCommandIo): number {
  const store = createReviewFileStore(input.options.reviewFile);
  if (!store.enabled) {
    io.stderr("Set review_file in your config before running `hunk address --list`.\n");
    return 1;
  }
  const repo = collapseHomePath(resolveAddressRepoRoot(input, io.cwd, io.vcsCatalog));
  const { records, warnings } = store.load();
  for (const warning of warnings) {
    io.stderr(`Skipped a malformed review record: ${warning}\n`);
  }
  const rejections = openRejections(records, { repo, includeAddressed: input.all });

  if (input.json) {
    io.stdout(`${JSON.stringify({ repo, rejections }, null, 2)}\n`);
    return 0;
  }
  if (rejections.length === 0) {
    io.stdout(`Nothing to address in ${repo}.\n`);
    return 0;
  }
  const blocks = rejections.map((rejection) => renderRejection(rejection).join("\n"));
  io.stdout(`${blocks.join("\n\n")}\n`);
  return 0;
}
