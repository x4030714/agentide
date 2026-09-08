import { useEffect, useState } from "react";

/** Which colour palette the app wears. Orthogonal to `Appearance`; every palette ships both
 * modes. The default is the absence of the attribute, so `world.css` stays the base case. */
export type Palette =
  | "quiet"
  | "ferrous"
  | "halide"
  | "vellum"
  | "vscode"
  | "nord"
  | "gruvbox"
  | "dracula"
  | "solarized";

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
  {
    id: "vscode",
    label: "VS Code",
    note: "Dark+ greys and its blue. Opaque, not glass.",
  },
  // The four below take their hues from well-known editor themes and solve them here, so
  // each is that theme's character at this app's contrast floor rather than a port of it.
  { id: "nord", label: "Nord", note: "Cold blue-grey, in Nord's spirit. Solved, not copied." },
  { id: "gruvbox", label: "Gruvbox", note: "Warm retro amber, in Gruvbox's spirit." },
  { id: "dracula", label: "Dracula", note: "Near-black, purple and pink, Dracula's way." },
  { id: "solarized", label: "Solarized", note: "Teal and amber, tinted in both modes." },
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

/** Apply a palette to the document and remember it. The default removes the attribute rather
 * than setting `data-palette="quiet"`, so the selector in `world.css` needs no `:not()`. */
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

/** The palette, applied and remembered. Lifted out of the picker because two surfaces set it
 * — title bar and settings — and each holding a copy meant two answers to one question. */
export function usePalette(): [Palette, (next: Palette) => void] {
  const [palette, setPalette] = useState<Palette>(storedPalette);

  // Applied on mount as well as on change, so a remembered palette is on screen before the
  // first paint rather than flashing the default first.
  useEffect(() => {
    applyPalette(palette);
  }, [palette]);

  return [palette, setPalette];
}
