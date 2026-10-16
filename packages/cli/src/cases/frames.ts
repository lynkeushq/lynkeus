import fs from 'node:fs';

type Encoder = (input: string) => { avif: (o: { quality: number; effort: number }) => { toFile: (path: string) => Promise<unknown> } };

let encoder: Promise<Encoder | null> | undefined;
// sharp is optional: a CLI installed without it keeps the PNG the host took.
const load = () => {
  const name = 'sharp';
  encoder ??= import(name).then((m: { default: Encoder }) => m.default).catch(() => null);
  return encoder;
};

/**
 * A simulator or emulator gives its frames as PNG (`simctl io screenshot` cannot write AVIF or WebP, nor can
 * `screencap`): a report frame is encoded again as AVIF, about 4% of the PNG's bytes in some 70 ms, and the
 * PNG removed. Answers the frame's path, the PNG's when it could not be encoded.
 */
export const compactFrame = async (png: string): Promise<string> => {
  const sharp = await load();
  if (!sharp || !png.endsWith('.png')) return png;
  const avif = `${png.slice(0, -'.png'.length)}.avif`;
  try {
    await sharp(png).avif({ quality: 60, effort: 2 }).toFile(avif);
    fs.unlinkSync(png);
    return avif;
  } catch {
    fs.rmSync(avif, { force: true });
    return png;
  }
};
