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
