/**
 * Declares the strengths a reader tunes for the effects Hunk derives from a theme's colors.
 *
 * A theme names colors; these name how hard the renderer leans on them — how far an unfocused
 * hunk recedes, how brightly the current line and a copy selection paint, how loud word-diff
 * emphasis is. They are read as whole percents in `config.toml`, carried as ratios, and resolved
 * once per session onto the active theme so every renderer reads them from the theme it already
 * has.
 */

/** Effect strengths resolved for one session, as ratios rather than the config's percents. */
export interface ThemeTuning {
  /** How far an unfocused hunk's backgrounds move toward the surface behind them, 0–1. */
  unfocusedHunkBackgroundFade: number;
  /** How far an unfocused hunk's text moves toward that surface, 0–1. Text fades less so it
   * stays readable. */
  unfocusedHunkTextFade: number;
  /** How far the rail marker beside an unfocused hunk fades into the panel, 0–1. */
  inactiveRailFade: number;
  /** How far the current line's background lifts toward the theme's text color, 0–1. */
  cursorLineStrength: number;
  /** How far a copy-selected row pulls toward the theme's selection color, 0–1. */
  copySelectionStrength: number;
  /** Word-diff emphasis against the theme's own, 0–2: 1 keeps the theme's colors, 0 flattens
   * emphasis into the line, 2 pushes it toward the diff sign color. */
  wordDiffEmphasis: number;
}

/** The percents one config layer may set, named exactly as `CommonOptions` carries them. */
export interface ThemeTuningPercents {
  unfocusedHunkBackgroundFade?: number;
  unfocusedHunkTextFade?: number;
  inactiveRailFade?: number;
  cursorLineStrength?: number;
  copySelectionStrength?: number;
  wordDiffEmphasis?: number;
}

export const MAX_TUNING_PERCENT = 100;
/** Word-diff emphasis alone reads past 100%, where it strengthens the theme's own emphasis. */
export const MAX_WORD_DIFF_EMPHASIS_PERCENT = 200;

export const DEFAULT_THEME_TUNING: ThemeTuning = {
  unfocusedHunkBackgroundFade: 0.75,
  unfocusedHunkTextFade: 0.55,
  inactiveRailFade: 0.65,
  cursorLineStrength: 0.2,
  copySelectionStrength: 0.75,
  wordDiffEmphasis: 1,
};

/** The percent each tuning key defaults to, for config parsing and generated reference docs. */
export const DEFAULT_TUNING_PERCENTS: Required<ThemeTuningPercents> = {
  unfocusedHunkBackgroundFade: 75,
  unfocusedHunkTextFade: 55,
  inactiveRailFade: 65,
  cursorLineStrength: 20,
  copySelectionStrength: 75,
  wordDiffEmphasis: 100,
};

/** Validate one tuning percent, naming the key the way the user wrote it. */
export function validateTuningPercent(value: number, label: string, max = MAX_TUNING_PERCENT) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`Invalid ${label}: ${String(value)} (expected a whole percent from 0 to ${max})`);
  }

  return value;
}

/** Resolve the percents one launch set into the ratios renderers consume. */
export function resolveThemeTuning(percents: ThemeTuningPercents): ThemeTuning {
  const ratio = (value: number | undefined, fallback: number) =>
    value === undefined ? fallback : value / 100;

  return {
    unfocusedHunkBackgroundFade: ratio(
      percents.unfocusedHunkBackgroundFade,
      DEFAULT_THEME_TUNING.unfocusedHunkBackgroundFade,
    ),
    unfocusedHunkTextFade: ratio(
      percents.unfocusedHunkTextFade,
      DEFAULT_THEME_TUNING.unfocusedHunkTextFade,
    ),
    inactiveRailFade: ratio(percents.inactiveRailFade, DEFAULT_THEME_TUNING.inactiveRailFade),
    cursorLineStrength: ratio(percents.cursorLineStrength, DEFAULT_THEME_TUNING.cursorLineStrength),
    copySelectionStrength: ratio(
      percents.copySelectionStrength,
      DEFAULT_THEME_TUNING.copySelectionStrength,
    ),
    wordDiffEmphasis: ratio(percents.wordDiffEmphasis, DEFAULT_THEME_TUNING.wordDiffEmphasis),
  };
}
