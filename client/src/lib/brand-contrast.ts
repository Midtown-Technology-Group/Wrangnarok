// SPDX-License-Identifier: AGPL-3.0
// Brand contrast safeguards (UX-01 slice 2, issue #176). Warn-only WCAG
// relative-luminance math over the Organization branding colors, plus the
// full-shell document application (title + theme-color) the header reskin
// alone does not cover.
//
// Deliberately advisory: the server accepts any well-formed hex and every
// check below only decides whether the admin preview shows a warning. No
// write is ever refused here, so a low-contrast brand stays usable while
// its legibility cost is stated plainly.
export interface BrandColors {
  readonly primaryColor: string;
  readonly accentColor: string;
}

export interface BrandContrastCheck {
  readonly id: string;
  /** Human-readable surface description, e.g. "White button text on primary". */
  readonly label: string;
  /** Contrast ratio, or null when either endpoint is not parseable hex. */
  readonly ratio: number | null;
  /** True when the ratio meets the floor, or when there is nothing to judge. */
  readonly passes: boolean;
}

/** Warn-only floor: WCAG 2.x non-text / large-text minimum. Normal body
 * text wants 4.5:1, but every surface checked here is large text or a UI
 * component, so 3:1 is the honest bar. */
export const BRAND_CONTRAST_FLOOR = 3;

/** Surfaces the custom colors paint over. Kept next to the stylesheet's
 * fallbacks: header gradient start, white button text, body text. */
export const BRAND_SURFACES = {
  headerBackground: "#0b0f14",
  buttonText: "#ffffff",
  bodyText: "#111820",
} as const;

export const DEFAULT_DOCUMENT_TITLE = "Wrangnarök";

interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Parse #rgb, #rrggbb, or #rrggbbaa (the server's accepted shapes, case
 * insensitive, surrounding whitespace tolerated). Anything else is null. */
export function parseBrandHex(value: string): Rgba | null {
  const hex = value.trim().replace(/^#/, "");
  const channel = (pair: string): number => Number.parseInt(pair, 16);
  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const [r = "", g = "", b = ""] = hex.split("");
    return { r: channel(r + r), g: channel(g + g), b: channel(b + b), a: 1 };
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    return {
      r: channel(hex.slice(0, 2)),
      g: channel(hex.slice(2, 4)),
      b: channel(hex.slice(4, 6)),
      a: 1,
    };
  }
  if (/^[0-9a-fA-F]{8}$/.test(hex)) {
    return {
      r: channel(hex.slice(0, 2)),
      g: channel(hex.slice(2, 4)),
      b: channel(hex.slice(4, 6)),
      a: channel(hex.slice(6, 8)) / 255,
    };
  }
  return null;
}

/** Alpha-composite a foreground over an opaque background. Opaque colors
 * pass through unchanged. */
function compositeOver(foreground: Rgba, background: Rgba): Rgba {
  if (foreground.a >= 1) return { r: foreground.r, g: foreground.g, b: foreground.b, a: 1 };
  const alpha = Math.max(0, Math.min(1, foreground.a));
  return {
    r: foreground.r * alpha + background.r * (1 - alpha),
    g: foreground.g * alpha + background.g * (1 - alpha),
    b: foreground.b * alpha + background.b * (1 - alpha),
    a: 1,
  };
}

function linearize(channel: number): number {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an opaque color. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * linearize(color.r) + 0.7152 * linearize(color.g) + 0.0722 * linearize(color.b);
}

/** WCAG contrast ratio of two hex colors. Paint order is explicit:
 * background over the page, then foreground over that result, so
 * translucent `#rrggbbaa` endpoints resolve against the surface they
 * actually render on. Null when either endpoint is not parseable hex. */
export function contrastRatioHex(foreground: string, background: string, page = "#ffffff"): number | null {
  const fg = parseBrandHex(foreground);
  const bg = parseBrandHex(background);
  const sheet = parseBrandHex(page);
  if (!fg || !bg || !sheet) return null;
  const base = compositeOver(bg, { ...sheet, a: 1 });
  const top = compositeOver(fg, base);
  const lighter = Math.max(relativeLuminance(top), relativeLuminance(base));
  const darker = Math.min(relativeLuminance(top), relativeLuminance(base));
  return (lighter + 0.05) / (darker + 0.05);
}

export function formatContrastRatio(ratio: number): string {
  return `${(Math.round(ratio * 10) / 10).toFixed(1)}:1`;
}

function check(
  id: string,
  label: string,
  foreground: string,
  background: string,
  page = "#ffffff",
): BrandContrastCheck {
  const ratio = contrastRatioHex(foreground, background, page);
  return { id, label, ratio, passes: ratio === null || ratio >= BRAND_CONTRAST_FLOOR };
}

/** The three surfaces custom brand colors must stay legible on: white
 * button text over primary, primary accents over the dark shell header,
 * and body text over accent chips. */
export function brandContrastChecks(colors: BrandColors): BrandContrastCheck[] {
  return [
    check(
      "primary-button-text",
      "White button text on the primary color",
      BRAND_SURFACES.buttonText,
      colors.primaryColor,
    ),
    check(
      "primary-on-header",
      "Primary accents on the dark shell header",
      colors.primaryColor,
      BRAND_SURFACES.headerBackground,
      BRAND_SURFACES.headerBackground,
    ),
    check("accent-on-body", "Body text on accent chips", BRAND_SURFACES.bodyText, colors.accentColor),
  ];
}

/** Apply loaded Organization branding to the document shell: title carries
 * the custom application name and theme-color tracks the primary color so
 * the full console (tab, bookmark, mobile chrome) reflects the brand, not
 * just the header. Null branding restores the static defaults. Guarded for
 * non-DOM renders: no document, no-op. */
export function applyBrandingToDocument(branding: { appName: string; primaryColor: string } | null): void {
  if (typeof document === "undefined") return;
  const doc = document as Document & { title: string };
  doc.title = branding?.appName?.trim() ? branding.appName : DEFAULT_DOCUMENT_TITLE;
  const meta = doc.querySelector('meta[name="theme-color"]');
  const primaryColor = branding?.primaryColor;
  const primary = primaryColor ? parseBrandHex(primaryColor) : null;
  if (primary && primaryColor && meta) {
    meta.setAttribute("content", primaryColor);
  } else if (primary && primaryColor && doc.head) {
    const created = doc.createElement("meta");
    created.setAttribute("name", "theme-color");
    created.setAttribute("content", primaryColor);
    doc.head.appendChild(created);
  } else if (!primary && meta) {
    meta.remove();
  }
}
