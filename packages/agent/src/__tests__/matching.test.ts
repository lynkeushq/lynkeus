import { describe, expect, it } from '@jest/globals';

import { pick, score } from '../handlers';
import type { Element } from '../protocol';

const el = (over: Partial<Element>): Element => ({
  i: 0,
  kind: 'view',
  frame: { x: 0, y: 0, w: 10, h: 10 },
  enabled: true,
  depth: 0,
  ...over,
});

describe('score', () => {
  it('finds a field by its placeholder, and only a field', () => {
    expect(score(el({ kind: 'input', placeholder: 'Email address' }), { text: 'email address' })).toBe(4);
    expect(score(el({ kind: 'input', placeholder: 'Email address', value: 'ana@x.io' }), { text: 'Email' })).toBe(2);
    expect(score(el({ kind: 'text', placeholder: 'Email address' }), { text: 'Email address' })).toBe(0);
  });

  it('finds a text drawn in capitals by the words as the source writes them', () => {
    expect(score(el({ kind: 'button', text: 'TAP TO LOG IN!' }), { text: 'Tap to log in!' })).toBe(4);
  });

  it('matches testId exactly', () => {
    expect(score(el({ testId: 'a' }), { testId: 'a' })).toBe(4);
    expect(score(el({ testId: 'ab' }), { testId: 'a' })).toBe(0);
  });

  it('prefers exact text on a control over the same text in a paragraph', () => {
    const button = el({ kind: 'button', text: 'Continue' });
    const paragraph = el({ kind: 'text', text: 'Continue' });
    expect(score(button, { text: 'continue' })).toBeGreaterThan(score(paragraph, { text: 'continue' }));
  });

  it('never targets a substring inside a paragraph', () => {
    const paragraph = el({ kind: 'text', text: 'By tapping Submit you accept the terms' });
    expect(score(paragraph, { text: 'accept' })).toBe(0);
    const button = el({ kind: 'button', text: 'Submit via email' });
    expect(score(button, { text: 'submit' })).toBe(2);
  });
});

describe('pick', () => {
  it('prefers the one a touch reaches when two share a testId', () => {
    const elements = [el({ i: 0, testId: 'slide', kind: 'button' }), el({ i: 1, testId: 'slide', kind: 'button', hidden: 'inert' })];
    expect(pick(elements, { testId: 'slide' })?.i).toBe(0);
  });

  it('takes the nth of several controls sharing a testId, in tree order, skipping hidden ones', () => {
    const elements = [
      el({ i: 0, kind: 'input', testId: 'field', value: 'street' }),
      el({ i: 1, kind: 'input', testId: 'field', hidden: 'behind-modal' }),
      el({ i: 2, kind: 'input', testId: 'field', value: 'city' }),
      el({ i: 3, kind: 'input', testId: 'field', value: 'zip' }),
    ];
    expect(pick(elements, { testId: 'field', nth: 1 })?.i).toBe(2);
    expect(pick(elements, { testId: 'field', nth: 5 })).toBeUndefined();
  });

  it('prefers reachable elements and takes the later of equal scores', () => {
    const elements = [
      el({ i: 0, kind: 'button', testId: 'go' }),
      el({ i: 1, kind: 'button', testId: 'go' }),
      el({ i: 2, kind: 'button', testId: 'go', covered: true }),
    ];
    expect(pick(elements, { testId: 'go' })?.i).toBe(1);
  });

  it('still finds a covered element when nothing reachable matches', () => {
    const otp = el({ i: 3, kind: 'input', testId: 'hidden-input', covered: true });
    expect(pick([el({ kind: 'button', text: 'Paste' }), otp], { testId: 'hidden-input' })).toBe(otp);
  });

  it('returns nothing for a point target', () => {
    expect(pick([el({ testId: 'x' })], { x: 1, y: 1 })).toBeUndefined();
  });
});

