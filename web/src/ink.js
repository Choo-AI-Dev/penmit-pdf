// Handwriting: pen, highlighter, eraser (whole strokes or parts of them), pictures and lasso
// selection, with pressure, palm rejection and undo/redo.
//
// A document's ink is { id, strokes: { [strokeId]: Stroke }, images: { [imageId]: Picture },
//   deleted: { [id]: time }, pages: { [pageId]: Blank } }.
// Stroke = { id, page, tool: "pen" | "highlighter", color, width, opacity?, pts: [x, y, pressure, ...], t }
//   page is the PDF page index (0-based) or "b:<pageId>" for a blank page the user inserted.
// Picture = { id, page, src, mime, x, y, w, h, t }: a picture (src = SHA-256 of its bytes, which
//   are stored and synced as their own file) filling the box x, y (bottom-left), w x h points.
//   It is shown upright on screen whatever the page's rotation.
// Blank = { after, pos, w, h, t, paper?, u? }: a blank page placed after PDF page `after` (-1:
//   before the first), ordered by `pos` among blanks at the same place, w x h points, with
//   paper "plain" | "lined" | "grid" | "dots" (see paper.js); `u` is when the paper was changed.
// Points are in PDF user space (points, origin bottom-left), so they stay put at any zoom
// and map one-to-one onto PDF ink annotations. Strokes and pictures are never edited in place: a
// change (moving, recolouring, cutting) deletes the old one and adds a new one, so devices merge
// cleanly. Deleted ids (strokes, pictures and blank pages) are kept as tombstones so devices that
// sync later learn about the deletion instead of bringing it back.
import { PAPERS } from "./paper.js";

export const PEN_COLORS = ["#1b1f27", "#2453c9", "#d23b30", "#1f8a4c"];
export const HIGHLIGHT_COLORS = ["#ffd400", "#7be37b", "#ff8fc8", "#7fd4ff"];
export const WIDTHS = { pen: [0.8, 1.6, 3.2], highlighter: [8, 14, 22] }; // PDF points
export const HIGHLIGHT_OPACITY = 0.35;
export const ERASER_SIZES = [7, 12, 22]; // radius in screen px
const MAX_INK_PIXELS = 10_000_000;

export function emptyInk(id) {
  return { id, strokes: {}, images: {}, deleted: {}, pages: {} };
}

export const isPicture = (o) => typeof o?.src === "string";

export const blankKey = (id) => `b:${id}`;

// Live blank pages as [{ id, after, pos, w, h, t }].
export function blankPages(model) {
  return Object.entries(model?.pages || {}).map(([id, b]) => ({ id, ...b }));
}

