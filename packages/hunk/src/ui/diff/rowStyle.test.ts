import { describe, expect, test } from "bun:test";
import { contrastRatio, hexColorDistance } from "../lib/color";
import { THEMES, TRANSPARENT_BACKGROUND, withTransparentSurfaces } from "../themes";
import type { DiffRow } from "./diffRowModel";
import {
  cursorLineHighlightBg,
  dimRailColor,
  lineHighlightToneStyle,
  metaRailColor,
  splitCellPalette,
  splitLeftRailColor,
  splitRightRailColor,
  unfocusedHunkRow,
  unfocusedHunkTheme,
  unifiedCellPalette,
  unifiedRailColor,
} from "./rowStyle";

const DARK = THEMES.find((theme) => theme.id === "github-dark-dimmed")!;
const LIGHT = THEMES.find((theme) => theme.id === "github-light-default")!;

describe("cursorLineHighlightBg", () => {
  test("marks context rows on transparent surfaces", () => {
    for (const base of [DARK, LIGHT]) {
      const theme = withTransparentSurfaces(base);
      const context = unifiedCellPalette("context", theme);

      expect(context.contentBg).toBe(TRANSPARENT_BACKGROUND);
      expect(cursorLineHighlightBg(context.contentBg, theme)).not.toBe(TRANSPARENT_BACKGROUND);
    }
  });

  test("keeps the marked row readable on every built-in theme", () => {
    for (const base of THEMES) {
      for (const theme of [base, withTransparentSurfaces(base)]) {
        for (const kind of ["context", "addition", "deletion"] as const) {
          const marked = cursorLineHighlightBg(unifiedCellPalette(kind, theme).contentBg, theme);
          expect(contrastRatio(theme.text, marked)).toBeGreaterThan(3);
        }
      }
    }
  });

  test("moves added and removed rows as far as it moves context rows", () => {
    const context = unifiedCellPalette("context", DARK).contentBg;
    const added = unifiedCellPalette("addition", DARK).contentBg;

    const shift = (from: string) => {
      const to = cursorLineHighlightBg(from, DARK);
      return contrastRatio(to, from);
    };

    expect(shift(added)).toBeGreaterThan(1.2);
    expect(shift(context)).toBeGreaterThan(1.2);
  });
});

