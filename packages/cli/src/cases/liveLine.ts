/**
 * A status line kept at the bottom of a terminal while a run goes on. Everything else the process writes to the
 * same stream (a case's lines, an attach message) goes above it: the line is taken away, the text written, and
 * the line drawn again. It is cut to the terminal's width, so it never wraps and is always one line to take away.
 */
export type LiveStream = {
  write: (chunk: string | Uint8Array, ...rest: never[]) => boolean;
  columns?: number;
};

const CLEAR = '\r\x1b[2K';

// How many columns a character takes: emoji and East Asian wide ones two, joiners and variation selectors none.
const columnsOf = (char: string): number => {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    code >= 0x1f000 ||
    (code >= 0x2600 && code <= 0x27bf) ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  )
    return 2;
  return 1;
};

/** `text` cut to fit one row of `width` columns, a column to spare, with an ellipsis where it was cut. */
export const fit = (text: string, width: number): string => {
  const chars = [...text.replace(/\s+/g, ' ')];
  const room = Math.max(1, width - 1);
  const total = chars.reduce((n, c) => n + columnsOf(c), 0);
  if (total <= room) return chars.join('');
  // Room for the ellipsis too.
  const kept: string[] = [];
  let used = 0;
  for (const char of chars) {
    const w = columnsOf(char);
    if (used + w > room - 1) break;
    kept.push(char);
    used += w;
  }
  return `${kept.join('')}…`;
};

export class LiveLine {
  private readonly original: LiveStream['write'];
  private shown = '';
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly stream: LiveStream,
    private readonly render: () => string,
    every = 1000,
  ) {
    this.original = stream.write;
    // What anyone else writes goes above the line.
    stream.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
      this.take();
      const done = this.original.call(this.stream, chunk, ...rest);
      this.draw();
      return done;
    }) as LiveStream['write'];
    this.timer = setInterval(() => this.refresh(), every);
    this.timer.unref();
    this.draw();
  }

  /** Drawn again with what the run says now: after an event, and every second for the clock. */
  refresh(): void {
    if (this.stopped) return;
    this.take();
    this.draw();
  }

  /** The line taken away for good and the stream given back. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.take();
    this.stream.write = this.original;
  }

  private take(): void {
    if (!this.shown) return;
    this.original.call(this.stream, CLEAR);
    this.shown = '';
  }

  private draw(): void {
    if (this.stopped) return;
    // A terminal that does not say its width (some pseudo-terminals answer 0) gets the usual 80.
    const line = fit(this.render(), this.stream.columns || 80);
    if (!line) return;
    this.original.call(this.stream, line);
    this.shown = line;
  }
}
