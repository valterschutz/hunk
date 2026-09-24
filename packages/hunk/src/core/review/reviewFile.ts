/**
 * Defines the records of the synced review file and the pure conversions around them.
 *
 * The file keeps three things a reviewer produces while reading a commit hunk by hunk: the
 * decision on each hunk (accepted, rejected, or rejected-then-fixed) and the notes written
 * beside those hunks. Everything hangs off the hunk
 * content identity (`hunkIdentity.ts`), never off line numbers, so a rebase keeps decisions and
 * notes and a sync tool can carry the file between machines.
 *
 * A `review` record remembers which hunks one commit or commit range showed, by content identity.
 * A commit's status follows from the decisions on those hunks wherever they were made (in this
 * review, a review of an overlapping range, or the working tree before committing): reviewed once
 * every hunk is decided, and approved once no rejection remains open. Lazygit reads the result.
 *
 * This module does no I/O; `ui/lib/reviewFileStore.ts` owns the file.
 */
import { resolveReviewNoteAnchor } from "./anchors";
import { HUNK_DECISIONS, type HunkDecision } from "./hunkStates";
import { isHunkIdentity, reviewHunkIdentity, stripLineEnding } from "./hunkIdentity";
import { reviewNoteAnchorLine, reviewNoteOwnerHunkIndex, type ReviewStoredNote } from "./state";
import type {
  ReviewDocumentV1,
  ReviewFileV1,
  ReviewHunkV1,
  ReviewLineRange,
  ReviewNoteV1,
  ReviewSide,
} from "./types";

export { HUNK_DECISIONS, HUNK_STATES, type HunkDecision, type HunkState } from "./hunkStates";

/** A commit's derived status; a commit with an undecided hunk has none. */
export type CommitStatus = "reviewed" | "approved";

/** The hunks one reviewed commit or aggregate commit range showed. */
export interface CommitReviewRecord {
  kind: "review";
  repo: string;
  /** The commits the review covers, sorted; an aggregate range names several. */
  commits: string[];
  /** Content identity of every hunk the review showed, sorted. */
  hunks: string[];
}

/** One hunk the reviewer decided on or wrote a note beside. */
export interface HunkRecord {
  kind: "hunk";
  /** Content identity, see `reviewHunkIdentity`. */
  id: string;
  repo: string;
  path: string;
  state?: HunkDecision;
  oldStart: number;
  newStart: number;
}

/** One note of a thread the reviewer started, anchored inside its hunk. */
export interface NoteRecord {
  kind: "note";
  id: string;
  parentId?: string;
  source: ReviewNoteV1["source"];
  originalSource?: string;
  summary: string;
  rationale?: string;
  markup?: string;
  title?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  editable: boolean;
  tags?: string[];
  confidence?: ReviewNoteV1["confidence"];
  /** Identity of the hunk that owns the note. */
  hunk: string;
  side: ReviewSide;
  /** 0-based row offset of the anchored line within the hunk on `side`. */
  offset: number;
  /** Rows the note's range spans on `side`, at least 1. */
  length: number;
  /** The anchored line as last seen, for listings that have no diff to show. */
  line: number;
  lineText: string;
}

export type ReviewRecord = CommitReviewRecord | HunkRecord | NoteRecord;

/**
 * A record of the format that counted decisions per commit instead of naming hunks. It exists only
 * between parsing and `migrateLegacyRecords`, which converts or drops it.
 */
export interface LegacyCommitRecord {
  kind: "legacyCommit";
  repo: string;
  hash: string;
  hunkCount: number;
}

/** The commits a legacy hunk record was decided under, kept only for `migrateLegacyRecords`. */
export interface LegacyHunkAttribution {
  kind: "legacyAttribution";
  hunk: string;
  commits: string[];
}

export type ParsedReviewRecord = ReviewRecord | LegacyCommitRecord | LegacyHunkAttribution;

