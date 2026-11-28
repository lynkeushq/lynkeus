/** The smallest MP4 a player's index reader accepts: `ftyp`, then `moov` with a version 0 `mvhd` of the given length. */
export const mp4Of = (seconds: number): Buffer => {
  const box = (type: string, body: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0isom', 'latin1')), box('mdat', Buffer.alloc(16)), box('moov', box('mvhd', mvhd))]);
};
