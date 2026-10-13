import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Element, Screen } from 'lynkeus-protocol';

import { contrastRatio, lintContrast, measureContrast, type Pixels, type Rgb } from '../knowledge/contrast.js';

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** A picture of one color, with rectangles of others painted on it. */
const picture = (width: number, height: number, background: Rgb, patches: { x: number; y: number; w: number; h: number; rgb: Rgb }[] = []): Pixels => {
  const data = new Uint8Array(width * height * 4);
  const paint = (x: number, y: number, rgb: Rgb) => data.set([...rgb, 255], (y * width + x) * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) paint(x, y, background);
  for (const patch of patches) for (let y = patch.y; y < patch.y + patch.h; y++) for (let x = patch.x; x < patch.x + patch.w; x++) paint(x, y, patch.rgb);
  return { width, height, data };
};

const element = (over: Partial<Element>): Element => ({
  i: 0,
  kind: 'text',
  frame: { x: 0, y: 0, w: 100, h: 20 },
  enabled: true,
  depth: 0,
  text: 'Balance',
  ...over,
});
const screen = (elements: Element[]): Screen => ({ elements, window: { w: 100, h: 100 } }) as Screen;

test('black on white is 21 to 1, and a color against itself is 1', () => {
  assert.equal(Math.round(contrastRatio(BLACK, WHITE)), 21);
  assert.equal(contrastRatio(WHITE, WHITE), 1);
});

test('the background is what most of the box has, and the text what stands furthest from it', () => {
  // Glyphs in mid gray with a paler fringe around them, as antialiasing leaves.
  const measured = measureContrast(
    picture(100, 20, WHITE, [
      { x: 10, y: 5, w: 40, h: 10, rgb: [200, 200, 200] },
      { x: 14, y: 7, w: 30, h: 6, rgb: [119, 119, 119] },
    ]),
    { x: 0, y: 0, w: 100, h: 20 },
  );
  assert.ok(measured);
  assert.deepEqual(measured.background.map(Math.round), WHITE);
  assert.deepEqual(measured.text.map(Math.round), [119, 119, 119]);
  assert.equal(measured.ratio.toFixed(1), '4.5');
  assert.equal(measured.plain, true);
});

test('a box of one color has no text to judge', () => {
  assert.equal(measureContrast(picture(100, 20, WHITE), { x: 0, y: 0, w: 100, h: 20 }), undefined);
});

test('pale gray text on white is a warning that names both colors and what it needs', () => {
  const [finding] = lintContrast(
    screen([element({ testId: 'balance-label' })]),
    picture(100, 100, WHITE, [{ x: 10, y: 5, w: 60, h: 8, rgb: [170, 170, 170] }]),
  );
  assert.ok(finding);
  assert.equal(finding.rule, 'low-contrast');
  assert.equal(finding.severity, 'warn');
  assert.match(finding.message, /^"Balance" 2\.3:1 \(#aaaaaa on #ffffff\), needs 4\.5:1$/);
});

test('large text needs 3 to 1: 18 points, or 14 and bold', () => {
  const shot = picture(100, 100, WHITE, [{ x: 10, y: 5, w: 60, h: 8, rgb: [140, 140, 140] }]);
  assert.equal(lintContrast(screen([element({ font: { size: 16 } })]), shot).length, 1);
  assert.equal(lintContrast(screen([element({ font: { size: 18 } })]), shot).length, 0);
  assert.equal(lintContrast(screen([element({ font: { size: 14, bold: true } })]), shot).length, 0);
  assert.match(
    lintContrast(screen([element({ font: { size: 20 } })]), picture(100, 100, WHITE, [{ x: 10, y: 5, w: 60, h: 8, rgb: [190, 190, 190] }]))[0]!.message,
    /needs 3:1 for large text$/,
  );
});

test('what cannot be read or used is not judged: disabled, hidden, covered, or left out by testID', () => {
  const shot = picture(100, 100, WHITE, [{ x: 10, y: 5, w: 60, h: 8, rgb: [200, 200, 200] }]);
  for (const over of [{ enabled: false }, { hidden: 'a11y' as const }, { covered: true }, { kind: 'view' as const }]) {
    assert.equal(lintContrast(screen([element(over)]), shot).length, 0, JSON.stringify(over));
  }
  assert.equal(lintContrast(screen([element({ testId: 'watermark' })]), shot, { ignore: [/^watermark$/] }).length, 0);
});

test('text over a picture is said, but only as information', () => {
  // No color has half the box: a photograph or a gradient behind the label.
  const bands = [0, 1, 2, 3, 4].map((n) => ({ x: n * 20, y: 0, w: 20, h: 20, rgb: [40 + n * 40, 90, 200 - n * 30] as Rgb }));
  const [finding] = lintContrast(screen([element({})]), picture(100, 100, [10, 10, 10], bands));
  assert.ok(finding);
  assert.equal(finding.severity, 'info');
  assert.match(finding.message, /over a varied background/);
});

test("points become the picture's pixels by the window's width", () => {
  // A 3x picture: the frame's 20 points down are pixels 60 to 120.
  const shot = picture(300, 300, WHITE, [{ x: 30, y: 70, w: 180, h: 24, rgb: [170, 170, 170] }]);
  assert.equal(lintContrast(screen([element({ frame: { x: 0, y: 20, w: 100, h: 20 } })]), shot).length, 1);
  assert.equal(lintContrast(screen([element({ frame: { x: 0, y: 60, w: 100, h: 20 } })]), shot).length, 0);
});