const NOTE_SOURCES = new Set<ReviewNoteV1["source"]>(["ai", "agent", "user"]);
const NOTE_CONFIDENCES = new Set(["low", "medium", "high"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`review record field "${key}" must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(`review record field "${key}" must be a string`);
  }
  return value;
}

function requireInteger(record: Record<string, unknown>, key: string, minimum: number): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`review record field "${key}" must be an integer of at least ${minimum}`);
  }
  return value as number;
}

function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`review record field "${key}" must be an array of strings`);
  }
  return [...(value as string[])];
}

function requireUniqueStrings(record: Record<string, unknown>, key: string): string[] {
  const values = optionalStringArray(record, key);
  if (
    values === undefined ||
    values.some((value) => value.length === 0) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`review record field "${key}" must be an array of unique non-empty strings`);
  }
  return values;
}

/**
 * Parse one line of the review file, throwing a descriptive error for a malformed record.
 *
 * A line in the legacy format yields its legacy records next to (or instead of) current ones.
 */
export function parseReviewRecord(line: string): ParsedReviewRecord[] {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`review record is not JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!isPlainObject(value)) {
    throw new Error("review record must be a JSON object");
  }
  switch (value.kind) {
    case "review": {
      const hunks = requireUniqueStrings(value, "hunks");
      const invalid = hunks.find((hunk) => !isHunkIdentity(hunk));
      if (invalid !== undefined) {
        throw new Error(`review record hunk ${JSON.stringify(invalid)} is not a hunk identity`);
      }
      const commits = requireUniqueStrings(value, "commits");
      if (commits.length === 0) {
        throw new Error('review record field "commits" must name at least one commit');
      }
      return [
        {
          kind: "review",
          repo: requireString(value, "repo"),
          commits: commits.toSorted(),
          hunks: hunks.toSorted(),
        },
      ];
    }
    case "commit":
      return [
        {
          kind: "legacyCommit",
          repo: requireString(value, "repo"),
          hash: requireString(value, "hash"),
          hunkCount: requireInteger(value, "hunkCount", 0),
        },
      ];
    case "hunk": {
      const id = requireString(value, "id");
      if (!isHunkIdentity(id)) {
        throw new Error(`review hunk record id ${JSON.stringify(id)} is not a hunk identity`);
      }
      const storedState = optionalString(value, "state");
      const state = storedState === "addressed" ? "fixed" : storedState;
      if (state !== undefined && !HUNK_DECISIONS.includes(state as HunkDecision)) {
        throw new Error(`review hunk record state ${JSON.stringify(state)} is not a decision`);
      }
      const legacyCommit = optionalString(value, "commit");
      const legacyCommits =
        value.commits !== undefined
          ? requireUniqueStrings(value, "commits")
          : legacyCommit === undefined
            ? undefined
            : [legacyCommit];
      const hunk: HunkRecord = {
        kind: "hunk",
        id,
        repo: requireString(value, "repo"),
        path: requireString(value, "path"),
        ...(state !== undefined ? { state: state as HunkDecision } : {}),
        oldStart: requireInteger(value, "oldStart", 0),
        newStart: requireInteger(value, "newStart", 0),
      };
      return legacyCommits === undefined
        ? [hunk]
        : [hunk, { kind: "legacyAttribution", hunk: id, commits: legacyCommits }];
    }
    case "note": {
      const source = requireString(value, "source");
      if (!NOTE_SOURCES.has(source as ReviewNoteV1["source"])) {
        throw new Error(`review note record source ${JSON.stringify(source)} is unknown`);
      }
      const side = requireString(value, "side");
      if (side !== "old" && side !== "new") {
        throw new Error(`review note record side ${JSON.stringify(side)} must be old or new`);
      }
      const hunk = requireString(value, "hunk");
      if (!isHunkIdentity(hunk)) {
        throw new Error(`review note record hunk ${JSON.stringify(hunk)} is not a hunk identity`);
      }
      const editable = value.editable;
      if (typeof editable !== "boolean") {
        throw new Error('review note record field "editable" must be a boolean');
      }
      const confidence = optionalString(value, "confidence");
      if (confidence !== undefined && !NOTE_CONFIDENCES.has(confidence)) {
        throw new Error(`review note record confidence ${JSON.stringify(confidence)} is unknown`);
      }
      const summary = value.summary;
      if (typeof summary !== "string") {
        throw new Error('review note record field "summary" must be a string');
      }
      const lineText = value.lineText;
      if (typeof lineText !== "string") {
        throw new Error('review note record field "lineText" must be a string');
      }
      const optional = {
        parentId: optionalString(value, "parentId"),
        originalSource: optionalString(value, "originalSource"),
        rationale: optionalString(value, "rationale"),
        markup: optionalString(value, "markup"),
        title: optionalString(value, "title"),
        author: optionalString(value, "author"),
        createdAt: optionalString(value, "createdAt"),
        updatedAt: optionalString(value, "updatedAt"),
        tags: optionalStringArray(value, "tags"),
        confidence: confidence as NoteRecord["confidence"],
      };
      return [
        withoutUndefined({
          kind: "note",
          id: requireString(value, "id"),
          parentId: optional.parentId,
          source: source as ReviewNoteV1["source"],
          originalSource: optional.originalSource,
          summary,
          rationale: optional.rationale,
          markup: optional.markup,
          title: optional.title,
          author: optional.author,
          createdAt: optional.createdAt,
          updatedAt: optional.updatedAt,
          editable,
          tags: optional.tags,
          confidence: optional.confidence,
          hunk,
          side,
          offset: requireInteger(value, "offset", 0),
          length: requireInteger(value, "length", 1),
          line: requireInteger(value, "line", 0),
          lineText,
        }) as NoteRecord,
      ];
    }
    default:
      throw new Error(`review record kind ${JSON.stringify(value.kind)} is unknown`);
  }
}

