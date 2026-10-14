/** Renders collapsed gaps and hunk headers without introducing code-row geometry policy. */
import type { UserNoteLineTarget } from "../../core/liveComments";
import { reviewGapId } from "../../core/review/expansion";
import type { AppTheme } from "../themes";
import { CODE_ROW_ADD_NOTE_BADGE_TEXT } from "./codeRowAffordance";
import type { PlannedDiffMetaReviewRow } from "./reviewRenderPlan";
import { fitText } from "./plannedRowText";
import {
  decisionDotColor,
  decisionDotMarker,
  diffRailMarker,
  dimRailColor,
  type HunkMarks,
  metaRailColor,
  unfocusedHunkTheme,
} from "./rowStyle";
import { markNestedRowMouseAction } from "./rowMouseActions";

export interface DiffMetaRowViewProps {
  plannedRow: PlannedDiffMetaReviewRow;
  width: number;
  theme: AppTheme;
  selected: boolean;
  /** The rail mark and decision of the hunk the row belongs to. */
  marks?: HunkMarks;
  showHunkHeaders: boolean;
  showAddNoteBadge?: boolean;
  onHoverRow?: (rowKey: string) => void;
  onStartUserNoteAtHunk?: (hunkIndex: number, target?: UserNoteLineTarget) => void;
  onToggleGap?: (gapKey: string) => void;
}

/** Build the rendered label text for one collapsed gap row. */
function collapsedRowLabel(text: string, expandable: boolean) {
  if (!expandable) {
    return `··· ${text} ···`;
  }

  // The leading chevron hints that the row is interactive on terminals that
  // render Unicode glyphs. The label still reads naturally on plain VT100.
  return `▾ ${text}`;
}

/** Render one collapsed gap or hunk header with its nested row controls. */
export function DiffMetaRowView({
  plannedRow,
  width,
  theme,
  selected,
  marks,
  showHunkHeaders,
  showAddNoteBadge = false,
  onHoverRow,
  onStartUserNoteAtHunk,
  onToggleGap,
}: DiffMetaRowViewProps) {
  const { anchorId, row } = plannedRow;
  if (row.type === "hunk-header" && !showHunkHeaders) {
    return null;
  }

  const badges = [
    showAddNoteBadge
      ? {
          key: "user-note",
          text: CODE_ROW_ADD_NOTE_BADGE_TEXT,
          onClick: () => onStartUserNoteAtHunk?.(row.hunkIndex),
        }
      : null,
  ].filter((badge): badge is { key: string; text: string; onClick: () => void } => Boolean(badge));
  const badgeWidth = badges.reduce((total, badge) => total + badge.text.length + 1, 0);
  const collapsedExpandable = row.type === "collapsed" && Boolean(onToggleGap);
  const labelText =
    row.type === "collapsed" ? collapsedRowLabel(row.text, collapsedExpandable) : row.text;
  // A decided hunk's header leads with its decision dot; collapsed gaps carry no decision.
  const decision = row.type === "hunk-header" ? marks?.decision : undefined;
  const dotText = decision ? `${decisionDotMarker()} ` : "";
  const label = fitText(labelText, Math.max(0, width - 1 - dotText.length - badgeWidth));
  // Headers and collapsed gaps belong to their hunk, so they fade with the code they introduce.
  const rowTheme = selected ? theme : unfocusedHunkTheme(theme);
  const dot = decision ? (
    <span
      fg={
        selected
          ? decisionDotColor(theme, decision)
          : dimRailColor(decisionDotColor(theme, decision), theme)
      }
      bg={rowTheme.panelAlt}
    >
      {dotText}
    </span>
  ) : null;
  const handleCollapsedClick =
    row.type === "collapsed" && onToggleGap
      ? () => onToggleGap(reviewGapId(row.position, row.hunkIndex))
      : undefined;

  if (badges.length === 0) {
    return (
      <box
        id={anchorId}
        style={{
          width,
          height: 1,
          backgroundColor: rowTheme.panelAlt,
        }}
        onMouseMove={() => onHoverRow?.(row.key)}
        onMouseOver={() => onHoverRow?.(row.key)}
        onMouseUp={handleCollapsedClick}
      >
        <text>
          <span fg={metaRailColor(theme, selected, marks?.rail)} bg={rowTheme.panelAlt}>
            {diffRailMarker()}
          </span>
          {dot}
          <span
            fg={row.type === "collapsed" ? rowTheme.muted : rowTheme.badgeNeutral}
            bg={rowTheme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
    );
  }

  return (
    <box
      id={anchorId}
      style={{
        width,
        height: 1,
        flexDirection: "row",
        backgroundColor: rowTheme.panelAlt,
      }}
      onMouseMove={() => onHoverRow?.(row.key)}
      onMouseOver={() => onHoverRow?.(row.key)}
    >
      <box
        style={{ width: Math.max(0, width - badgeWidth), height: 1 }}
        onMouseUp={handleCollapsedClick}
      >
        <text>
          <span fg={metaRailColor(theme, selected, marks?.rail)} bg={rowTheme.panelAlt}>
            {diffRailMarker()}
          </span>
          {dot}
          <span
            fg={row.type === "collapsed" ? rowTheme.muted : rowTheme.badgeNeutral}
            bg={rowTheme.panelAlt}
          >
            {label}
          </span>
        </text>
      </box>
      {badges.map((badge) => (
        <box
          key={badge.key}
          style={{ width: badge.text.length + 1, height: 1 }}
          onMouseUp={(event) => {
            markNestedRowMouseAction(event);
            badge.onClick();
          }}
        >
          <text fg={theme.noteTitleText} bg={theme.noteTitleBackground}>{` ${badge.text}`}</text>
        </box>
      ))}
    </box>
  );
}
