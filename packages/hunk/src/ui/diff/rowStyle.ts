import { themeTuning, TRANSPARENT_BACKGROUND, type AppTheme } from "../themes";
import type { HunkDecision } from "../../core/review/reviewFile";
import { blendHex, contrastRatio, hexColorDistance } from "../lib/color";
import type { ExtensionLineHighlightTone } from "../../extension-api/types";
import type { DiffRow, RenderSpan } from "./diffRowModel";
import type { SplitLineCell, UnifiedLineCell } from "./diffRows";

const selectionBackgroundCache = new WeakMap<AppTheme, Map<string, string>>();
const cursorLineBackgroundCache = new WeakMap<AppTheme, Map<string, string>>();

/** Memoize one derived row color per theme and cache key. */
function cachedRowColor(
  cache: WeakMap<AppTheme, Map<string, string>>,
  theme: AppTheme,
  key: string,
  blend: () => string,
) {
  let colors = cache.get(theme);
  if (!colors) {
    colors = new Map();
    cache.set(theme, colors);
  }
  let color = colors.get(key);
  if (color === undefined) {
    color = blend();
    colors.set(key, color);
  }
  return color;
}

/** The diff rail marker is always visible in Hunk unified and split rows. */
export function diffRailMarker() {
  return "▌";
}

/**
 * Blend a base cell background toward the selection highlight color.
 *
 * blendHex(fg, bg, ratio) returns `bg + (fg - bg) * ratio`. We pass the highlight color as the
 * "front" and the cell's base bg as the "back", so a higher SELECTION_BG_BLEND pulls the result
 * harder toward the visible highlight color.
 */
export function selectionHighlightBg(baseBg: string, theme: AppTheme) {
  return cachedRowColor(selectionBackgroundCache, theme, baseBg, () =>
    blendHex(theme.selectedHunk, baseBg, themeTuning(theme).copySelectionStrength),
  );
}

const MIN_CURSOR_LINE_TEXT_CONTRAST = 3;
const CURSOR_LINE_BACKOFF_STEP = 0.01;

/**
 * Lift a cell background toward the appearance's own extreme to mark the current line.
 *
 * Blending toward white (dark themes) or black (light themes) tints the row rather than
 * recoloring it: hue and relative saturation stay put and only lightness moves, so an added row
 * reads as a lighter version of the same green instead of picking up the theme text color's own
 * hue. A prior version blended toward `theme.text`, which is rarely a neutral gray — on a theme
 * whose text carries its own tint, that mixed a second hue into every row, including the
 * cursor's on plain context lines.
 *
 * A theme whose text is itself pale can see contrast fall as the row lightens toward that same
 * extreme, so the configured strength backs off a step at a time until the code on top of the
 * mark clears a minimum contrast — the same trade the theme's own row tints make elsewhere in
 * this module, just searching down from the configured strength instead of up from zero.
 */
export function cursorLineHighlightBg(baseBg: string, theme: AppTheme) {
  return cachedRowColor(cursorLineBackgroundCache, theme, baseBg, () => {
    const isDark = theme.appearance === "dark";
    const anchor = isDark ? "#ffffff" : "#000000";
    // Reading the sentinel as a color yields black, so a transparent surface blends from the
    // appearance's own opposite extreme instead.
    const source = baseBg === TRANSPARENT_BACKGROUND ? (isDark ? "#000000" : "#ffffff") : baseBg;

    let strength = themeTuning(theme).cursorLineStrength;
    let candidate = blendHex(anchor, source, strength);
    while (
      strength > 0 &&
      contrastRatio(theme.text, candidate) < MIN_CURSOR_LINE_TEXT_CONTRAST
    ) {
      strength = Math.max(0, strength - CURSOR_LINE_BACKOFF_STEP);
      candidate = blendHex(anchor, source, strength);
    }
    return candidate;
  });
}

/** Return the neutral active-hunk rail color for the current theme. */
export function neutralRailColor(theme: AppTheme) {
  return theme.contextRailColor;
}

