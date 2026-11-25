// Paper for blank pages: plain, lined, grid or dots. The same geometry is drawn on screen, in the
// page thumbnails and into the saved PDF, so all three look alike. Sizes are in PDF points, in
// PDF user space (origin bottom-left).
export const PAPERS = ["plain", "lined", "grid", "dots"];
export const DEFAULT_PAPER = "plain";
export const paperOf = (blank) => (PAPERS.includes(blank?.paper) ? blank.paper : DEFAULT_PAPER);

const MM = 72 / 25.4;
const r2 = (v) => Math.round(v * 100) / 100;

// Layers of lines ([x0, y0, x1, y1, ...]) or dots ([x, y, ...]) for a w x h page.
export function paperLayers(paper, w, h) {
  if (paper === "lined") {
    const gap = 8 * MM;
    const lines = [];
    for (let y = h - 22 * MM; y >= 12 * MM; y -= gap) lines.push(0, r2(y), r2(w), r2(y));
    return [{ color: "#c2ccda", width: 0.6, lines }];
  }
  if (paper === "grid") {
    const gap = 5 * MM;
    const lines = [];
    for (let x = (w % gap) / 2; x <= w; x += gap) lines.push(r2(x), 0, r2(x), r2(h));
    for (let y = (h % gap) / 2; y <= h; y += gap) lines.push(0, r2(y), r2(w), r2(y));
    return [{ color: "#d6dde7", width: 0.45, lines }];
  }
  if (paper === "dots") {
    const gap = 5 * MM;
    const start = (len) => { const o = (len % gap) / 2; return o < gap / 4 ? o + gap / 2 : o; };
    const dots = [];
    for (let x = start(w); x < w; x += gap) for (let y = start(h); y < h; y += gap) dots.push(r2(x), r2(y));
    return [{ color: "#a9b3c1", r: 0.75, dots }];
  }
  return [];
}

// Draws the paper with ctx already in PDF space. `scale` (screen px per point) keeps lines from
// fading out in small thumbnails.
export function drawPaper(ctx, paper, w, h, scale = 1) {
  for (const layer of paperLayers(paper, w, h)) {
    ctx.save();
    ctx.beginPath();
    if (layer.lines) {
      const L = layer.lines;
      for (let i = 0; i < L.length; i += 4) { ctx.moveTo(L[i], L[i + 1]); ctx.lineTo(L[i + 2], L[i + 3]); }
      ctx.strokeStyle = layer.color;
      ctx.lineWidth = Math.max(layer.width, 0.55 / scale);
      ctx.stroke();
    } else {
      const D = layer.dots;
      const r = Math.max(layer.r, 0.6 / scale);
      for (let i = 0; i < D.length; i += 2) { ctx.moveTo(D[i] + r, D[i + 1]); ctx.arc(D[i], D[i + 1], r, 0, Math.PI * 2); }
      ctx.fillStyle = layer.color;
      ctx.fill();
    }
    ctx.restore();
  }
}
