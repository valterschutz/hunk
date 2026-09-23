import { MAX_BROKER_STRING_BYTES } from "@hunk/session-broker-core";
import type {
  HunkSessionSnapshot,
  HunkSessionState,
  SessionLiveCommentSummary,
  SessionReviewNoteSummary,
} from "../types";

/**
 * Keeps a published snapshot inside the daemon's wire limits before it leaves the window.
 *
 * Every free-text string on the wire is bounded by `MAX_BROKER_STRING_BYTES` and must be
 * non-empty; the daemon parses a snapshot with the same exact parsers it applies to a
 * registration and refuses the whole payload when one field is out of bounds. A reviewer who
 * pastes a long note into the composer would otherwise take the session down: the daemon
 * refused the snapshot, the window reconnected and re-registered with the same state, that
 * failed the same way, and the daemon idled out with no sessions while the window kept
 * respawning it. Clipping here keeps the mirror's copy of a note a bounded summary — the
 * window's own review state is untouched — and the session stays registered.
 */

const CLIP_MARKER = "…";
const EMPTY_TEXT_PLACEHOLDER = "(empty)";
const encoder = new TextEncoder();

/** Clip one string to a byte ceiling without splitting a code point, marking the cut. */
export function clipToWireBytes(value: string, maxBytes = MAX_BROKER_STRING_BYTES): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const budget = maxBytes - encoder.encode(CLIP_MARKER).byteLength;
  let bytes = 0;
  let clipped = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > budget) break;
    bytes += size;
    clipped += character;
  }
  return clipped + CLIP_MARKER;
}

/** Bound a required wire string: never empty, never over the ceiling. */
function boundRequired(value: string): string {
  return value.length === 0 ? EMPTY_TEXT_PLACEHOLDER : clipToWireBytes(value);
}

/** Bound an optional wire string: an empty value is omitted, a long one is clipped. */
function boundOptional(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  return clipToWireBytes(value);
}

/** Rebuild one record with the optional keys that resolved to undefined left out. */
function withoutUndefined<T extends object>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;
}

function boundLiveComment(comment: SessionLiveCommentSummary): SessionLiveCommentSummary {
  return withoutUndefined({
    ...comment,
    commentId: boundRequired(comment.commentId),
    parentId: boundOptional(comment.parentId),
    filePath: boundRequired(comment.filePath),
    summary: boundRequired(comment.summary),
    rationale: boundOptional(comment.rationale),
    author: boundOptional(comment.author),
    createdAt: boundRequired(comment.createdAt),
  });
}

function boundReviewNote(note: SessionReviewNoteSummary): SessionReviewNoteSummary {
  return withoutUndefined({
    ...note,
    noteId: boundRequired(note.noteId),
    parentId: boundOptional(note.parentId),
    filePath: boundRequired(note.filePath),
    body: boundRequired(note.body),
    title: boundOptional(note.title),
    author: boundOptional(note.author),
    createdAt: boundRequired(note.createdAt),
    updatedAt: boundOptional(note.updatedAt),
  });
}

/** Bound the app-owned state of one snapshot to what the daemon's wire parsers accept. */
export function boundHunkSessionState(state: HunkSessionState): HunkSessionState {
  return withoutUndefined({
    ...state,
    selectedFileId: boundOptional(state.selectedFileId),
    selectedFilePath: boundOptional(state.selectedFilePath),
    liveComments: state.liveComments.map(boundLiveComment),
    ...(state.reviewNotes ? { reviewNotes: state.reviewNotes.map(boundReviewNote) } : {}),
  });
}

/** Bound one snapshot envelope; the result always passes the daemon's string limits. */
export function boundHunkSessionSnapshot(snapshot: HunkSessionSnapshot): HunkSessionSnapshot {
  return {
    ...snapshot,
    updatedAt: boundRequired(snapshot.updatedAt),
    state: boundHunkSessionState(snapshot.state),
  };
}
