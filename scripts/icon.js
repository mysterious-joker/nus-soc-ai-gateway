// Render the project's existing geometric mark without external graphics tools.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const size = 512;
const pixels = Buffer.alloc(size * (1 + size * 4));
const distance = (x, y, ax, ay, bx, by) => {
  const t = Math.max(
    0,
    Math.min(
      1,
      ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) /
        ((bx - ax) ** 2 + (by - ay) ** 2),
    ),
  );
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
};
for (let y = 0; y < size; y++)
  for (let x = 0; x < size; x++) {
    const px = ((x - size * 0.18) / (size * 0.64)) * 34;
    const py = ((y - size * 0.18) / (size * 0.64)) * 34;
    const d = Math.min(
      distance(px, py, 7, 8, 16, 8),
      distance(px, py, 16, 8, 27, 26),
      distance(px, py, 7, 26, 16, 26),
      distance(px, py, 16, 26, 27, 8),
    );
    const mark = Math.min(
      d - 1.2,
      Math.hypot(px - 7, py - 8) - 3,
      Math.hypot(px - 7, py - 26) - 3,
    );
    const blend = Math.max(0, Math.min(1, 0.5 - (mark * size * 0.64) / 34));
    const offset = y * (1 + size * 4) + 1 + x * 4;
    const rounded =
      Math.hypot(
        Math.max(0, Math.abs(x - 255.5) - 160),
        Math.max(0, Math.abs(y - 255.5) - 160),
      ) < 95;
    [16, 21, 30].forEach(
      (v, i) =>
        (pixels[offset + i] = Math.round(v + ([168, 200, 255][i] - v) * blend)),
    );
    pixels[offset + 3] = rounded ? 255 : 0;
  }
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let i = 0; i < 8; i++)
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const head = Buffer.alloc(4),
    tail = Buffer.alloc(4);
  head.writeUInt32BE(data.length);
  tail.writeUInt32BE(crc(body));
  return Buffer.concat([head, body, tail]);
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const output = path.join(__dirname, "../build");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(
  path.join(output, "icon.png"),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