export function newId() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return [...crypto.getRandomValues(new Uint8Array(10))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Width factor from pen pressure; 0.5 (mouse, or a pen without pressure) gives the nominal width.
export const pressureFactor = (p) => 0.45 + 1.1 * Math.min(1, Math.max(0, p));

function byPage(items) {
  const map = new Map();
  for (const s of items) {
    if (!map.has(s.page)) map.set(s.page, []);
    map.get(s.page).push(s);
  }
  for (const list of map.values()) list.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return map;
}
export const strokesByPage = (model) => byPage(Object.values(model.strokes));
export const picturesByPage = (model) => byPage(Object.values(model.images || {}));

// Screen box (CSS px inside the page) of a PDF-space box, for a page viewport transform T.
export function screenBox(T, b) {
  const xs = [], ys = [];
  for (const [x, y] of [[b.x0, b.y0], [b.x1, b.y0], [b.x0, b.y1], [b.x1, b.y1]]) {
    xs.push(T[0] * x + T[2] * y + T[4]);
    ys.push(T[1] * x + T[3] * y + T[5]);
  }
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

const pictureBox = (im) => ({ x0: im.x, y0: im.y, x1: im.x + im.w, y1: im.y + im.h });

// Draws a picture upright on screen. ctx is in screen pixels (no PDF transform), T is the page's
// viewport transform and k the extra scale of the canvas. Pictures whose file hasn't arrived
// yet show as a grey box.
export function drawPicture(ctx, im, T, bitmap, k = 1) {
  const r = screenBox(T, pictureBox(im));
  const x = r.left * k, y = r.top * k, w = (r.right - r.left) * k, h = (r.bottom - r.top) * k;
  if (bitmap) {
    ctx.drawImage(bitmap, x, y, w, h);
    return;
  }
  ctx.save();
  ctx.fillStyle = "#eef1f4";
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = "#c9d0d9";
  ctx.lineWidth = Math.max(1, k);
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.restore();
}

export function drawStroke(ctx, s) {
  const pts = s.pts;
  const n = pts.length / 3;
  if (!n) return;
  ctx.save();
  ctx.strokeStyle = ctx.fillStyle = s.color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (s.tool === "highlighter") {
    ctx.globalAlpha = s.opacity ?? HIGHLIGHT_OPACITY;
    ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    if (n === 1) ctx.lineTo(pts[0] + 0.01, pts[1]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(pts[i * 3], pts[i * 3 + 1], (pts[i * 3] + pts[i * 3 + 3]) / 2, (pts[i * 3 + 1] + pts[i * 3 + 4]) / 2);
    }
    if (n > 1) ctx.lineTo(pts[(n - 1) * 3], pts[(n - 1) * 3 + 1]);
    ctx.stroke();
  } else if (n === 1) {
    ctx.beginPath();
    ctx.arc(pts[0], pts[1], (s.width * pressureFactor(pts[2])) / 2, 0, Math.PI * 2);
    ctx.fill();
  } else {
    let px = pts[0];
    let py = pts[1];
    for (let i = 1; i < n; i++) {
      const x = pts[i * 3];
      const y = pts[i * 3 + 1];
      const last = i === n - 1;
      const mx = last ? x : (x + pts[i * 3 + 3]) / 2;
      const my = last ? y : (y + pts[i * 3 + 4]) / 2;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(x, y, mx, my);
      ctx.lineWidth = s.width * pressureFactor((pts[i * 3 - 1] + pts[i * 3 + 2]) / 2);
      ctx.stroke();
      px = mx;
      py = my;
    }
  }
  ctx.restore();
}

const bboxCache = new WeakMap();
function bbox(s) {
  let b = bboxCache.get(s);
  if (!b) {
    b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (let i = 0; i < s.pts.length; i += 3) {
      b.x0 = Math.min(b.x0, s.pts[i]); b.x1 = Math.max(b.x1, s.pts[i]);
      b.y0 = Math.min(b.y0, s.pts[i + 1]); b.y1 = Math.max(b.y1, s.pts[i + 1]);
    }
    bboxCache.set(s, b);
  }
  return b;
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx - px;
  const y = ay + t * dy - py;
  return x * x + y * y;
}

function hits(s, x, y, r) {
  const b = bbox(s);
  const pad = r + s.width;
  if (x < b.x0 - pad || x > b.x1 + pad || y < b.y0 - pad || y > b.y1 + pad) return false;
  const lim = r + s.width / 2;
  const lim2 = lim * lim;
  const p = s.pts;
  if (p.length === 3) return (p[0] - x) ** 2 + (p[1] - y) ** 2 <= lim2;
  for (let i = 3; i < p.length; i += 3) {
    if (segDist2(x, y, p[i - 3], p[i - 2], p[i], p[i + 1]) <= lim2) return true;
  }
  return false;
}

const round2 = (v) => Math.round(v * 100) / 100;

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// The parts of a stroke left after erasing a circle (cx, cy, r): runs of points outside it.
// Segments that cross the circle are subdivided so the cut follows the eraser.
function cutStroke(s, cx, cy, r) {
  const p = s.pts;
  const r2 = r * r;
  const out = (x, y) => (x - cx) ** 2 + (y - cy) ** 2 > r2;
  const runs = [];
  let run = [];
  const keep = (x, y, pr) => { if (out(x, y)) run.push(round2(x), round2(y), pr); else if (run.length) { runs.push(run); run = []; } };
  keep(p[0], p[1], p[2]);
  const step = Math.max(r / 3, 0.2);
  for (let i = 3; i < p.length; i += 3) {
    const ax = p[i - 3], ay = p[i - 2], bx = p[i], by = p[i + 1];
    if (segDist2(cx, cy, ax, ay, bx, by) <= r2) {
      const n = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
      for (let k = 1; k < n; k++) {
        const f = k / n;
        keep(ax + (bx - ax) * f, ay + (by - ay) * f, round2(p[i - 1] + (p[i + 2] - p[i - 1]) * f));
      }
    }
    keep(bx, by, p[i + 2]);
  }
  if (run.length) runs.push(run);
  // Single points left at the edge of a cut read as stray dots.
  return runs.filter((pts) => pts.length >= 6 || p.length === 3);
}

function mapStroke(s, fx, fy, widthFactor = 1) {
  if (isPicture(s)) {
    return { ...s, x: round2(fx(s.x)), y: round2(fy(s.y)), w: round2(s.w * widthFactor), h: round2(s.h * widthFactor) };
  }
  const pts = s.pts.slice();
  for (let i = 0; i < pts.length; i += 3) {
    pts[i] = round2(fx(pts[i]));
    pts[i + 1] = round2(fy(pts[i + 1]));
  }
  return { ...s, pts, width: round2(s.width * widthFactor) };
}

// Which blank pages there are and what paper each has.
const pagesSignature = (model) => JSON.stringify(Object.entries(model?.pages || {})
  .map(([id, b]) => [id, b.paper || "plain"]).sort((a, b) => (a[0] < b[0] ? -1 : 1)));

export class Ink extends EventTarget {
  constructor(viewer) {
    super();
    this.viewer = viewer;
    this.scroller = viewer.scroller;
    this.model = null;
    this.byPage = new Map();
    this.picsByPage = new Map();
    // Where pictures' bytes come from: async (src) -> Blob | null. Set by the app.
    this.imageSource = null;
    this.bitmaps = new Map(); // src -> { state: "loading" | "ready" | "missing" | "error", img }
    this.tool = "pen";
    this.style = {
      pen: { color: PEN_COLORS[0], width: WIDTHS.pen[1] },
      highlighter: { color: HIGHLIGHT_COLORS[0], width: WIDTHS.highlighter[1] },
      eraser: { mode: "stroke", size: 1 },
    };
    this.fingerDraw = false;
    this.focusKey = null;
    this.active = null;
    this.drag = null;
    this.sel = null;      // { page, items, strokes, pictures, box: { x0, y0, x1, y1 }, el, bar }
    this.xform = null;    // moving or resizing the selection
    this.lastPenAt = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.liveRaf = 0;
    this.xformRaf = 0;

    viewer.addEventListener("relayout", () => { this.#refreshVisible(true); this.#placeSelection(); });
    viewer.addEventListener("visibility", () => this.#refreshVisible(false));
    viewer.addEventListener("gesturestart", () => this.#cancelActive());
    viewer.addEventListener("pagesrebuilt", () => { this.clearSelection(); this.#index(); this.redrawAll(); });

    const pages = viewer.pagesEl;
    pages.addEventListener("pointerdown", (e) => this.#down(e));
    pages.addEventListener("pointermove", (e) => this.#move(e));
    pages.addEventListener("pointerup", (e) => this.#up(e, false));
    pages.addEventListener("pointercancel", (e) => this.#up(e, true));
    pages.addEventListener("lostpointercapture", (e) => {
      if (this.active?.pointerId === e.pointerId || this.xform?.pointerId === e.pointerId) this.#up(e, false);
    });

    // Keep the page from scrolling under the pen (and under a finger while it draws).
    // pointerdown fires before touchstart, so `active` is already set for a stroke.
    this.scroller.addEventListener("touchstart", (e) => {
      const stylus = [...e.changedTouches].some((t) => t.touchType === "stylus");
      if (this.active || this.xform || (stylus && this.tool !== "hand")) e.preventDefault();
    }, { passive: false });
    this.scroller.addEventListener("touchmove", (e) => {
      if (this.active || this.xform) e.preventDefault();
    }, { passive: false });
  }

  setModel(model) {
    this.clearSelection();
    if (!model.pages) model.pages = {};
    if (!model.images) model.images = {};
    if (this.model?.id !== model.id) this.#forgetBitmaps();
    this.model = model;
    this.#index();
    this.undoStack = [];
    this.redoStack = [];
    this.#emit("history");
    this.redrawAll();
  }

  setTool(tool) {
    if (tool !== "lasso") this.clearSelection();
    this.tool = tool;
    this.scroller.dataset.tool = tool;
  }

  setFingerDraw(on) {
    this.fingerDraw = on;
    this.viewer.pagesEl.classList.toggle("finger-draw", on);
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get eraserRadiusPx() { return ERASER_SIZES[this.style.eraser.size] ?? ERASER_SIZES[1]; }

  #pageOf(key) { return this.viewer.byKey?.get(key); }

  #index() {
    const m = this.model || emptyInk("");
    this.byPage = strokesByPage(m);
    this.picsByPage = picturesByPage(m);
  }

  // ---------- pictures' bitmaps ----------

  // The decoded picture, or null while it loads (the page is redrawn when it is ready).
  bitmap(src) {
    let b = this.bitmaps.get(src);
    if (!b) {
      b = { state: "loading", img: null };
      this.bitmaps.set(src, b);
      this.#loadBitmap(src, b);
    }
    return b.state === "ready" ? b.img : null;
  }

  async #loadBitmap(src, b) {
    let blob = null;
    try { blob = await this.imageSource?.(src); } catch { blob = null; }
    if (this.bitmaps.get(src) !== b) return;
    if (!blob) { b.state = "missing"; return; } // not downloaded yet: see pictureArrived()
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    try {
      await img.decode();
      b.img = img;
      b.url = url;
      b.state = "ready";
    } catch {
      URL.revokeObjectURL(url);
      b.state = "error";
    }
    if (this.bitmaps.get(src) !== b) return;
    for (const p of this.viewer.visible) {
      if ((this.picsByPage.get(p.key) || []).some((im) => im.src === src)) this.#drawPictures(p);
    }
    this.#emit("bitmap");
  }

  // A picture's file was stored (pasted here or downloaded by a sync): draw it where it was missing.
  pictureArrived(src) {
    const b = this.bitmaps.get(src);
    if (b && b.state !== "ready" && b.state !== "loading") {
      this.bitmaps.delete(src);
      for (const p of this.viewer.visible) {
        if ((this.picsByPage.get(p.key) || []).some((im) => im.src === src)) this.#drawPictures(p);
      }
    }
  }

  #forgetBitmaps() {
    for (const b of this.bitmaps.values()) if (b.url) URL.revokeObjectURL(b.url);
    this.bitmaps.clear();
  }

  // ---------- drawing on screen ----------

  #inkScale(p) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const css = p.w * p.h * this.viewer.scale * this.viewer.scale;
    return Math.max(0.5, Math.min(dpr, Math.sqrt(MAX_INK_PIXELS / css)));
  }

  #prepare(canvas, p) {
    const k = this.#inkScale(p);
    const w = Math.max(1, Math.round(p.w * this.viewer.scale * k));
    const h = Math.max(1, Math.round(p.h * this.viewer.scale * k));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const T = p.viewport.transform;
    ctx.setTransform(T[0] * k, T[1] * k, T[2] * k, T[3] * k, T[4] * k, T[5] * k);
    return ctx;
  }

  // `preview` swaps strokes and pictures for moved or resized copies while the selection is dragged.
  drawPage(p, preview = null) {
    if (!this.model) return;
    const ctx = this.#prepare(p.inkCanvas, p);
    for (const s of this.byPage.get(p.key) || []) drawStroke(ctx, preview?.get(s.id) || s);
    this.#drawPictures(p, preview);
    p.inkScale = this.viewer.scale;
  }

  #drawPictures(p, preview = null) {
    const list = this.picsByPage.get(p.key) || [];
    const canvas = p.imgCanvas;
    if (!canvas) return;
    if (!list.length) {
      if (canvas.width) canvas.width = canvas.height = 0;
      return;
    }
    const ctx = this.#prepare(canvas, p);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const k = this.#inkScale(p);
    for (const im of list) {
      const o = preview?.get(im.id) || im;
      drawPicture(ctx, o, p.viewport.transform, this.bitmap(o.src), k);
    }
  }

  #hide(p) {
    p.inkCanvas.width = p.inkCanvas.height = 0;
    if (p.imgCanvas?.width) p.imgCanvas.width = p.imgCanvas.height = 0;
    p.inkScale = 0;
  }

  redrawAll() {
    for (const p of this.viewer.pages) {
      if (this.viewer.visible.has(p)) this.drawPage(p);
      else this.#hide(p);
    }
  }

  #refreshVisible(force) {
    if (!this.model) return;
    for (const p of this.viewer.pages) {
      const vis = this.viewer.visible.has(p);
      if (vis && (force || p.inkScale !== this.viewer.scale)) this.drawPage(p);
      else if (!vis && p.inkScale) this.#hide(p);
    }
  }

  #drawLive() {
    this.liveRaf = 0;
    const a = this.active;
    if (!a) return;
    const ctx = this.#prepare(a.page.liveCanvas, a.page);
    const n = a.pts.length;
    if (a.tool === "eraser") {
      if (!n) return;
      ctx.beginPath();
      ctx.arc(a.pts[n - 3], a.pts[n - 2], this.eraserRadiusPx / this.viewer.scale, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 / this.viewer.scale;
      ctx.strokeStyle = "rgba(90, 100, 120, .85)";
      ctx.fillStyle = "rgba(255, 255, 255, .35)";
      ctx.fill();
      ctx.stroke();
      return;
    }
    if (a.tool === "lasso") {
      if (n < 6) return;
      ctx.beginPath();
      ctx.moveTo(a.pts[0], a.pts[1]);
      for (let i = 3; i < n; i += 3) ctx.lineTo(a.pts[i], a.pts[i + 1]);
      ctx.closePath();
      ctx.setLineDash([5 / this.viewer.scale, 4 / this.viewer.scale]);
      ctx.lineWidth = 1.5 / this.viewer.scale;
      ctx.strokeStyle = "#3a6ef2";
      ctx.fillStyle = "rgba(58, 110, 242, .06)";
      ctx.fill();
      ctx.stroke();
      return;
    }
    drawStroke(ctx, { tool: a.tool, color: a.color, width: a.width, opacity: HIGHLIGHT_OPACITY, pts: a.pts });
  }

  #clearLive(p) {
    p.liveCanvas.width = p.liveCanvas.height = 0;
  }

  // ---------- input ----------

  #down(e) {
    if (e.target.closest?.(".sel-bar")) return; // the selection's buttons handle their own clicks
    const el = e.target.closest?.(".page");
    const p = el?.__page;
    if (!p || !this.model) return;
    if (e.pointerType === "pen") {
      this.lastPenAt = performance.now();
      this.#emit("pen");
    }
    if (this.viewer.gesture) return;

    // Dragging the selection (any finger, pen or mouse).
    const handle = e.target.closest?.("[data-sel]")?.dataset.sel;
    if (handle && this.sel && !this.xform) {
      this.#startXform(e, handle, el);
      return;
    }

    if (this.tool === "hand") {
      if (e.pointerType === "mouse" && e.button === 0) {
        this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        this.scroller.classList.add("dragging");
        el.setPointerCapture?.(e.pointerId);
        e.preventDefault();
      }
      return;
    }

    const canDraw =
      e.pointerType === "pen" ||
      (e.pointerType === "mouse" && e.button === 0) ||
      (e.pointerType === "touch" && this.fingerDraw && e.isPrimary && performance.now() - this.lastPenAt > 1500);
    if (!canDraw || this.active) return;

    if (this.tool === "lasso") this.clearSelection();
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const style = this.style[this.tool] || {};
    this.active = {
      pointerId: e.pointerId,
      page: p,
      tool: this.tool,
      color: style.color,
      width: style.width,
      rect: el.getBoundingClientRect(),
      pts: [],
      erased: [],          // strokes that existed before this eraser gesture and are now gone
      added: new Map(),    // pieces the partial eraser left behind
    };
    this.#addPoints(e);
  }

  #move(e) {
    if (this.drag && e.pointerId === this.drag.id) {
      this.scroller.scrollLeft -= e.clientX - this.drag.x;
      this.scroller.scrollTop -= e.clientY - this.drag.y;
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      return;
    }
    if (this.xform && e.pointerId === this.xform.pointerId) {
      e.preventDefault();
      this.#updateXform(e);
      return;
    }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    e.preventDefault();
    this.#addPoints(e);
  }

  #toPdf(p, rect, clientX, clientY) {
    return p.viewport.convertToPdfPoint(clientX - rect.left, clientY - rect.top);
  }

  #addPoints(e) {
    const a = this.active;
    const events = e.getCoalescedEvents?.() || [];
    const list = events.length ? events : [e];
    const minStep = (a.tool === "lasso" ? 2 : 0.35) / this.viewer.scale;
    for (const ev of list) {
      const [x, y] = this.#toPdf(a.page, a.rect, ev.clientX, ev.clientY);
      const pressure = ev.pointerType === "pen" ? (ev.pressure > 0 ? ev.pressure : 0.5) : 0.5;
      const n = a.pts.length;
      if (n && Math.hypot(x - a.pts[n - 3], y - a.pts[n - 2]) < minStep) continue;
      a.pts.push(round2(x), round2(y), round2(pressure));
      if (a.tool === "eraser") this.#eraseAt(a.page, x, y);
    }
    if (!this.liveRaf) this.liveRaf = requestAnimationFrame(() => this.#drawLive());
  }

  #up(e, cancelled) {
    if (this.drag && e.pointerId === this.drag.id) {
      this.drag = null;
      this.scroller.classList.remove("dragging");
      return;
    }
    if (this.xform && e.pointerId === this.xform.pointerId) {
      this.#endXform(cancelled);
      return;
    }
    const a = this.active;
    if (!a || e.pointerId !== a.pointerId) return;
    this.active = null;
    if (this.liveRaf) { cancelAnimationFrame(this.liveRaf); this.liveRaf = 0; }
    this.#clearLive(a.page);
    if (a.tool === "eraser") { this.#finishErase(a); return; }
    if (a.tool === "lasso") { if (!cancelled) this.#select(a.page, a.pts); return; }
    if (cancelled || !a.pts.length) return;
    const stroke = {
      id: newId(),
      page: a.page.key,
      tool: a.tool,
      color: a.color,
      width: a.width,
      pts: a.pts,
      t: Date.now(),
    };
    if (a.tool === "highlighter") stroke.opacity = HIGHLIGHT_OPACITY;
    this.#add(stroke);
    this.#push({ type: "add", items: [stroke] });
    this.#changed();
  }

  #cancelActive() {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.#clearLive(a.page);
    if (a.tool === "eraser") this.#finishErase(a);
  }

  // ---------- eraser ----------

  #eraseAt(p, x, y) {
    const r = this.eraserRadiusPx / this.viewer.scale;
    const list = this.byPage.get(p.key);
    if (!list?.length) return;
    const hit = list.filter((s) => hits(s, x, y, r));
    if (!hit.length) return;
    const a = this.active;
    for (const s of hit) {
      this.#remove(s);
      if (a.added.has(s.id)) a.added.delete(s.id); else a.erased.push(s);
      if (this.style.eraser.mode !== "partial") continue;
      for (const pts of cutStroke(s, x, y, r + s.width / 2)) {
        const piece = { ...s, id: newId(), pts };
        this.#add(piece);
        a.added.set(piece.id, piece);
      }
    }
    this.drawPage(p);
    this.#changed();
  }

  #finishErase(a) {
    const added = [...a.added.values()];
    if (!a.erased.length && !added.length) return;
    this.#push(added.length ? { type: "replace", before: a.erased, after: added } : { type: "erase", items: a.erased });
  }

  // ---------- lasso selection ----------

  #select(p, pts) {
    const pictures = this.picsByPage.get(p.key) || [];
    if (!pts.length) return;
    // A tap picks the topmost picture under it.
    let far = 0;
    for (let i = 3; i < pts.length; i += 3) far = Math.max(far, Math.hypot(pts[i] - pts[0], pts[i + 1] - pts[1]));
    if (far * this.viewer.scale < 8) {
      const [x, y] = pts;
      const hit = pictures.filter((im) => x >= im.x && x <= im.x + im.w && y >= im.y && y <= im.y + im.h).pop();
      if (hit) this.#setSelection(p, [hit]);
      return;
    }
    if (pts.length < 9) return;
    const poly = [];
    for (let i = 0; i < pts.length; i += 3) poly.push(pts[i], pts[i + 1]);
    const chosen = (this.byPage.get(p.key) || []).filter((s) => {
      let inside = 0;
      const n = s.pts.length / 3;
      for (let i = 0; i < s.pts.length; i += 3) if (inPolygon(s.pts[i], s.pts[i + 1], poly)) inside++;
      return inside > 0 && inside >= n * 0.5;
    });
    // A picture is chosen when the loop goes around its middle.
    for (const im of pictures) if (inPolygon(im.x + im.w / 2, im.y + im.h / 2, poly)) chosen.push(im);
    if (chosen.length) this.#setSelection(p, chosen);
  }

  #setSelection(p, items) {
    this.clearSelection();
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of items) {
      const b = isPicture(s) ? pictureBox(s) : bbox(s);
      const pad = isPicture(s) ? 0 : s.width / 2;
      x0 = Math.min(x0, b.x0 - pad); y0 = Math.min(y0, b.y0 - pad);
      x1 = Math.max(x1, b.x1 + pad); y1 = Math.max(y1, b.y1 + pad);
    }
    const el = document.createElement("div");
    el.className = "selection";
    el.dataset.sel = "move";
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = document.createElement("span");
      h.className = `sel-handle ${corner}`;
      h.dataset.sel = corner;
      el.append(h);
    }
    const bar = document.createElement("div");
    bar.className = "sel-bar";
    bar.setAttribute("role", "toolbar");
    p.el.append(el, bar);
    this.sel = {
      page: p, items, box: { x0, y0, x1, y1 }, el, bar,
      strokes: items.filter((s) => !isPicture(s)),
      pictures: items.filter(isPicture),
    };
    this.#placeSelection();
    this.#emit("selection");
  }

  clearSelection() {
    if (!this.sel) return;
    this.sel.el.remove();
    this.sel.bar.remove();
    this.sel = null;
    this.#emit("selection");
  }

  get selection() { return this.sel; }

  // Screen box (CSS px inside the page) of a PDF-space box.
  #screenBox(p, b) { return screenBox(p.viewport.transform, b); }

  #placeSelection(box = this.sel?.box) {
    const sel = this.sel;
    if (!sel) return;
    const r = this.#screenBox(sel.page, box);
    const pad = 6;
    Object.assign(sel.el.style, {
      left: `${r.left - pad}px`, top: `${r.top - pad}px`,
      width: `${r.right - r.left + pad * 2}px`, height: `${r.bottom - r.top + pad * 2}px`,
    });
    // The buttons sit above the box, or below it when the box is at the top of the page.
    const above = r.top - pad - 52 > 0;
    sel.bar.style.left = `${(r.left + r.right) / 2}px`;
    sel.bar.style.top = above ? `${r.top - pad - 50}px` : `${r.bottom + pad + 8}px`;
  }

  #startXform(e, handle, el) {
    const sel = this.sel;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const rect = sel.page.el.getBoundingClientRect();
    const [x, y] = this.#toPdf(sel.page, rect, e.clientX, e.clientY);
    // Handles are named by where they are on screen; work out which PDF-space corners they are
    // (PDF y grows upwards, and the page may be rotated).
    const r = this.#screenBox(sel.page, sel.box);
    const screen = { nw: [r.left, r.top], ne: [r.right, r.top], sw: [r.left, r.bottom], se: [r.right, r.bottom] };
    const opposite = { nw: "se", ne: "sw", sw: "ne", se: "nw" };
    const corner = (name) => sel.page.viewport.convertToPdfPoint(...screen[name]);
    this.xform = {
      pointerId: e.pointerId,
      rect,
      kind: handle === "move" ? "move" : "scale",
      start: [x, y],
      from: handle === "move" ? null : corner(handle),
      anchor: handle === "move" ? null : corner(opposite[handle]),
      dx: 0, dy: 0, f: 1,
    };
    sel.el.classList.add("dragging");
  }

  #updateXform(e) {
    const x = this.xform;
    const [px, py] = this.#toPdf(this.sel.page, x.rect, e.clientX, e.clientY);
    if (x.kind === "move") {
      x.dx = px - x.start[0];
      x.dy = py - x.start[1];
    } else {
      const [ax, ay] = x.anchor;
      const vx = x.from[0] - ax, vy = x.from[1] - ay;
      const len2 = vx * vx + vy * vy || 1;
      x.f = Math.min(10, Math.max(0.1, ((px - ax) * vx + (py - ay) * vy) / len2));
    }
    if (!this.xformRaf) this.xformRaf = requestAnimationFrame(() => {
      this.xformRaf = 0;
      if (!this.xform || !this.sel) return;
      const preview = new Map(this.sel.items.map((s) => [s.id, this.#transformed(s)]));
      this.drawPage(this.sel.page, preview);
      this.#placeSelection(this.#transformedBox(this.sel.box));
    });
  }

  #transformed(s) {
    const x = this.xform;
    if (x.kind === "move") return mapStroke(s, (v) => v + x.dx, (v) => v + x.dy);
    const [ax, ay] = x.anchor;
    return mapStroke(s, (v) => ax + (v - ax) * x.f, (v) => ay + (v - ay) * x.f, x.f);
  }

  #transformedBox(b) {
    const x = this.xform;
    if (x.kind === "move") return { x0: b.x0 + x.dx, y0: b.y0 + x.dy, x1: b.x1 + x.dx, y1: b.y1 + x.dy };
    const [ax, ay] = x.anchor;
    const xs = [ax + (b.x0 - ax) * x.f, ax + (b.x1 - ax) * x.f];
    const ys = [ay + (b.y0 - ay) * x.f, ay + (b.y1 - ay) * x.f];
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  }

  #endXform(cancelled) {
    const x = this.xform;
    const sel = this.sel;
    if (this.xformRaf) { cancelAnimationFrame(this.xformRaf); this.xformRaf = 0; }
    this.xform = null;
    if (!sel) return;
    sel.el.classList.remove("dragging");
    const still = x.kind === "move" ? Math.hypot(x.dx, x.dy) < 0.2 : Math.abs(x.f - 1) < 0.005;
    if (cancelled || still) {
      this.drawPage(sel.page);
      this.#placeSelection();
      return;
    }
    this.xform = x; // #transformed reads it
    const after = sel.items.map((s) => ({ ...this.#transformed(s), id: newId() }));
    this.xform = null;
    this.#replace(sel.items, after);
    this.#setSelection(sel.page, after);
  }

  // Changes to the selection, used by its buttons. Colours apply to the strokes only.
  recolorSelection(index) {
    const sel = this.sel;
    if (!sel?.strokes.length) return;
    const after = sel.strokes.map((s) => ({
      ...s, id: newId(),
      color: s.tool === "highlighter" ? HIGHLIGHT_COLORS[index] : PEN_COLORS[index],
    }));
    this.#replace(sel.strokes, after);
    this.#setSelection(sel.page, [...after, ...sel.pictures]);
  }

  duplicateSelection() {
    const sel = this.sel;
    if (!sel) return;
    const off = 14;
    const now = Date.now();
    const copies = sel.items.map((s, i) => ({ ...mapStroke(s, (v) => v + off, (v) => v - off), id: newId(), t: now + i * 1e-3 }));
    for (const c of copies) this.#add(c, true);
    this.#push({ type: "add", items: copies });
    this.#changed();
    this.#setSelection(sel.page, copies);
  }

  deleteSelection() {
    const sel = this.sel;
    if (!sel) return;
    this.clearSelection();
    this.#removeAll(sel.items);
    this.#push({ type: "erase", items: sel.items });
    this.#changed();
  }

  // ---------- pictures ----------

  // Put pictures ({ src, mime, width, height } in pixels) on a page, upright on screen and at most
  // about two thirds of the page. `at` = { key, x, y } (CSS px inside that page) centres them on a
  // point, otherwise they go in the middle of the visible part of the current page. Returns the
  // new pictures; they become the selection so they can be moved and resized right away.
  addPictures(list, at = null) {
    if (!this.model || !list.length) return [];
    let p = at ? this.#pageOf(at.key) : null;
    let cx, cy;
    if (p) { cx = at.x; cy = at.y; } else {
      p = this.viewer.pages[this.viewer.currentPage()];
      if (!p) return [];
      const r = p.el.getBoundingClientRect();
      const box = this.scroller.getBoundingClientRect();
      const left = Math.max(r.left, box.left), right = Math.min(r.right, box.right);
      const top = Math.max(r.top, box.top), bottom = Math.min(r.bottom, box.bottom);
      cx = (right > left ? (left + right) / 2 : r.left + r.width / 2) - r.left;
      cy = (bottom > top ? (top + bottom) / 2 : r.top + r.height / 2) - r.top;
    }
    const vp = p.viewport;
    const pageW = vp.width, pageH = vp.height; // CSS px, as seen on screen
    const added = [];
    const now = Date.now();
    list.forEach((pic, i) => {
      // 96 pixels to the inch, shrunk to fit.
      let w = pic.width * 0.75 * this.viewer.scale;
      let h = pic.height * 0.75 * this.viewer.scale;
      const f = Math.min(1, (pageW * 0.66) / w, (pageH * 0.6) / h);
      w *= f;
      h *= f;
      const off = i * 24;
      const left = Math.min(Math.max(0, cx - w / 2 + off), Math.max(0, pageW - w));
      const top = Math.min(Math.max(0, cy - h / 2 + off), Math.max(0, pageH - h));
      const [ax, ay] = vp.convertToPdfPoint(left, top);
      const [bx, by] = vp.convertToPdfPoint(left + w, top + h);
      const item = {
        id: newId(), page: p.key, src: pic.src, mime: pic.mime,
        x: round2(Math.min(ax, bx)), y: round2(Math.min(ay, by)),
        w: round2(Math.abs(bx - ax)), h: round2(Math.abs(by - ay)),
        t: now + i * 1e-3,
      };
      this.#add(item, true);
      added.push(item);
    });
    this.#push({ type: "add", items: added });
    this.#changed();
    this.#setSelection(p, added);
    return added;
  }

  #replace(before, after) {
    this.#removeAll(before);
    for (const s of after) this.#add(s, true);
    this.#push({ type: "replace", before, after });
    this.#changed();
  }

  // ---------- blank pages ----------

  // Insert a blank page after the page with this key, sized like it.
  addBlankPage(afterKey, paper = "plain") {
    if (!this.model) return null;
    const ref = this.#pageOf(afterKey);
    const blanks = blankPages(this.model);
    let after;
    let pos;
    if (typeof afterKey === "number") {
      after = afterKey;
      const here = blanks.filter((b) => b.after === after);
      pos = here.length ? Math.min(...here.map((b) => b.pos)) - 1 : 0;
    } else {
      const me = this.model.pages[afterKey.slice(2)];
      if (!me) return null;
      after = me.after;
      const later = blanks.filter((b) => b.after === after && b.pos > me.pos).map((b) => b.pos);
      pos = later.length ? (me.pos + Math.min(...later)) / 2 : me.pos + 1;
    }
    const id = newId();
    this.model.pages[id] = { after, pos, w: round2(ref?.w || 595), h: round2(ref?.h || 842), t: Date.now() };
    if (PAPERS.includes(paper) && paper !== "plain") this.model.pages[id].paper = paper;
    this.clearSelection();
    this.focusKey = blankKey(id); // the new page is shown
    this.#emit("pages");
    this.focusKey = null;
    this.#changed();
    return blankKey(id);
  }

  // Remove a blank page and what was written on it. Not undoable, so the caller confirms.
  removeBlankPage(key) {
    const id = String(key).slice(2);
    if (!this.model?.pages[id]) return;
    for (const s of this.byPage.get(key) || []) {
      delete this.model.strokes[s.id];
      this.model.deleted[s.id] = Date.now();
    }
    for (const im of this.picsByPage.get(key) || []) {
      delete this.model.images[im.id];
      this.model.deleted[im.id] = Date.now();
    }
    this.byPage.delete(key);
    this.picsByPage.delete(key);
    delete this.model.pages[id];
    this.model.deleted[id] = Date.now();
    this.undoStack = [];
    this.redoStack = [];
    this.clearSelection();
    this.#emit("history");
    this.#emit("pages");
    this.#changed();
  }

  // Strokes and pictures on a page.
  itemCount(key) { return (this.byPage.get(key) || []).length + (this.picsByPage.get(key) || []).length; }

  // Change a blank page's paper. The newer change wins when devices merge (see `u`).
  setBlankPaper(key, paper) {
    const id = String(key).slice(2);
    const b = this.model?.pages[id];
    if (!b || !PAPERS.includes(paper) || (b.paper || "plain") === paper) return;
    this.model.pages[id] = { ...b, paper, u: Math.max(Date.now(), (b.u || b.t || 0) + 1) };
    this.focusKey = key;
    this.#emit("pages");
    this.focusKey = null;
    this.#changed();
  }

  // ---------- model changes ----------

  #add(s, redraw = false) {
    if (isPicture(s)) {
      this.model.images[s.id] = s;
      delete this.model.deleted[s.id];
      const list = [...(this.picsByPage.get(s.page) || []), s];
      list.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
      this.picsByPage.set(s.page, list);
      const p = this.#pageOf(s.page);
      if (p && this.viewer.visible.has(p)) this.#drawPictures(p);
      return;
    }
    this.model.strokes[s.id] = s;
    delete this.model.deleted[s.id];
    if (!this.byPage.has(s.page)) this.byPage.set(s.page, []);
    this.byPage.get(s.page).push(s);
    const p = this.#pageOf(s.page);
    if (p && this.viewer.visible.has(p)) {
      if (redraw) this.drawPage(p);
      else if (p.inkScale === this.viewer.scale) {
        const k = this.#inkScale(p);
        const ctx = p.inkCanvas.getContext("2d");
        const T = p.viewport.transform;
        ctx.setTransform(T[0] * k, T[1] * k, T[2] * k, T[3] * k, T[4] * k, T[5] * k);
        drawStroke(ctx, s);
      } else this.drawPage(p);
    }
  }

  #remove(s) {
    const pic = isPicture(s);
    delete (pic ? this.model.images : this.model.strokes)[s.id];
    this.model.deleted[s.id] = Date.now();
    const map = pic ? this.picsByPage : this.byPage;
    const list = map.get(s.page);
    if (list) map.set(s.page, list.filter((q) => q.id !== s.id));
  }

  // Restored strokes get new ids: the old ids are tombstoned and may already be synced. Other
  // undo/redo steps that mention the old strokes are pointed at the copies.
  #restore(strokes) {
    const copies = strokes.map((s) => ({ ...s, id: newId(), t: s.t }));
    for (const c of copies) this.#add(c, true);
    const map = new Map(strokes.map((s, i) => [s.id, copies[i]]));
    const swap = (list) => list?.map((s) => map.get(s.id) || s);
    for (const action of [...this.undoStack, ...this.redoStack]) {
      if (action.items) action.items = swap(action.items);
      if (action.before) action.before = swap(action.before);
      if (action.after) action.after = swap(action.after);
    }
    return copies;
  }

  #removeAll(items) {
    const pages = new Set();
    for (const s of items) {
      if ((isPicture(s) ? this.model.images : this.model.strokes)[s.id]) { this.#remove(s); pages.add(s.page); }
    }
    for (const key of pages) { const p = this.#pageOf(key); if (p && this.viewer.visible.has(p)) this.drawPage(p); }
  }

  #push(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.#emit("history");
  }

  undo() {
    const a = this.undoStack.pop();
    if (!a) return;
    this.clearSelection();
    if (a.type === "add") this.#removeAll(a.items);
    else if (a.type === "erase") a.items = this.#restore(a.items);
    else { this.#removeAll(a.after); a.before = this.#restore(a.before); }
    this.redoStack.push(a);
    this.#emit("history");
    this.#changed();
  }

  redo() {
    const a = this.redoStack.pop();
    if (!a) return;
    this.clearSelection();
    if (a.type === "add") a.items = this.#restore(a.items);
    else if (a.type === "erase") this.#removeAll(a.items);
    else { this.#removeAll(a.before); a.after = this.#restore(a.after); }
    this.undoStack.push(a);
    this.#emit("history");
    this.#changed();
  }

  // Replace the model (after a sync merged in strokes, pictures or pages from another device).
  replaceModel(model) {
    const pagesBefore = pagesSignature(this.model);
    if (!model.pages) model.pages = {};
    if (!model.images) model.images = {};
    this.clearSelection();
    this.model = model;
    this.#index();
    this.undoStack = [];
    this.redoStack = [];
    this.#emit("history");
    if (pagesSignature(model) !== pagesBefore) this.#emit("pages");
    this.redrawAll();
  }

  #changed() { this.#emit("change"); }
  #emit(type) { this.dispatchEvent(new Event(type)); }
}