/** Dim a rail color for inactive hunks by blending toward the panel background. */
export function dimRailColor(color: string, theme: AppTheme) {
  return blendHex(color, theme.panel, 1 - themeTuning(theme).inactiveRailFade);
}

/** The rail color that marks a decided hunk. */
export function decisionRailColor(theme: AppTheme, decision: HunkDecision) {
  switch (decision) {
    case "accepted":
      return theme.acceptedRailColor;
    case "rejected":
      return theme.rejectedRailColor;
    case "addressed":
      return theme.addressedRailColor;
  }
}

/**
 * Finish one rail color: a decided hunk paints every row in its decision's color so the mark
 * reads along the whole hunk, and any hunk outside the selection recedes.
 */
function finishRailColor(
  color: string,
  theme: AppTheme,
  selected: boolean,
  decision: HunkDecision | undefined,
) {
  const resolved = decision ? decisionRailColor(theme, decision) : color;
  return selected ? resolved : dimRailColor(resolved, theme);
}

/** Pick the rail color for a hunk header or collapsed-gap row. */
export function metaRailColor(theme: AppTheme, selected: boolean, decision?: HunkDecision) {
  return finishRailColor(neutralRailColor(theme), theme, selected, decision);
}

// An unfocused hunk recedes instead of disappearing: every color it paints contracts toward the
// surface by the fraction this session tuned, backgrounds harder than text. Contracting both ends
// together keeps the row's own relationships — word-diff emphasis against its line, code against
// its background — rather than flattening the hunk into one muddy block.
// Unfocused code is still part of the review, so fading stops while it can be read at a glance.
const MIN_UNFOCUSED_TEXT_CONTRAST = 2.2;
const UNFOCUSED_FG_RECOVERY_STEP = 0.05;
const UNFOCUSED_BG_RECOVERY_STEP = 0.05;

const unfocusedBackgroundCache = new WeakMap<AppTheme, Map<string, string>>();
const unfocusedForegroundCache = new WeakMap<AppTheme, Map<string, string>>();
const unfocusedThemeCache = new WeakMap<AppTheme, AppTheme>();

/** Return the color an unfocused hunk's colors contract toward. */
function unfocusedSurface(theme: AppTheme) {
  return effectiveHighlightBackground(theme.background, theme);
}

/**
 * Contract one background toward the surface.
 *
 * A transparent cell shows the terminal's own background, which is already the surface the rest
 * of the row is fading toward, so it is left alone rather than painted opaque.
 */
function unfocusedHunkBg(color: string, theme: AppTheme) {
  if (!isHexThemeColor(color)) {
    return color;
  }

  return cachedRowColor(unfocusedBackgroundCache, theme, color, () =>
    blendHex(color, unfocusedSurface(theme), 1 - themeTuning(theme).unfocusedHunkBackgroundFade),
  );
}

/**
 * Fade one foreground toward the surface, backing off before it stops being readable.
 *
 * `paintedBg` is the background the text actually lands on — already contracted — so the guard
 * measures the pair the reader sees rather than the theme's original pairing. A color the theme
 * paired with a light background can be too dark to read once that background has faded, and no
 * amount of fading toward the surface rescues it; such a color is lifted toward the theme's text
 * color instead, which is the direction readability actually lies in.
 */
function unfocusedHunkFg(color: string, paintedBg: string, theme: AppTheme) {
  if (!isHexThemeColor(color)) {
    return color;
  }

  return cachedRowColor(unfocusedForegroundCache, theme, `${color}:${paintedBg}`, () => {
    const surface = unfocusedSurface(theme);
    const background = effectiveHighlightBackground(paintedBg, theme);

    for (
      let retained = 1 - themeTuning(theme).unfocusedHunkTextFade;
      retained < 1;
      retained += UNFOCUSED_FG_RECOVERY_STEP
    ) {
      const candidate = blendHex(color, surface, retained);
      if (contrastRatio(candidate, background) >= MIN_UNFOCUSED_TEXT_CONTRAST) {
        return candidate;
      }
    }

    if (contrastRatio(color, background) >= MIN_UNFOCUSED_TEXT_CONTRAST) {
      return color;
    }

    for (
      let lifted = UNFOCUSED_FG_RECOVERY_STEP;
      lifted < 1;
      lifted += UNFOCUSED_FG_RECOVERY_STEP
    ) {
      const candidate = blendHex(theme.text, color, lifted);
      if (contrastRatio(candidate, background) >= MIN_UNFOCUSED_TEXT_CONTRAST) {
        return candidate;
      }
    }

    return theme.text;
  });
}