/**
 * Convert legacy records into current ones.
 *
 * A legacy commit whose attributed decisions were complete becomes a single-commit review of
 * those decided hunks, so its status survives. An incomplete one is dropped: it never named its
 * undecided hunks, and reopening the commit or range records them.
 */
export function migrateLegacyRecords(parsed: readonly ParsedReviewRecord[]): ReviewRecord[] {
  const decided = new Set<string>();
  for (const record of parsed) {
    if (record.kind === "hunk" && record.state !== undefined) decided.add(record.id);
  }
  const decidedByCommit = new Map<string, Set<string>>();
  for (const record of parsed) {
    if (record.kind !== "legacyAttribution" || !decided.has(record.hunk)) continue;
    for (const commit of record.commits) {
      const hunks = decidedByCommit.get(commit) ?? new Set<string>();
      hunks.add(record.hunk);
      decidedByCommit.set(commit, hunks);
    }
  }
  const records: ReviewRecord[] = [];
  for (const record of parsed) {
    if (record.kind === "legacyAttribution") continue;
    if (record.kind !== "legacyCommit") {
      records.push(record);
      continue;
    }
    const hunks = decidedByCommit.get(record.hash) ?? new Set<string>();
    if (hunks.size === 0 || hunks.size < record.hunkCount) continue;
    records.push({
      kind: "review",
      repo: record.repo,
      commits: [record.hash],
      hunks: [...hunks].toSorted(),
    });
  }
  return records;
}

/** Drop undefined fields so serialized records carry only what is set. */
function withoutUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

const RECORD_KEY_ORDER: Record<ReviewRecord["kind"], readonly string[]> = {
  review: ["kind", "repo", "commits", "hunks"],
  hunk: ["kind", "id", "repo", "path", "state", "oldStart", "newStart"],
  note: [
    "kind",
    "id",
    "parentId",
    "source",
    "originalSource",
    "summary",
    "rationale",
    "markup",
    "title",
    "author",
    "createdAt",
    "updatedAt",
    "editable",
    "tags",
    "confidence",
    "hunk",
    "side",
    "offset",
    "length",
    "line",
    "lineText",
  ],
};

/** Order a record's fields canonically, so equal records serialize to equal lines. */
function canonicalRecord(record: ReviewRecord): Record<string, unknown> {
  const source = record as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};
  for (const key of RECORD_KEY_ORDER[record.kind]) {
    if (source[key] !== undefined) ordered[key] = source[key];
  }
  return ordered;
}

function recordOrder(record: ReviewRecord): [number, string, string] {
  switch (record.kind) {
    case "review":
      return [0, record.repo, record.commits.join(" ")];
    case "hunk":
      return [1, record.id, ""];
    case "note":
      return [2, record.createdAt ?? "", record.id];
  }
}

function compareRecords(left: ReviewRecord, right: ReviewRecord) {
  const [leftKind, leftA, leftB] = recordOrder(left);
  const [rightKind, rightA, rightB] = recordOrder(right);
  if (leftKind !== rightKind) return leftKind - rightKind;
  if (leftA !== rightA) return leftA < rightA ? -1 : 1;
  if (leftB !== rightB) return leftB < rightB ? -1 : 1;
  return 0;
}

