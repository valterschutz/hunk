/**
 * Owns the synced review file: hunk decisions, addressable hunk text, and the reviewer's notes.
 *
 * The file is JSON Lines (`core/review/reviewFile.ts` defines the records) so any file syncing
 * tool carries it between machines; it is re-read before every write so entries added
 * elsewhere in the meantime survive, and written through a rename so a sync tool never sees
 * a half-written file. After every change the derived `commit-status` file beside it is
 * rewritten for lazygit. An unconfigured path disables the store: it then loads nothing and
 * refuses to write.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import {
  commitStatuses,
  parseReviewRecord,
  serializeCommitStatuses,
  serializeReviewRecords,
  type HunkDecision,
  type HunkRecord,
  type PersistableNotes,
  type ReviewRecord,
} from "../../core/review/reviewFile";

export const COMMIT_STATUS_FILE_NAME = "commit-status";

export interface ReviewFileLoad {
  records: ReviewRecord[];
  /** One message per line that could not be parsed; the line is left in place on write. */
  warnings: string[];
}

export interface HunkDecisionInput {
  hunk: Omit<HunkRecord, "kind" | "state" | "lines"> & { lines: string[] };
  /** Undefined clears the decision. */
  state: HunkDecision | undefined;
  /** The single commit under review, when there is one, so its status can be derived. */
  commit?: { hash: string; hunkCount: number };
}

export interface ReviewFileStore {
  /** Whether a file is configured, and so whether writes may be attempted. */
  readonly enabled: boolean;
  readonly path: string | undefined;
  load(): ReviewFileLoad;
  /** Record, change, or clear the decision on one hunk and refresh the commit statuses. */
  setHunkDecision(input: HunkDecisionInput): void;
  /** Replace the given note records and add their hunks when missing; true when the file changed. */
  upsertNotes(notes: PersistableNotes): boolean;
  /** Remove note records by id, dropping hunk records nothing references any more. */
  removeNotes(noteIds: readonly string[]): boolean;
}

/** Expand a leading `~` to the home directory, the form config paths are written in. */
export function expandReviewFilePath(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
}

/** Render a path with the home directory shortened to `~`, the form the file stores repos in. */
export function collapseHomePath(path: string): string {
  const home = homedir();
  const absolute = resolve(path);
  if (absolute === home) return "~";
  return absolute.startsWith(`${home}${sep}`) ? `~/${absolute.slice(home.length + 1)}` : absolute;
}

interface ParsedFile {
  records: ReviewRecord[];
  warnings: string[];
  /** Lines that failed to parse, kept verbatim so a write never destroys them. */
  unparsed: string[];
  text: string;
}

function readFile(path: string): ParsedFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], warnings: [], unparsed: [], text: "" };
    }
    throw error;
  }
  const records: ReviewRecord[] = [];
  const warnings: string[] = [];
  const unparsed: string[] = [];
  text.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) return;
    try {
      records.push(parseReviewRecord(line));
    } catch (error) {
      warnings.push(`${path}:${index + 1}: ${error instanceof Error ? error.message : error}`);
      unparsed.push(line);
    }
  });
  return { records, warnings, unparsed, text };
}

function writeAtomically(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  writeFileSync(temporaryPath, content, "utf8");
  renameSync(temporaryPath, path);
}

/** Whether a hunk's text must stay in the file: only while it may still be addressed. */
function keepsLines(state: HunkDecision | undefined) {
  return state === "rejected" || state === "addressed";
}

/** Build the store behind one configured path; undefined or empty disables it. */
export function createReviewFileStore(configuredPath: string | undefined): ReviewFileStore {
  const path =
    configuredPath && configuredPath.length > 0
      ? resolve(expandReviewFilePath(configuredPath))
      : undefined;

  const requirePath = () => {
    if (path === undefined) {
      throw new Error("Cannot write review decisions without a configured review_file");
    }
    return path;
  };

  /** Write the records (plus any unparsed lines) and the derived statuses, if either changed. */
  const commit = (file: ParsedFile, records: ReviewRecord[]): boolean => {
    const target = requirePath();
    const preserved = file.unparsed.length > 0 ? `${file.unparsed.join("\n")}\n` : "";
    const content = `${serializeReviewRecords(records)}${preserved}`;
    let changed = false;
    if (content !== file.text) {
      writeAtomically(target, content);
      changed = true;
    }
    const statusPath = join(dirname(target), COMMIT_STATUS_FILE_NAME);
    const statusContent = serializeCommitStatuses(commitStatuses(records));
    let currentStatus: string | undefined;
    try {
      currentStatus = readFileSync(statusPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (currentStatus !== statusContent) {
      writeAtomically(statusPath, statusContent);
    }
    return changed;
  };

  const noteReferences = (records: readonly ReviewRecord[]) => {
    const referenced = new Set<string>();
    for (const record of records) {
      if (record.kind === "note") referenced.add(record.hunk);
    }
    return referenced;
  };

  return {
    enabled: path !== undefined,
    path,
    load() {
      if (path === undefined) return { records: [], warnings: [] };
      const { records, warnings } = readFile(path);
      return { records, warnings };
    },
    setHunkDecision({ hunk, state, commit: reviewedCommit }) {
      const file = readFile(requirePath());
      const records = file.records.filter(
        (record) => !(record.kind === "hunk" && record.id === hunk.id),
      );
      const existing = file.records.find(
        (record): record is HunkRecord => record.kind === "hunk" && record.id === hunk.id,
      );
      const referenced = noteReferences(records).has(hunk.id);
      if (state !== undefined || referenced) {
        const commitHash = hunk.commit ?? existing?.commit;
        records.push({
          kind: "hunk",
          id: hunk.id,
          repo: hunk.repo,
          path: hunk.path,
          ...(state !== undefined ? { state } : {}),
          ...(commitHash !== undefined ? { commit: commitHash } : {}),
          oldStart: hunk.oldStart,
          newStart: hunk.newStart,
          ...(keepsLines(state) ? { lines: [...hunk.lines] } : {}),
        });
      }
      if (reviewedCommit) {
        const index = records.findIndex(
          (record) => record.kind === "commit" && record.hash === reviewedCommit.hash,
        );
        const record = {
          kind: "commit" as const,
          repo: hunk.repo,
          hash: reviewedCommit.hash,
          hunkCount: reviewedCommit.hunkCount,
        };
        if (index >= 0) records[index] = record;
        else records.push(record);
      }
      commit(file, records);
    },
    upsertNotes(notes) {
      const file = readFile(requirePath());
      const noteIds = new Set(notes.notes.map((record) => record.id));
      const hunkIds = new Set(file.records.filter((r) => r.kind === "hunk").map((r) => r.id));
      const records = file.records.filter(
        (record) => !(record.kind === "note" && noteIds.has(record.id)),
      );
      records.push(...notes.notes);
      for (const hunk of notes.hunks) {
        if (hunkIds.has(hunk.id)) continue;
        const { lines: _lines, ...withoutLines } = hunk;
        records.push(withoutLines);
      }
      return commit(file, records);
    },
    removeNotes(noteIds) {
      const file = readFile(requirePath());
      const removed = new Set(noteIds);
      let records = file.records.filter(
        (record) => !(record.kind === "note" && removed.has(record.id)),
      );
      const referenced = noteReferences(records);
      records = records.filter(
        (record) =>
          record.kind !== "hunk" || record.state !== undefined || referenced.has(record.id),
      );
      return commit(file, records);
    },
  };
}