describe('a target within a scope', () => {
  const el = (i: number, over: Partial<Element>): Element => ({ i, kind: 'view', frame: { x: 0, y: i * 10, w: 100, h: 10 }, enabled: true, depth: 0, ...over });
  const feed: Element[] = [
    el(0, { testId: 'feed' }),
    el(1, { testId: 'row', parent: 0 }),
    el(2, { kind: 'text', text: 'hi from Ana', parent: 1 }),
    el(3, { kind: 'button', testId: 'like-message-button', parent: 1 }),
    el(4, { testId: 'row', parent: 0 }),
    el(5, { kind: 'text', text: 'hi from Beto', parent: 4 }),
    el(6, { kind: 'button', testId: 'like-message-button', parent: 4 }),
  ];

  it('takes the match in the smallest container around the scope', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Beto' } })?.i).toBe(6);
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Ana' } })?.i).toBe(3);
  });

  it('with rows that are not listed, takes the match nearest the scope in tree order', () => {
    const flat = feed.map((e) => (e.parent === 1 || e.parent === 4 ? { ...e, parent: 0 } : e)).filter((e) => e.testId !== 'row');
    expect(pick(flat, { testId: 'like-message-button', within: { text: 'hi from Ana' } })?.i).toBe(3);
    expect(pick(flat, { testId: 'like-message-button', within: { text: 'hi from Beto' } })?.i).toBe(6);
  });

  it('counts nth inside the scope', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { testId: 'feed' }, nth: 1 })?.i).toBe(6);
  });

  // Ignite's podcast list: each episode is an accessible Card whose label runs its children's words together.
  const episodes: Element[] = [
    el(0, { testId: 'episodes' }),
    el(1, { kind: 'button', accessibilityLabel: 'Apr 24, 202440:0RNR 300 - Offline firstFavorite', parent: 0 }),
    el(2, { kind: 'text', text: 'Apr 24, 2024', parent: 1 }),
    el(3, { kind: 'text', text: '40:0', parent: 1 }),
    el(4, { kind: 'text', text: 'RNR 300 - Offline first', parent: 1 }),
    el(5, { kind: 'button', accessibilityLabel: 'Favorite', parent: 1 }),
    el(6, { kind: 'text', text: 'Favorite', parent: 5 }),
    el(7, { kind: 'button', accessibilityLabel: 'Apr 17, 202438:0RNR 299 - HooksFavorite', parent: 0 }),
    el(8, { kind: 'text', text: 'Apr 17, 2024', parent: 7 }),
    el(9, { kind: 'text', text: '38:0', parent: 7 }),
    el(10, { kind: 'text', text: 'RNR 299 - Hooks', parent: 7 }),
    el(11, { kind: 'button', accessibilityLabel: 'Favorite', parent: 7 }),
    el(12, { kind: 'text', text: 'Favorite', parent: 11 }),
  ];

  it('takes the button labeled with the text over the card around it whose label only contains it', () => {
    expect(pick(episodes, { text: 'Favorite', within: { text: 'Offline first' } })?.i).toBe(5);
    expect(pick(episodes, { text: 'Favorite', within: { text: 'Hooks' } })?.i).toBe(11);
  });

  it('of matches nested in one another that answer equally, takes the innermost', () => {
    const relabeled: Record<number, Partial<Element>> = { 5: { accessibilityLabel: 'Add to favorites' }, 6: { kind: 'image', text: undefined } };
    const nested = episodes.map((e) => ({ ...e, ...relabeled[e.i] }));
    expect(pick(nested, { text: 'favorite', within: { text: 'Offline first' } })?.i).toBe(5);
  });

  it('still takes the card when nothing inside it answers', () => {
    expect(pick(episodes, { text: 'Offline first', within: { testId: 'episodes' } })?.i).toBe(1);
  });

  it('finds nothing when the scope is not there', () => {
    expect(pick(feed, { testId: 'like-message-button', within: { text: 'hi from Carla' } })).toBeUndefined();
  });
});