/** Serialize records as sorted JSON Lines, so the file only changes when its content does. */
export function serializeReviewRecords(records: readonly ReviewRecord[]): string {
  const lines = [...records]
    .toSorted(compareRecords)
    .map((record) => JSON.stringify(canonicalRecord(record)));
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Whether two records name the same review: the same commits of the same repository. */
export function sameCommitReview(left: CommitReviewRecord, right: CommitReviewRecord): boolean {
  return left.repo === right.repo && left.commits.join(" ") === right.commits.join(" ");
}

const STATUS_RANK: Record<CommitStatus, number> = { reviewed: 1, approved: 2 };

/**
 * Derive each reviewed commit's status from the decisions on its reviews' hunks.
 *
 * A commit several reviews cover (alone and inside a range, say) takes the best status any of them
 * reaches, so opening a wider range never takes away an approval.
 */
export function commitStatuses(records: readonly ReviewRecord[]): Map<string, CommitStatus> {
  const decisions = new Map<string, HunkDecision>();
  for (const record of records) {
    if (record.kind === "hunk" && record.state !== undefined)
      decisions.set(record.id, record.state);
  }
  const statuses = new Map<string, CommitStatus>();
  for (const record of records) {
    if (record.kind !== "review" || record.hunks.length === 0) continue;
    const states = record.hunks.map((hunk) => decisions.get(hunk));
    if (states.includes(undefined)) continue;
    const status: CommitStatus = states.includes("rejected") ? "reviewed" : "approved";
    for (const commit of record.commits) {
      const current = statuses.get(commit);
      if (current === undefined || STATUS_RANK[status] > STATUS_RANK[current]) {
        statuses.set(commit, status);
      }
    }
  }
  return statuses;
}

/** Render the derived commit statuses as the `<hash> <status>` lines lazygit reads. */
export function serializeCommitStatuses(statuses: ReadonlyMap<string, CommitStatus>): string {
  const lines = [...statuses.entries()]
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([hash, status]) => `${hash} ${status}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** The rows one hunk shows on one side, in file order. */
function hunkSideLines(file: ReviewFileV1, hunk: ReviewHunkV1, side: ReviewSide): string[] {
  const texts = side === "new" ? file.additionLines : file.deletionLines;
  const rows: string[] = [];
  for (const block of hunk.hunkContent) {
    const count =
      block.type === "context" ? block.lines : side === "new" ? block.additions : block.deletions;
    const index = side === "new" ? block.additionLineIndex : block.deletionLineIndex;
    for (let offset = 0; offset < count; offset += 1) {
      const text = texts[index + offset];
      if (text === undefined) {
        throw new Error(`Hunk in ${file.path} references a ${side}-side line outside its patch`);
      }
      rows.push(stripLineEnding(text));
    }
  }
  return rows;
}

function hunkSideStart(hunk: ReviewHunkV1, side: ReviewSide) {
  return side === "new" ? hunk.additionStart : hunk.deletionStart;
}

/** The root of a thread, found by walking parent links; a missing parent ends the walk. */
function threadRoot(note: ReviewNoteV1, byId: ReadonlyMap<string, ReviewNoteV1>): ReviewNoteV1 {
  let current = note;
  const seen = new Set<string>();
  while (current.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

/** Whether a stored note belongs to a thread the reviewer started. */
export function isUserRootedNote(
  note: ReviewNoteV1,
  byId: ReadonlyMap<string, ReviewNoteV1>,
): boolean {
  return threadRoot(note, byId).source === "user";
}

export interface PersistableNotes {
  notes: NoteRecord[];
  /** The content-identified hunks the notes hang from; decision fields are left to the store. */
  hunks: HunkRecord[];
}

/**
 * Convert the user-rooted threads of one review into records.
 *
 * A note whose line lies outside its owner hunk (an expanded-gap note) has no offset inside
 * the hunk and is left unpersisted; the hunk's content identity finds it after a reload.
 */
export function persistableNoteRecords(
  document: ReviewDocumentV1,
  notes: readonly ReviewStoredNote[],
  context: { repo: string },
): PersistableNotes {
  const byId = new Map(notes.map((entry) => [entry.note.id, entry.note] as const));
  const fileByKey = new Map(document.files.map((file) => [file.key, file] as const));
  const hunks = new Map<string, HunkRecord>();
  const records: NoteRecord[] = [];

  for (const { note } of notes) {
    if (!isUserRootedNote(note, byId)) continue;
    const file = fileByKey.get(note.fileKey);
    if (!file) continue;
    const hunkIndex = reviewNoteOwnerHunkIndex(note);
    const hunk = file.hunks[hunkIndex];
    if (!hunk) continue;
    const placement = reviewNoteAnchorLine(note);
    const rows = hunkSideLines(file, hunk, placement.side);
    const offset = placement.line - hunkSideStart(hunk, placement.side);
    const lineText = rows[offset];
    if (lineText === undefined) continue;
    const range = placement.side === "new" ? note.anchor.newRange : note.anchor.oldRange;
    const length = range ? Math.max(1, range[1] - range[0] + 1) : 1;
    const identity = reviewHunkIdentity(file, hunk);
    if (!hunks.has(identity)) {
      hunks.set(identity, {
        kind: "hunk",
        id: identity,
        repo: context.repo,
        path: file.path,
        oldStart: hunk.deletionStart,
        newStart: hunk.additionStart,
      });
    }
    records.push(
      withoutUndefined({
        kind: "note",
        id: note.id,
        parentId: note.parentId,
        source: note.source,
        originalSource: note.originalSource,
        summary: note.summary,
        rationale: note.rationale,
        markup: note.markup,
        title: note.title,
        author: note.author,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        editable: note.editable,
        tags: note.tags,
        confidence: note.confidence,
        hunk: identity,
        side: placement.side,
        offset,
        length,
        line: placement.line,
        lineText,
      }) as NoteRecord,
    );
  }
  return { notes: records, hunks: [...hunks.values()] };
}

/** Index every hunk of a document by its content identity. */
export function indexReviewHunks(document: ReviewDocumentV1) {
  const byIdentity = new Map<
    string,
    { file: ReviewFileV1; hunk: ReviewHunkV1; hunkIndex: number }
  >();
  for (const file of document.files) {
    file.hunks.forEach((hunk, hunkIndex) => {
      const identity = reviewHunkIdentity(file, hunk);
      if (!byIdentity.has(identity)) byIdentity.set(identity, { file, hunk, hunkIndex });
    });
  }
  return byIdentity;
}

/**
 * Rebuild stored notes for the records whose hunk the document shows.
 *
 * Records whose hunk is absent, whose id is already present, or whose parent is neither
 * present nor restorable are skipped; they stay in the file for a review that shows them.
 */
export function restoreNoteRecords(
  document: ReviewDocumentV1,
  records: readonly ReviewRecord[],
  presentIds: ReadonlySet<string>,
): ReviewStoredNote[] {
  const hunksByIdentity = indexReviewHunks(document);
  const known = new Set(presentIds);
  const pending = records.filter(
    (record): record is NoteRecord => record.kind === "note" && !known.has(record.id),
  );
  const restored: ReviewStoredNote[] = [];

  let progressed = true;
  while (progressed && pending.length > 0) {
    progressed = false;
    for (let index = 0; index < pending.length; index += 1) {
      const record = pending[index]!;
      if (record.parentId !== undefined && !known.has(record.parentId)) continue;
      const target = hunksByIdentity.get(record.hunk);
      if (!target) {
        pending.splice(index, 1);
        index -= 1;
        continue;
      }
      const line = hunkSideStart(target.hunk, record.side) + record.offset;
      const range: ReviewLineRange = [line, line + record.length - 1];
      const anchor = resolveReviewNoteAnchor(target.file.hunks, {
        ...(record.side === "new" ? { newRange: range } : { oldRange: range }),
        preferred: { side: record.side, line },
        fallbackOwnerHunkIndex: target.hunkIndex,
      });
      restored.push({
        note: withoutUndefined({
          id: record.id,
          parentId: record.parentId,
          source: record.source,
          originalSource: record.originalSource,
          fileKey: target.file.key,
          anchor,
          summary: record.summary,
          rationale: record.rationale,
          markup: record.markup,
          title: record.title,
          author: record.author,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          editable: record.editable,
          tags: record.tags,
          confidence: record.confidence,
        }) as ReviewNoteV1,
        resolution: "active",
      });
      known.add(record.id);
      pending.splice(index, 1);
      index -= 1;
      progressed = true;
    }
  }
  return restored;
}