/**
 * Derive the theme an unfocused hunk's rows paint with.
 *
 * Only the slots a code or meta row reads at paint time are faded, each foreground against the
 * background it is paired with, so line numbers, diff signs, and hunk headers recede exactly as
 * far as the surfaces behind them. Word-diff colors are baked into a row's spans long before a
 * theme reaches the renderer; `unfocusedHunkRow` fades those.
 */
export function unfocusedHunkTheme(theme: AppTheme): AppTheme {
  const cached = unfocusedThemeCache.get(theme);
  if (cached) {
    return cached;
  }

  const addedBg = unfocusedHunkBg(theme.addedBg, theme);
  const removedBg = unfocusedHunkBg(theme.removedBg, theme);
  const contextBg = unfocusedHunkBg(theme.contextBg, theme);
  const lineNumberBg = unfocusedHunkBg(theme.lineNumberBg, theme);
  const panelAlt = unfocusedHunkBg(theme.panelAlt, theme);
  const unfocused: AppTheme = {
    ...theme,
    addedBg,
    removedBg,
    movedAddedBg: unfocusedHunkBg(theme.movedAddedBg, theme),
    movedRemovedBg: unfocusedHunkBg(theme.movedRemovedBg, theme),
    contextBg,
    lineNumberBg,
    panelAlt,
    addedSignColor: unfocusedHunkFg(theme.addedSignColor, addedBg, theme),
    removedSignColor: unfocusedHunkFg(theme.removedSignColor, removedBg, theme),
    lineNumberFg: unfocusedHunkFg(theme.lineNumberFg, lineNumberBg, theme),
    muted: unfocusedHunkFg(theme.muted, contextBg, theme),
    badgeNeutral: unfocusedHunkFg(theme.badgeNeutral, panelAlt, theme),
    // Spans that carry no color of their own are painted in the syntax default, so it has to
    // fade with them or unhighlighted rows would stay at full strength.
    syntaxColors: {
      ...theme.syntaxColors,
      default: unfocusedHunkFg(theme.syntaxColors.default, contextBg, theme),
    },
  };

  unfocusedThemeCache.set(theme, unfocused);
  return unfocused;
}

const unfocusedSpanColorCache = new WeakMap<AppTheme, Map<string, SpanColors>>();

/** One span's own colors, as the unfocused row paints them. */
interface SpanColors {
  bg: string;
  fg?: string;
}

/**
 * Fade a span that carries its own background, holding the pair at a readable contrast.
 *
 * Word-diff emphasis is a background and the text on it, and a theme is free to pair dark text
 * with a light one. Fading both toward a dark surface collapses that pair, so the background
 * walks back toward its own color until the text on it clears the floor again — the emphasis
 * recedes as far as it can while still being emphasis.
 */