describe("lineHighlightToneStyle", () => {
  const TINTED_TONES = ["match", "info", "warning", "error"] as const;

  test("clears a strong visible distance on every line kind of every built-in theme", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = unifiedCellPalette(kind, theme).contentBg;
        for (const tone of TINTED_TONES) {
          const resolved = lineHighlightToneStyle(tone, baseBg, theme);
          expect(resolved).toBeDefined();
          // The target floor is 72 — well above word diff's 28 whisper — but
          // the readability guard may bind first on a few theme/tone pairs;
          // 60 is the strongest distance every combination can guarantee
          // while the code on top stays readable.
          expect(hexColorDistance(resolved!.bg, baseBg)).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  test("paints the current mark as reverse video, unmistakable on every theme", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = unifiedCellPalette(kind, theme).contentBg;
        const match = lineHighlightToneStyle("match", baseBg, theme)!;
        const current = lineHighlightToneStyle("current", baseBg, theme)!;
        // Inversion: theme text becomes the block, theme background the glyphs.
        expect(current).toEqual({ bg: theme.text, fg: theme.background });
        // The active hit must dominate both the line and its siblings.
        expect(hexColorDistance(current.bg, baseBg)).toBeGreaterThan(
          hexColorDistance(match.bg, baseBg),
        );
        expect(contrastRatio(current.fg!, current.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("paints a visible readable mark on transparent surfaces", () => {
    // Most themes render context content transparent under the transparent
    // surface option, and most search hits land on context lines — so declining
    // this case silently painted nothing in the common case.
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const contextBg = unifiedCellPalette("context", theme).contentBg;
      expect(contextBg).toBe(TRANSPARENT_BACKGROUND);
      const assumed = theme.appearance === "dark" ? "#000000" : "#ffffff";

      for (const tone of TINTED_TONES) {
        const resolved = lineHighlightToneStyle(tone, contextBg, theme);
        expect(resolved).toBeDefined();
        expect(resolved!.bg).not.toBe(TRANSPARENT_BACKGROUND);
        // Visible against the surface the terminal effectively shows, and still
        // readable under the code painted on top of it.
        expect(hexColorDistance(resolved!.bg, assumed)).toBeGreaterThanOrEqual(60);
        expect(contrastRatio(theme.text, resolved!.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("keeps the current mark reverse video on transparent surfaces", () => {
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const current = lineHighlightToneStyle("current", TRANSPARENT_BACKGROUND, theme)!;
      expect(current.bg).toBe(theme.text);
      expect(current.fg).not.toBe(TRANSPARENT_BACKGROUND);
      expect(contrastRatio(current.fg!, current.bg)).toBeGreaterThan(3);
    }
  });

  test("keeps code readable over every resolved tinted background", () => {
    for (const theme of THEMES) {
      const baseBg = unifiedCellPalette("context", theme).contentBg;
      for (const tone of TINTED_TONES) {
        const resolved = lineHighlightToneStyle(tone, baseBg, theme);
        expect(contrastRatio(theme.text, resolved!.bg)).toBeGreaterThan(3);
      }
    }
  });

  test("resolves dim tone to transform foreground toward background with readable contrast", () => {
    for (const theme of THEMES) {
      for (const kind of ["context", "addition", "deletion"] as const) {
        const baseBg = unifiedCellPalette(kind, theme).contentBg;
        const resolved = lineHighlightToneStyle("dim", baseBg, theme);
        expect(resolved).toBeDefined();
        expect(resolved!.transformFg).toBeDefined();

        const syntaxFg = "#e06c75";
        const dimmed = resolved!.transformFg!(syntaxFg, baseBg);
        const effectiveBg =
          baseBg === TRANSPARENT_BACKGROUND
            ? theme.appearance === "dark"
              ? "#000000"
              : "#ffffff"
            : baseBg;
        expect(contrastRatio(dimmed, effectiveBg)).toBeGreaterThanOrEqual(1.6);
        // Dimmed foreground must be closer to background than the original foreground
        expect(hexColorDistance(dimmed, effectiveBg)).toBeLessThan(
          hexColorDistance(syntaxFg, effectiveBg),
        );
      }
    }
  });

  test("resolves dim tone on transparent surfaces to readable contrast", () => {
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const contextBg = unifiedCellPalette("context", theme).contentBg;
      expect(contextBg).toBe(TRANSPARENT_BACKGROUND);
      const assumedBg = theme.appearance === "dark" ? "#000000" : "#ffffff";

      const resolved = lineHighlightToneStyle("dim", contextBg, theme);
      expect(resolved).toBeDefined();
      expect(resolved!.transformFg).toBeDefined();

      const syntaxFg = "#e06c75";
      const dimmed = resolved!.transformFg!(syntaxFg, contextBg);
      expect(contrastRatio(dimmed, assumedBg)).toBeGreaterThanOrEqual(1.6);
      expect(hexColorDistance(dimmed, assumedBg)).toBeLessThan(
        hexColorDistance(syntaxFg, assumedBg),
      );
    }
  });
});

/** Return the color an unfocused row's colors contract toward, as the module resolves it. */
function surfaceOf(theme: (typeof THEMES)[number]) {
  return theme.background === TRANSPARENT_BACKGROUND
    ? theme.appearance === "dark"
      ? "#000000"
      : "#ffffff"
    : theme.background;
}

describe("unfocusedHunkTheme", () => {
  test("moves every diff surface toward the theme's own background", () => {
    for (const theme of THEMES) {
      const unfocused = unfocusedHunkTheme(theme);
      const surface = surfaceOf(theme);

      for (const key of [
        "addedBg",
        "removedBg",
        "contextBg",
        "lineNumberBg",
        "panelAlt",
      ] as const) {
        expect(hexColorDistance(unfocused[key], surface)).toBeLessThan(
          hexColorDistance(theme[key], surface) + 1,
        );
      }

      // The tints carry the hunk's loudest signal, so they have to actually recede.
      expect(hexColorDistance(unfocused.addedBg, surface)).toBeLessThan(
        hexColorDistance(theme.addedBg, surface),
      );
      expect(hexColorDistance(unfocused.removedBg, surface)).toBeLessThan(
        hexColorDistance(theme.removedBg, surface),
      );
    }
  });

  test("keeps signs, line numbers, and headers readable where they land", () => {
    for (const theme of THEMES) {
      const unfocused = unfocusedHunkTheme(theme);

      expect(contrastRatio(unfocused.addedSignColor, unfocused.addedBg)).toBeGreaterThanOrEqual(2);
      expect(contrastRatio(unfocused.removedSignColor, unfocused.removedBg)).toBeGreaterThanOrEqual(
        2,
      );
      expect(contrastRatio(unfocused.lineNumberFg, unfocused.lineNumberBg)).toBeGreaterThanOrEqual(
        2,
      );
      expect(contrastRatio(unfocused.badgeNeutral, unfocused.panelAlt)).toBeGreaterThanOrEqual(2);
      expect(
        contrastRatio(unfocused.syntaxColors.default, unfocused.contextBg),
      ).toBeGreaterThanOrEqual(2);
    }
  });

  test("fades the sign and syntax colors it can fade", () => {
    for (const theme of THEMES) {
      const unfocused = unfocusedHunkTheme(theme);

      expect(unfocused.addedSignColor).not.toBe(theme.addedSignColor);
      expect(unfocused.removedSignColor).not.toBe(theme.removedSignColor);
      expect(unfocused.syntaxColors.default).not.toBe(theme.syntaxColors.default);
    }
  });

  test("leaves a transparent surface showing the terminal's own background", () => {
    for (const base of THEMES) {
      const theme = withTransparentSurfaces(base);
      const unfocused = unfocusedHunkTheme(theme);

      expect(unfocused.contextBg).toBe(TRANSPARENT_BACKGROUND);
      expect(unfocused.lineNumberBg).toBe(TRANSPARENT_BACKGROUND);
      expect(unfocused.panelAlt).toBe(TRANSPARENT_BACKGROUND);
      expect(contrastRatio(unfocused.syntaxColors.default, "#000000")).toBeGreaterThanOrEqual(2);
    }
  });

  test("derives one stable theme per source theme", () => {
    const theme = THEMES[0]!;
    expect(unfocusedHunkTheme(theme)).toBe(unfocusedHunkTheme(theme));
  });
});

describe("unfocusedHunkRow", () => {
  const theme = THEMES.find((candidate) => candidate.id === "github-dark-default")!;
  const emphasisBg = "#1b4721";

  const splitRow: DiffRow = {
    type: "split-line",
    key: "row",
    fileId: "file",
    hunkIndex: 1,
    left: { kind: "empty", sign: " ", spans: [] },
    right: {
      kind: "addition",
      sign: "+",
      lineNumber: 4,
      spans: [
        { text: "const " },
        { text: "value", fg: "#79c0ff", bg: emphasisBg },
        { text: " = 1;", fg: "#ff7b72" },
      ],
    },
  };

  test("fades word-diff emphasis and syntax color without touching the text", () => {
    const faded = unfocusedHunkRow(splitRow, theme) as Extract<DiffRow, { type: "split-line" }>;
    const surface = surfaceOf(theme);
    const [plain, emphasized, trailing] = faded.right.spans;

    expect(faded.right.spans.map((span) => span.text)).toEqual(["const ", "value", " = 1;"]);
    // An uncolored span keeps inheriting the theme's syntax default, which fades with the theme.
    expect(plain!.fg).toBeUndefined();
    expect(plain!.bg).toBeUndefined();
    expect(hexColorDistance(emphasized!.bg!, surface)).toBeLessThan(
      hexColorDistance(emphasisBg, surface),
    );
    expect(hexColorDistance(emphasized!.fg!, surface)).toBeLessThan(
      hexColorDistance("#79c0ff", surface),
    );
    expect(contrastRatio(emphasized!.fg!, emphasized!.bg!)).toBeGreaterThanOrEqual(2);
    expect(
      contrastRatio(
        trailing!.fg!,
        splitCellPalette("addition", unfocusedHunkTheme(theme)).contentBg,
      ),
    ).toBeGreaterThanOrEqual(2);
  });

  test("leaves rows that carry no spans alone", () => {
    const header: DiffRow = {
      type: "hunk-header",
      key: "header",
      fileId: "file",
      hunkIndex: 1,
      text: "@@ -1 +1 @@",
    };

    expect(unfocusedHunkRow(header, theme)).toBe(header);
  });
});

describe("verified hunk rails", () => {
  test("paint every row of a verified hunk in the verified color, dimmed outside the selection", () => {
    for (const theme of THEMES) {
      const verified = theme.verifiedRailColor;
      expect(unifiedRailColor("addition", theme, true, true)).toBe(verified);
      expect(unifiedRailColor("deletion", theme, true, true)).toBe(verified);
      expect(unifiedRailColor("context", theme, true, true)).toBe(verified);
      expect(splitLeftRailColor("deletion", theme, true, true)).toBe(verified);
      expect(splitRightRailColor("context", theme, true, true)).toBe(verified);
      expect(metaRailColor(theme, true, true)).toBe(verified);

      const dimmed = dimRailColor(verified, theme);
      expect(unifiedRailColor("addition", theme, false, true)).toBe(dimmed);
      expect(metaRailColor(theme, false, true)).toBe(dimmed);
    }
  });

  test("leave unverified hunks on their own rail colors", () => {
    expect(unifiedRailColor("addition", DARK, true)).toBe(DARK.addedRailColor);
    expect(unifiedRailColor("deletion", DARK, true, false)).toBe(DARK.removedRailColor);
    expect(metaRailColor(DARK, true)).toBe(DARK.contextRailColor);
  });
});
