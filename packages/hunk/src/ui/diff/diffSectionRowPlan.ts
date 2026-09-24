import {
  reviewExpansionSide,
  reviewGapSourceWithSourceText,
  type ReviewGapSource,
} from "../../core/review/expansion";
import { DEFAULT_TAB_WIDTH } from "../../core/run/tabWidth";
import { DEFAULT_HUNK_GAP } from "../../core/run/reviewGap";
import type { DiffFile } from "../../core/changeset/model";
import type { LayoutMode } from "../../core/run/commandInputs";
import type { VisibleAgentNote } from "../lib/agentAnnotations";
import type { AppTheme } from "../themes";
import { findMaxLineNumber, findMaxLineNumberInRows } from "./codeColumns";
import {
  expandCollapsedRows,
  isWholeFileExpanded,
  stripHunkChromeRows,
  type FileSourceStatus,
} from "./expandCollapsedRows";
import {
  buildSplitRows,
  buildUnifiedRows,
  type HighlightedDiffCode,
  type RenderSpan,
} from "./diffRows";
import { buildReviewRenderPlan, type PlannedReviewRow } from "./reviewRenderPlan";

const EMPTY_EXPANDED_GAP_KEYS: ReadonlySet<string> = new Set();
const EMPTY_VISIBLE_AGENT_NOTES: VisibleAgentNote[] = [];

export interface DiffSectionRowPlan {
  lineNumberDigits: number;
  plannedRows: PlannedReviewRow[];
}

export interface BuildDiffSectionRowPlanOptions {
  expandedKeys?: ReadonlySet<string>;
  file: DiffFile | undefined;
  highlightedDiff?: HighlightedDiffCode | null;
  layout: Exclude<LayoutMode, "auto">;
  showHunkHeaders: boolean;
  sourceLineSpans?: (line: string | undefined, sourceLineNumber: number) => RenderSpan[];
  sourceStatus?: FileSourceStatus | undefined;
  tabWidth?: number;
  hunkGap?: number;
  theme: AppTheme;
  visibleAgentNotes?: VisibleAgentNote[];
  /** The reviewer asked to read this file whole rather than as hunks. */
  wholeFile?: boolean;
}

/** Build Pierre rows for one file using the selected terminal diff layout. */
function buildBaseRows(
  file: DiffFile,
  layout: Exclude<LayoutMode, "auto">,
  highlightedDiff: HighlightedDiffCode | null | undefined,
  theme: AppTheme,
  tabWidth: number,
  gapSource: ReviewGapSource,
) {
  return layout === "split"
    ? buildSplitRows(file, highlightedDiff ?? null, theme, tabWidth, gapSource)
    : buildUnifiedRows(file, highlightedDiff ?? null, theme, tabWidth, gapSource);
}

/** Build the shared file-level diff plan consumed by rendering and geometry measurement. */
export function buildDiffSectionRowPlan({
  expandedKeys = EMPTY_EXPANDED_GAP_KEYS,
  file,
  highlightedDiff = null,
  layout,
  showHunkHeaders,
  sourceLineSpans,
  sourceStatus,
  tabWidth = DEFAULT_TAB_WIDTH,
  hunkGap = DEFAULT_HUNK_GAP,
  theme,
  visibleAgentNotes = EMPTY_VISIBLE_AGENT_NOTES,
  wholeFile = false,
}: BuildDiffSectionRowPlanOptions): DiffSectionRowPlan {
  if (!file) {
    return {
      lineNumberDigits: 1,
      plannedRows: [],
    };
  }

  const side = reviewExpansionSide(file.metadata.type);
  // Loaded source sizes the tail after the last hunk, which a partial patch cannot on its own.
  const gapSource = reviewGapSourceWithSourceText(
    file.metadata,
    side,
    sourceStatus?.kind === "loaded" ? sourceStatus.text : undefined,
  );
  const baseRows = buildBaseRows(file, layout, highlightedDiff, theme, tabWidth, gapSource);
  const expandedRows = expandCollapsedRows(baseRows, {
    layout,
    expandedKeys,
    sourceLineSpans,
    sourceStatus,
    tabWidth,
    side,
  });
  // A file the reviewer reads whole shows no hunk boundaries once every gap is open. A gap
  // folded by hand brings the chrome back, so the toggle that reopens it stays reachable.
  const rows =
    wholeFile && isWholeFileExpanded(gapSource, expandedKeys, sourceStatus)
      ? stripHunkChromeRows(expandedRows)
      : expandedRows;

  return {
    lineNumberDigits: String(findMaxLineNumberInRows(rows, findMaxLineNumber(file))).length,
    plannedRows: buildReviewRenderPlan({
      fileId: file.id,
      rows,
      showHunkHeaders,
      visibleAgentNotes,
      hunkGap,
    }),
  };
}