function unfocusedHunkSpanColors(fg: string | undefined, bg: string, theme: AppTheme): SpanColors {
  let cache = unfocusedSpanColorCache.get(theme);
  if (!cache) {
    cache = new Map();
    unfocusedSpanColorCache.set(theme, cache);
  }
  const cacheKey = `${fg ?? ""}:${bg}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const surface = unfocusedSurface(theme);
  // A span with no color of its own is painted in the theme's already faded syntax default, so
  // that is the text the pair has to stay readable for.
  const inheritedFg = unfocusedHunkTheme(theme).syntaxColors.default;
  let resolved: SpanColors = { bg, fg };

  for (
    let retained = 1 - themeTuning(theme).unfocusedHunkBackgroundFade;
    retained < 1;
    retained += UNFOCUSED_BG_RECOVERY_STEP
  ) {
    const candidateBg = isHexThemeColor(bg) ? blendHex(bg, surface, retained) : bg;
    const candidateFg = fg === undefined ? undefined : unfocusedHunkFg(fg, candidateBg, theme);
    const candidate: SpanColors = { bg: candidateBg, fg: candidateFg };
    if (
      contrastRatio(candidateFg ?? inheritedFg, effectiveHighlightBackground(candidateBg, theme)) >=
      MIN_UNFOCUSED_TEXT_CONTRAST
    ) {
      resolved = candidate;
      break;
    }

    if (!isHexThemeColor(bg)) {
      // There is no background to walk back, so the faded text is the whole answer.
      resolved = candidate;
      break;
    }
  }

  cache.set(cacheKey, resolved);
  return resolved;
}

/**
 * Fade one cell's spans against the background the unfocused row paints them on.
 *
 * `contentBg` is the cell's faded background and `cellBg` the theme's own: a span painting the
 * latter carries no emphasis of its own — word-diff emphasis can be tuned flat — so it fades
 * with the line rather than being held readable as a pair.
 */
function unfocusedHunkSpans(
  spans: RenderSpan[],
  contentBg: string,
  cellBg: string,
  theme: AppTheme,
) {
  return spans.map((span) => {
    // Leaving an uncolored span uncolored keeps the renderer's uncolored-row fast path intact.
    const faded =
      span.bg === undefined || span.bg === cellBg
        ? {
            bg: span.bg === undefined ? undefined : contentBg,
            fg: span.fg === undefined ? undefined : unfocusedHunkFg(span.fg, contentBg, theme),
          }
        : unfocusedHunkSpanColors(span.fg, span.bg, theme);

    return faded.fg === span.fg && faded.bg === span.bg
      ? span
      : { ...span, bg: faded.bg, fg: faded.fg };
  });
}

/**
 * Fade one row's spans so an unfocused hunk's syntax and word-diff colors recede with its surfaces.
 *
 * Paint-time by design, exactly like the extension line highlights that run after it: no text
 * changes, so the row measures and wraps identically and the shared row plan, geometry, and
 * highlighted-diff caches never see focus at all. Cells are copied because their span arrays are
 * shared cached objects.
 */
export function unfocusedHunkRow(row: DiffRow, theme: AppTheme): DiffRow {
  const unfocusedTheme = unfocusedHunkTheme(theme);

  if (row.type === "split-line") {
    return {
      ...row,
      left: {
        ...row.left,
        spans: unfocusedHunkSpans(
          row.left.spans,
          splitCellPalette(row.left.kind, unfocusedTheme, row.left.moveKind).contentBg,
          splitCellPalette(row.left.kind, theme, row.left.moveKind).contentBg,
          theme,
        ),
      },
      right: {
        ...row.right,
        spans: unfocusedHunkSpans(
          row.right.spans,
          splitCellPalette(row.right.kind, unfocusedTheme, row.right.moveKind).contentBg,
          splitCellPalette(row.right.kind, theme, row.right.moveKind).contentBg,
          theme,
        ),
      },
    };
  }

  if (row.type === "unified-line") {
    return {
      ...row,
      cell: {
        ...row.cell,
        spans: unfocusedHunkSpans(
          row.cell.spans,
          unifiedCellPalette(row.cell.kind, unfocusedTheme, row.cell.moveKind).contentBg,
          unifiedCellPalette(row.cell.kind, theme, row.cell.moveKind).contentBg,
          theme,
        ),
      },
    };
  }

  return row;
}

/** Pick the unified-view rail color for one rendered row. */
export function unifiedRailColor(
  kind: UnifiedLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  decision?: HunkDecision,
) {
  let color: string;

  if (kind === "addition") {
    color = theme.addedRailColor;
  } else if (kind === "deletion") {
    color = theme.removedRailColor;
  } else {
    color = neutralRailColor(theme);
  }

  return finishRailColor(color, theme, selected, decision);
}

/** Pick the left split-view rail color from the old-side cell state. */
export function splitLeftRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  decision?: HunkDecision,
) {
  const color = kind === "deletion" ? theme.removedRailColor : neutralRailColor(theme);
  return finishRailColor(color, theme, selected, decision);
}

/** Pick the right split-view rail color from the new-side cell state. */
export function splitRightRailColor(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  selected: boolean,
  decision?: HunkDecision,
) {
  const color = kind === "addition" ? theme.addedRailColor : neutralRailColor(theme);
  return finishRailColor(color, theme, selected, decision);
}

/** Pick split-view colors from the semantic diff cell kind. */
export function splitCellPalette(
  kind: SplitLineCell["kind"],
  theme: AppTheme,
  moveKind?: SplitLineCell["moveKind"],
) {
  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  if (kind === "empty") {
    return {
      gutterBg: theme.lineNumberBg,
      contentBg: theme.panelAlt,
      signColor: theme.muted,
      numberColor: theme.lineNumberFg,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

/** Pick unified-view colors from the semantic diff cell kind. */
export function unifiedCellPalette(
  kind: UnifiedLineCell["kind"],
  theme: AppTheme,
  moveKind?: UnifiedLineCell["moveKind"],
) {
  if (kind === "addition") {
    return {
      gutterBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      contentBg: moveKind ? theme.movedAddedBg : theme.addedBg,
      signColor: theme.addedSignColor,
      numberColor: theme.addedSignColor,
    };
  }

  if (kind === "deletion") {
    return {
      gutterBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      contentBg: moveKind ? theme.movedRemovedBg : theme.removedBg,
      signColor: theme.removedSignColor,
      numberColor: theme.removedSignColor,
    };
  }

  return {
    gutterBg: theme.lineNumberBg,
    contentBg: theme.contextBg,
    signColor: theme.muted,
    numberColor: theme.lineNumberFg,
  };
}

// Word-diff emphasis guarantees 28 (`MIN_EMPHASIS_SEPARATION` in themes.ts),
// but that floor is tuned for subtle tinting inside already-tinted lines.
// Extension marks are things the user is looking *for* — search hits,
// diagnostics — so they target a substantially higher floor: distances are
// summed channel deltas on a 0–765 scale, and 28 reads as a whisper on many
// added/removed backgrounds. The readability guard below may bind first on a
// few theme/tone combinations, which is the intended order of priorities.
const MIN_LINE_HIGHLIGHT_BG_DISTANCE = 72;
const LINE_HIGHLIGHT_BLEND_STEP = 0.05;
const LINE_HIGHLIGHT_MAX_BLEND = 0.85;
// Strengthening stops before the code on top of the mark becomes hard to
// read: a mark that eats its own text would defeat the point of marking it.
const MIN_LINE_HIGHLIGHT_TEXT_CONTRAST = 3.1;

/** How one resolved mark paints: a background, plus a foreground when the mark inverts or dims. */
export type LineHighlightStyle =
  | {
      bg: string;
      /** Set only for reverse-video marks; tinted marks keep the spans' own colors. */
      fg?: string;
      transformFg?: never;
    }
  | {
      bg?: string;
      fg?: string;
      /** Set for marks that transform the span's foreground color (e.g. dimming). */
      transformFg: (sourceFg: string | undefined, spanBg: string | undefined) => string;
    };

const lineHighlightStyleCache = new WeakMap<
  AppTheme,
  Map<string, LineHighlightStyle | undefined>
>();

/** Return whether a theme color can safely participate in RGB distance and blend math. */
function isHexThemeColor(color: string) {
  return /^#[0-9a-f]{6}$/i.test(color);
}

/**
 * Resolve the background a mark actually sits on into blendable hex.
 *
 * A transparent cell shows whatever is behind the terminal, so there is no
 * color to blend against. Fall back to the theme's own background, and then —
 * when that is transparent too, which is the whole point of the transparent
 * surface option — to the appearance's extreme, exactly as the cursor-line
 * marker does. The mark then paints an opaque tint instead of nothing at all.
 */
function effectiveHighlightBackground(baseBg: string, theme: AppTheme) {
  if (isHexThemeColor(baseBg)) return baseBg;
  if (isHexThemeColor(theme.background)) return theme.background;
  return theme.appearance === "dark" ? "#000000" : "#ffffff";
}

/** The theme color one tinted highlight tone pulls the line background toward. */
function lineHighlightToneAnchor(
  tone: Exclude<ExtensionLineHighlightTone, "dim">,
  theme: AppTheme,
) {
  switch (tone) {
    case "info":
      return theme.badgeNeutral;
    case "warning":
      return theme.fileModified;
    case "error":
      return theme.removedSignColor;
    case "current":
    case "match":
      return theme.accent;
  }
}

/**
 * Blend the anchor into the base background until the mark clears its distance
 * floor, backing off before the theme's text stops being readable on it.
 */
function strengthenLineHighlightBg(
  baseBg: string,
  anchor: string,
  minDistance: number,
  textColor: string,
) {
  let strongestReadable = baseBg;
  const maxSteps = Math.floor(LINE_HIGHLIGHT_MAX_BLEND / LINE_HIGHLIGHT_BLEND_STEP);

  for (let step = 1; step <= maxSteps; step += 1) {
    const candidate = blendHex(anchor, baseBg, step * LINE_HIGHLIGHT_BLEND_STEP);
    if (contrastRatio(textColor, candidate) < MIN_LINE_HIGHLIGHT_TEXT_CONTRAST) {
      // Readability wins over the distance floor: return the strongest mark
      // the code on top of it can still be read through.
      return strongestReadable;
    }
    strongestReadable = candidate;
    if (hexColorDistance(candidate, baseBg) >= minDistance) {
      return candidate;
    }
  }

  return strongestReadable;
}

/**
 * Resolve one extension highlight tone against the background it will sit on.
 *
 * Visibility is the host's guarantee, not the extension's problem. Tinted
 * tones blend the anchor color into the line's own background until the
 * result clears a minimum perceptual distance — backing off before the code
 * on top stops being readable — so a mark reads on added, removed, and
 * context lines alike. `"current"` inverts instead: theme text as the
 * background, theme background as the foreground — the reverse-video
 * convention `less` and vim use for the active hit, unmistakable and readable
 * by construction. A transparent cell has no color to blend against, so
 * resolution falls back to the background the terminal effectively shows
 * rather than painting nothing — the tint is then chosen against an assumed
 * surface, not the real one. Returns `undefined` — leave the spans untouched —
 * only when the theme's own colors cannot take a blend at all, the same
 * degradation word-diff emphasis uses.
 */
export function lineHighlightToneStyle(
  tone: "dim",
  baseBg: string,
  theme: AppTheme,
): Extract<LineHighlightStyle, { transformFg: unknown }> | undefined;
export function lineHighlightToneStyle(
  tone: Exclude<ExtensionLineHighlightTone, "dim">,
  baseBg: string,
  theme: AppTheme,
): Extract<LineHighlightStyle, { bg: string }> | undefined;
export function lineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined;
export function lineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined {
  let styles = lineHighlightStyleCache.get(theme);
  if (!styles) {
    styles = new Map();
    lineHighlightStyleCache.set(theme, styles);
  }
  const cacheKey = `${tone}:${baseBg}`;
  if (styles.has(cacheKey)) {
    return styles.get(cacheKey);
  }

  const resolved = resolveLineHighlightToneStyle(tone, baseBg, theme);
  styles.set(cacheKey, resolved);
  return resolved;
}

const DEFAULT_DIM_RATIO = 0.45;
const MIN_DIM_TEXT_CONTRAST = 1.6;

const dimSpanFgCache = new WeakMap<AppTheme, Map<string, string>>();

/** Dim a span's foreground color toward its effective background while preserving hue. */
export function dimSpanFg(
  sourceFg: string | undefined,
  baseBg: string,
  theme: AppTheme,
  ratio = DEFAULT_DIM_RATIO,
): string {
  let themeCache = dimSpanFgCache.get(theme);
  if (!themeCache) {
    themeCache = new Map();
    dimSpanFgCache.set(theme, themeCache);
  }
  const cacheKey = `${baseBg}:${sourceFg ?? ""}:${ratio}`;
  const cached = themeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const effectiveBg = effectiveHighlightBackground(baseBg, theme);
  const fallbackFg = theme.syntaxColors.default || theme.text;
  const effectiveFg =
    sourceFg && isHexThemeColor(sourceFg)
      ? sourceFg
      : isHexThemeColor(fallbackFg)
        ? fallbackFg
        : theme.appearance === "dark"
          ? "#adbac7"
          : "#24292f";

  let result = effectiveFg;
  const candidate = blendHex(effectiveFg, effectiveBg, ratio);
  if (contrastRatio(candidate, effectiveBg) >= MIN_DIM_TEXT_CONTRAST) {
    result = candidate;
  } else {
    for (let step = 1; step <= 9; step += 1) {
      const stepRatio = ratio + step * 0.05;
      if (stepRatio > 0.901) break;
      const strengthened = blendHex(effectiveFg, effectiveBg, stepRatio);
      if (contrastRatio(strengthened, effectiveBg) >= MIN_DIM_TEXT_CONTRAST) {
        result = strengthened;
        break;
      }
    }
  }

  themeCache.set(cacheKey, result);
  return result;
}

/** Compute one uncached tone style; `lineHighlightToneStyle` owns memoization. */
function resolveLineHighlightToneStyle(
  tone: ExtensionLineHighlightTone,
  baseBg: string,
  theme: AppTheme,
): LineHighlightStyle | undefined {
  if (tone === "dim") {
    return {
      transformFg: (sourceFg, spanBg) => dimSpanFg(sourceFg, spanBg ?? baseBg, theme),
    };
  }

  if (tone === "current" && isHexThemeColor(theme.text)) {
    return { bg: theme.text, fg: effectiveHighlightBackground(theme.background, theme) };
  }

  const anchor = lineHighlightToneAnchor(tone, theme);
  if (!isHexThemeColor(anchor) || !isHexThemeColor(theme.text)) {
    return undefined;
  }

  return {
    bg: strengthenLineHighlightBg(
      effectiveHighlightBackground(baseBg, theme),
      anchor,
      MIN_LINE_HIGHLIGHT_BG_DISTANCE,
      theme.text,
    ),
  };
}

/** Format one optional line number for a fixed-width diff gutter. */
export function diffLineNumberText(value: number | undefined, width: number) {
  return value === undefined ? " ".repeat(width) : String(value).padStart(width, " ");
}

/** Build the unified-view gutter text shared by the TUI and static pager renderers. */
export function unifiedGutterText(
  cell: UnifiedLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const oldNumber = diffLineNumberText(cell.oldLineNumber, lineNumberDigits);
  const newNumber = diffLineNumberText(cell.newLineNumber, lineNumberDigits);
  return `${oldNumber} ${newNumber} ${cell.sign}`;
}

/** Build the split-view gutter text shared by the TUI and clipboard renderers. */
export function splitGutterText(
  cell: SplitLineCell,
  lineNumberDigits: number,
  showLineNumbers: boolean,
) {
  if (!showLineNumbers) {
    return `${cell.sign} `;
  }

  const number = cell.lineNumber
    ? String(cell.lineNumber).padStart(lineNumberDigits, " ")
    : " ".repeat(lineNumberDigits);
  return `${number} ${cell.sign}`;
}
