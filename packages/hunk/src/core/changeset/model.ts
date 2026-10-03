/**
 * Declares the normalized changeset model every input source produces and every
 * surface consumes: one `Changeset` of ordered `DiffFile`s plus the sidecar
 * context matched onto them.
 *
 * Kept as a leaf module so loaders, the VCS contract, and watch planning can
 * share these shapes without importing `core/types`, which layers the
 * app-facing types above them.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import type { AgentFileContext } from "../../extension-api/types";
import type { FileSourceFetcher } from "./fileSource";

/** One loaded review sidecar: the changeset summary plus every annotated file it names. */
export interface SidecarContext {
  version: number;
  summary?: string;
  files: AgentFileContext[];
}

export interface DiffFile {
  id: string;
  path: string;
  previousPath?: string;
  patch: string;
  language?: string;
  stats: {
    additions: number;
    deletions: number;
  };
  metadata: FileDiffMetadata;
  lineMoveKinds?: DiffLineMoveKinds;
  agent: AgentFileContext | null;
  isUntracked?: boolean;
  isBinary?: boolean;
  isTooLarge?: boolean;
  statsTruncated?: boolean;
  /** Present on a file the VCS reports as conflicted; see `DiffFileConflict`. */
  conflict?: DiffFileConflict;
  // Optional capability for fetching the file's full text on either side.
  // Loaders attach this when source content is reachable; absent when not.
  sourceFetcher?: FileSourceFetcher;
}

/** Which side of a conflict region a resolution keeps. */
export type ConflictResolutionChoice = "ours" | "theirs" | "base" | "both";

/**
 * One conflict region of a working copy, as the markers delimit it.
 *
 * Line indexes are zero-based positions in the working copy as read, so a
 * resolution can replace exactly the marker block. `base` is only present when
 * the markers were written in `diff3` or `zdiff3` style.
 */
export interface ConflictRegion {
  /** Index into `metadata.hunks` of the hunk showing this region. */
  hunkIndex: number;
  /** Line index of the opening `<<<<<<<` marker. */
  markerStart: number;
  /** Line index of the closing `>>>>>>>` marker. */
  markerEnd: number;
  ours: readonly string[];
  base?: readonly string[];
  theirs: readonly string[];
  oursLabel: string;
  theirsLabel: string;
}

/**
 * Conflict state of one reviewed file.
 *
 * While `regions` is non-empty the file's hunks are the regions themselves,
 * ours on the old side and theirs on the new side. Once it is empty the file
 * shows as an ordinary edit, but stays marked so the sidebar can say it was a
 * conflict the reviewer has already worked through.
 */
export interface DiffFileConflict {
  regions: readonly ConflictRegion[];
  /** Regions still carrying markers; the same count extensions see. */
  unresolved: number;
}

export type DiffLineMoveKind = "moved";

export interface DiffLineMoveKinds {
  additionLines: Array<DiffLineMoveKind | undefined>;
  deletionLines: Array<DiffLineMoveKind | undefined>;
}

export interface Changeset {
  id: string;
  sourceLabel: string;
  title: string;
  summary?: string;
  agentSummary?: string;
  files: DiffFile[];
}
