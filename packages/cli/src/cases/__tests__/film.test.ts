import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { checkFilm, clearFilmLeftovers, filmSeconds } from '../film.js';
import { mp4Of } from './mp4.js';

test('a film plays when its index says how long it is; an empty one, or one with no index, says why it does not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-film-'));
  const good = path.join(dir, 'good.mp4');
  fs.writeFileSync(good, mp4Of(2.5));
  assert.equal(filmSeconds(good), 2.5);
  assert.deepEqual(checkFilm(good), { bytes: fs.statSync(good).size, seconds: 2.5 });
  const empty = path.join(dir, 'empty.mp4');
  fs.writeFileSync(empty, '');
  assert.deepEqual(checkFilm(empty), { missing: 'the file is empty: the recorder never finished it' });
  // What trial 7's films were: frames written, the index never.
  const cut = path.join(dir, 'cut.mp4');
  fs.writeFileSync(cut, mp4Of(2.5).subarray(0, 40));
  assert.match((checkFilm(cut) as { missing: string }).missing, /^the file \(40 bytes\) has no index \(moov\)/);
  assert.deepEqual(checkFilm(path.join(dir, 'none.mp4')), { missing: 'the recorder wrote no file' });
  const still = path.join(dir, 'still.mp4');
  fs.writeFileSync(still, mp4Of(0));
  assert.deepEqual(checkFilm(still), { missing: 'the film holds no frames' });
});

test('what a recorder leaves beside a film it did not finish is removed, and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynkeus-film-'));
  const film = path.join(dir, 'video.mp4');
  for (const name of ['video.mp4', 'video.mp4.sb-7b31a107-UQhtrh', 'video.mp4.part', 'video.1.mp4', '01-app-press.avif'])
    fs.writeFileSync(path.join(dir, name), '');
  assert.equal(clearFilmLeftovers(film), 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['01-app-press.avif', 'video.1.mp4', 'video.mp4']);
});
