// The menu bar icon, drawn here (no image file): a head and shoulders, as a template image (black
// with alpha), so macOS tints it for light and dark menu bars. `speaking` adds sound waves.

/** BGRA pixels, `size` square. */
export function iconPixels(size = 36, speaking = false) {
  const px = Buffer.alloc(size * size * 4);
  const s = size / 18; // drawn on an 18-point grid
  const put = (x, y, a) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i + 3] = Math.max(px[i + 3], Math.round(255 * Math.min(1, Math.max(0, a))));
  };
  // Anti-aliased discs and rings, sampled 4×4 per pixel.
  const shape = (inside) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let n = 0;
        for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) if (inside((x + (i + 0.5) / 4) / s, (y + (j + 0.5) / 4) / s)) n++;
        if (n) put(x, y, n / 16);
      }
    }
  };
  const cx = speaking ? 7 : 9;
  shape((x, y) => (x - cx) ** 2 + (y - 6) ** 2 <= 3.4 ** 2); // head
  shape((x, y) => y >= 11 && y <= 17 && (x - cx) ** 2 / 36 + (y - 17) ** 2 / 36 <= 1); // shoulders
  if (speaking) {
    for (const r of [3.2, 5.6]) {
      shape((x, y) => {
        const d = Math.hypot(x - 11.5, y - 6.5);
        return Math.abs(d - r) <= 0.7 && x > 12.2 && Math.abs(y - 6.5) < r * 0.75;
      });
    }
  }
  return px;
}
