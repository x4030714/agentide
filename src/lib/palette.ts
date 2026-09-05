import { useEffect, useState } from "react";

/**
 * Which colour palette the app wears.
 *
 * Orthogonal to `Appearance`: that chooses light or dark, this chooses the hues used in
 * whichever of those is showing. Every palette ships both modes, so the two settings
 * never have to know about each other.
 *
 * The default is the one in `world.css` and is expressed as the *absence* of the
 * attribute, so the app with no preferences set renders exactly the design the rest of
 * the codebase was built against.
 */
export type Palette = "quiet" | "ferrous" | "halide" | "vellum";

export interface PaletteOption {
  id: Palette;
  label: string;
  /** One line, shown in the picker: what the palette is for, not what colours it uses. */
  note: string;
}

export const PALETTES: PaletteOption[] = [
  { id: "quiet", label: "Quiet Instrument", note: "The default. Neutral slate, four plain roles." },
  { id: "ferrous", label: "Ferrous", note: "Warm graphite and copper. The workshop end." },
  { id: "halide", label: "Halide", note: "Cold cyan on near-black. A darkroom." },
  { id: "vellum", label: "Vellum", note: "Warm paper and ink. The quietest of them." },
];

const KEY = "agentide.palette";

export function isPalette(value: unknown): value is Palette {
  return PALETTES.some((option) => option.id === value);
}

export function storedPalette(): Palette {
  try {
    const value = localStorage.getItem(KEY);
    return isPalette(value) ? value : "quiet";
  } catch {
    return "quiet";
  }
}

/**
 * Apply a palette to the document and remember it.
 *
 * The default sets no attribute at all rather than `data-palette="quiet"`, so the
 * selector in `world.css` needs no `:not()` to stay the base case.
 */
export function applyPalette(palette: Palette): void {
  const root = document.documentElement;
  if (palette === "quiet") root.removeAttribute("data-palette");
  else root.dataset.palette = palette;
  try {
    if (palette === "quiet") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, palette);
  } catch {
    /* A context that refuses storage still gets the choice for this session. */
  }
}

/**
 * The palette, applied and remembered, in the shape `useAppearance` uses.
 *
 * Lifted out of the picker because two surfaces set it now — the title bar and the
 * settings overlay — and each holding its own copy would mean two answers to one question.
 */
export function usePalette(): [Palette, (next: Palette) => void] {
  const [palette, setPalette] = useState<Palette>(storedPalette);

  // Applied on mount as well as on change, so a remembered palette is on screen before the
  // first paint rather than flashing the default first.
  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  return [palette, setPalette];
}
