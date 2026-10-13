/**
 * How well a screen's text stands out from what is behind it, measured on the pixels of a screenshot: the
 * colours an app declares say nothing of a label over a photo, a gradient or a translucent sheet.
 */
import type { Element, Screen } from 'lynkeus-protocol';

import type { Finding } from './lint.js';

export type Pixels = { width: number; height: number; data: Uint8Array | Buffer };
export type Rgb = [number, number, number];
export type Contrast = { ratio: number; text: Rgb; background: Rgb; plain: boolean };

export type ContrastOptions = {
  /** The least ratio for ordinary text (WCAG 2 AA asks 4.5). */
  normal?: number;
  /** The least ratio for large text: 18 points, or 14 and bold (WCAG 2 AA asks 3). */
  large?: number;
  /** testIDs left out: a watermark, a brand colour nobody may change. */
  ignore?: RegExp[];
};

const AA_NORMAL = 4.5;
const AA_LARGE = 3;
// A text box this uniform has a flat background; under it the text sits on a picture or a gradient.
const PLAIN_SHARE = 0.5;
// Enough pixels of one colour to be glyphs and not the fringe where a glyph meets its background.
const LEAST_SHARE = 0.004;
const LEAST_PIXELS = 6;

const channel = (value: number): number => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG's relative luminance of an sRGB colour. */
export const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG's contrast ratio, from 1 (the same colour) to 21 (black on white). */
export const contrastRatio = (a: Rgb, b: Rgb): number => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
};

export const hex = (rgb: Rgb): string => `#${rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

/**
 * The contrast of the text inside a rectangle of the picture, in pixels. The background is the colour most
 * of the rectangle has; the text is the colour, among those with enough pixels to be glyphs, that stands
 * furthest from it. Anything else in the box (an icon beside a label) can only raise the figure, so a low one
 * is a finding and a high one is not a certificate.
 */
export const measureContrast = (picture: Pixels, box: { x: number; y: number; w: number; h: number }): Contrast | undefined => {
  const left = Math.max(0, Math.floor(box.x));
  const top = Math.max(0, Math.floor(box.y));
  const right = Math.min(picture.width, Math.ceil(box.x + box.w));
  const bottom = Math.min(picture.height, Math.ceil(box.y + box.h));
  if (right - left < 2 || bottom - top < 2) return undefined;

  // Colours are gathered 8 levels to a bucket: antialiasing and compression never give one flat value.
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let total = 0;
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const at = (y * picture.width + x) * 4;
      const r = picture.data[at]!;
      const g = picture.data[at + 1]!;
      const b = picture.data[at + 2]!;
      const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count++;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
      total++;
    }
  }
  const colours = [...buckets.values()].map((bucket) => ({
    count: bucket.count,
    rgb: [bucket.r / bucket.count, bucket.g / bucket.count, bucket.b / bucket.count] as Rgb,
  }));
  const background = colours.reduce((most, colour) => (colour.count > most.count ? colour : most));
  const least = Math.max(LEAST_PIXELS, total * LEAST_SHARE);
  let best: { ratio: number; rgb: Rgb } | undefined;
  for (const colour of colours) {
    if (colour === background || colour.count < least) continue;
    const ratio = contrastRatio(colour.rgb, background.rgb);
    if (!best || ratio > best.ratio) best = { ratio, rgb: colour.rgb };
  }
  // Nothing but background: an empty field, or text the same colour as what is behind it.
  if (!best || best.ratio < 1.05) return undefined;
  return { ratio: best.ratio, text: best.rgb, background: background.rgb, plain: background.count / total >= PLAIN_SHARE };
};

const isLarge = (font: Element['font']): boolean => !!font && (font.size >= 18 || (font.size >= 14 && font.bold === true));

/** WCAG leaves out what cannot be used (a disabled control) and what is not there to be read. */
const judged = (e: Element): boolean =>
  !e.hidden &&
  !e.covered &&
  !e.offscreen &&
  e.enabled !== false &&
  (e.kind === 'text' || e.kind === 'button' || e.kind === 'input') &&
  (e.text ?? e.value ?? e.placeholder) !== undefined;

/** A finding for every text on the screen whose contrast falls short, most serious first. */
export const lintContrast = (screen: Screen, picture: Pixels, options: ContrastOptions = {}): Finding[] => {
  const window = screen.window;
  if (!window || window.w <= 0) return [];
  const scale = picture.width / window.w;
  const out: Finding[] = [];
  for (const e of screen.elements ?? []) {
    if (!judged(e) || !e.frame || e.frame.w <= 0 || e.frame.h <= 0) continue;
    if (e.testId && options.ignore?.some((pattern) => pattern.test(e.testId!))) continue;
    const measured = measureContrast(picture, { x: e.frame.x * scale, y: e.frame.y * scale, w: e.frame.w * scale, h: e.frame.h * scale });
    if (!measured) continue;
    const large = isLarge(e.font);
    const needed = large ? (options.large ?? AA_LARGE) : (options.normal ?? AA_NORMAL);
    if (measured.ratio >= needed) continue;
    const said = (e.text ?? e.value ?? e.placeholder ?? '').slice(0, 40);
    out.push({
      rule: 'low-contrast',
      // Over a picture the background is a guess, so it is said and left to a person.
      severity: measured.plain ? 'warn' : 'info',
      element: e.i,
      message: `"${said}" ${measured.ratio.toFixed(1)}:1 (${hex(measured.text)} on ${hex(measured.background)}${measured.plain ? '' : ', over a varied background'}), needs ${needed}:1${large ? ' for large text' : ''}`,
    });
  }
  return out;
};
