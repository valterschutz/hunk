import type { ThemeTuning } from "../../core/run/themeTuning";

export interface AppTheme {
  id: string;
  label: string;
  appearance: "light" | "dark";
  background: string;
  panel: string;
  panelAlt: string;
  border: string;
  accent: string;
  accentMuted: string;
  /** Bright foreground for clickable copy affordances. */
  copyAction: string;
  text: string;
  muted: string;
  addedBg: string;
  removedBg: string;
  movedAddedBg: string;
  movedRemovedBg: string;
  contextBg: string;
  addedContentBg: string;
  removedContentBg: string;
  contextContentBg: string;
  /** Optional foreground for the word-diff span; unset keeps the syntax-highlighter color. */
  addedContentFg?: string;
  removedContentFg?: string;
  addedSignColor: string;
  removedSignColor: string;
  lineNumberBg: string;
  lineNumberFg: string;
  /** Rail marker beside added lines of the active hunk; inactive hunks show it dimmed. */
  addedRailColor: string;
  /** Rail marker beside removed lines of the active hunk; inactive hunks show it dimmed. */
  removedRailColor: string;
  /** Rail marker beside context lines and hunk headers of the active hunk. */
  contextRailColor: string;
  /** Rail marker beside every row of a hunk the reviewer accepted, when decided hunks are shown. */
  acceptedRailColor: string;
  /** Rail marker beside every row of a hunk the reviewer rejected. */
  rejectedRailColor: string;
  /** Rail marker beside every row of a rejected hunk the reviewer has since fixed. */
  fixedRailColor: string;
  /**
   * Fixed color the current line lifts toward, replacing the computed white/black tint.
   *
   * Unset on every bundled theme: the computed tint already keeps each row's own hue. A custom
   * theme sets this when its source palette already names a "one step lighter" surface color
   * that reads better than a generic blend, e.g. Catppuccin's `surface0`.
   */
  cursorLineBg?: string;
  selectedHunk: string;
  badgeAdded: string;
  badgeRemoved: string;
  badgeNeutral: string;
  fileNew: string;
  fileDeleted: string;
  fileRenamed: string;
  fileModified: string;
  fileUntracked: string;
  noteBorder: string;
  noteBackground: string;
  noteTitleBackground: string;
  noteTitleText: string;
  /** Optional Shiki/Pierre base theme name for source-accurate code highlighting. */
  syntaxTheme?: string;
  /** Exact Shiki/TextMate scope colors layered onto the base syntax theme. */
  syntaxScopeOverrides?: Record<string, string>;
  syntaxColors: SyntaxColors;
  /**
   * Effect strengths this session tuned, or unset for the built-in ones.
   *
   * A theme names colors; tuning says how hard the renderers lean on them. It rides on the theme
   * because every consumer of a derived color — faded rows, the cursor line, copy selection,
   * word-diff emphasis — already has the theme in hand, and one session resolves it once.
   */
  tuning?: ThemeTuning;
}

export type SyntaxColors = {
  default: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
  function: string;
  property: string;
  type: string;
  variable?: string;
  operator?: string;
  punctuation: string;
};

export type ThemeBase = Omit<AppTheme, "syntaxColors">;
