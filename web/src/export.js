// Writes the handwriting into a copy of the PDF as standard ink annotations (/Subtype /Ink),
// each with its own appearance stream, so Acrobat, Preview, browsers and other PDF
// readers show it exactly as drawn. Pictures become image stamps (/Subtype /Stamp) under the
// ink, and inserted blank pages get their lines, grid or dots as page content.
import {
  PDFDocument, PDFName, PDFString, PDFHexString,
  pushGraphicsState, popGraphicsState, setLineWidth, setLineCap, setLineJoin,
  LineCapStyle, LineJoinStyle, moveTo, lineTo, stroke, setStrokingRgbColor,
  setGraphicsState, appendQuadraticCurve, concatTransformationMatrix, drawObject,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { pressureFactor, HIGHLIGHT_OPACITY } from "./ink.js";
import { paperLayers, paperOf } from "./paper.js";

export class EncryptedPdfError extends Error {}

function hexToRgb(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

const r3 = (v) => Math.round(v * 1000) / 1000;

function appearanceOps(s, rgb) {
  const p = s.pts;
  const n = p.length / 3;
  const ops = [pushGraphicsState(), setStrokingRgbColor(...rgb), setLineCap(LineCapStyle.Round), setLineJoin(LineJoinStyle.Round)];
  if (s.tool === "highlighter") {
    ops.push(setGraphicsState("GS0"), setLineWidth(s.width), moveTo(p[0], p[1]));
    if (n === 1) ops.push(lineTo(p[0] + 0.01, p[1]));
    for (let i = 1; i < n - 1; i++) {
      ops.push(appendQuadraticCurve(p[i * 3], p[i * 3 + 1], (p[i * 3] + p[i * 3 + 3]) / 2, (p[i * 3 + 1] + p[i * 3 + 4]) / 2));
    }
    if (n > 1) ops.push(lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]));
    ops.push(stroke());
  } else if (n === 1) {
    ops.push(setLineWidth(s.width * pressureFactor(p[2])), moveTo(p[0], p[1]), lineTo(p[0] + 0.01, p[1]), stroke());
  } else {
    // Same geometry as the screen: quadratic pieces through the midpoints, each with its own width.
    let px = p[0];
    let py = p[1];
    for (let i = 1; i < n; i++) {
      const x = p[i * 3];
      const y = p[i * 3 + 1];
      const last = i === n - 1;
      const mx = last ? x : (x + p[i * 3 + 3]) / 2;
      const my = last ? y : (y + p[i * 3 + 4]) / 2;
      ops.push(
        setLineWidth(r3(s.width * pressureFactor((p[i * 3 - 1] + p[i * 3 + 2]) / 2))),
        moveTo(px, py),
        appendQuadraticCurve(x, y, mx, my),
        stroke(),
      );
      px = mx;
      py = my;
    }
  }
  ops.push(popGraphicsState());
  return ops;
}

function inkAnnotation(doc, s) {
  const ctx = doc.context;
  const rgb = hexToRgb(s.color);
  const p = s.pts;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    x0 = Math.min(x0, p[i]); x1 = Math.max(x1, p[i]);
    y0 = Math.min(y0, p[i + 1]); y1 = Math.max(y1, p[i + 1]);
  }
  const pad = s.width * (s.tool === "highlighter" ? 0.6 : 1.2) + 1;
  const rect = [r3(x0 - pad), r3(y0 - pad), r3(x1 + pad), r3(y1 + pad)];
  const opacity = s.tool === "highlighter" ? (s.opacity ?? HIGHLIGHT_OPACITY) : 1;

  const resources = s.tool === "highlighter"
    ? ctx.obj({ ExtGState: { GS0: { Type: "ExtGState", CA: opacity, ca: opacity, BM: "Multiply" } } })
    : undefined;
  const ap = ctx.formXObject(appearanceOps(s, rgb), { BBox: rect, ...(resources ? { Resources: resources } : {}) });
  const apRef = ctx.register(ap);

  const inkList = [];
  for (let i = 0; i < p.length; i += 3) inkList.push(p[i], p[i + 1]);
  if (inkList.length === 2) inkList.push(p[0] + 0.01, p[1]);

  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Ink",
    Rect: rect,
    InkList: [inkList],
    C: rgb.map(r3),
    CA: opacity,
    BS: { Type: "Border", S: "S", W: r3(s.width) },
    F: 4, // print
    NM: PDFString.of(`penmit:${s.id}`),
    T: PDFHexString.fromText("Penmit PDF"),
    M: PDFString.fromDate(new Date(s.t || Date.now())),
    AP: { N: apRef },
  });
  if (s.tool === "highlighter") annot.set(PDFName.of("IT"), PDFName.of("InkHighlight"));
  return ctx.register(annot);
}

// A blank page's lines, grid or dots as page content (dots are round-capped dashes).
function paperOps(paper, w, h) {
  const ops = [];
  for (const layer of paperLayers(paper, w, h)) {
    ops.push(pushGraphicsState(), setStrokingRgbColor(...hexToRgb(layer.color)));
    if (layer.lines) {
      const L = layer.lines;
      ops.push(setLineWidth(layer.width), setLineCap(LineCapStyle.Butt));
      for (let i = 0; i < L.length; i += 4) ops.push(moveTo(L[i], L[i + 1]), lineTo(L[i + 2], L[i + 3]));
    } else {
      const D = layer.dots;
      ops.push(setLineWidth(layer.r * 2), setLineCap(LineCapStyle.Round));
      for (let i = 0; i < D.length; i += 2) ops.push(moveTo(D[i], D[i + 1]), lineTo(r3(D[i] + 0.01), D[i + 1]));
    }
    ops.push(stroke(), popGraphicsState());
  }
  return ops;
}

// Which way is right and which is up on screen, in PDF space, for a page turned by /Rotate.
const SCREEN_AXES = { 0: [[1, 0], [0, 1]], 90: [[0, 1], [-1, 0]], 180: [[-1, 0], [0, -1]], 270: [[0, -1], [1, 0]] };

// A picture as an image stamp whose appearance draws it upright as seen on screen.
function pictureAnnotation(doc, im, rotation, imageRef) {
  const ctx = doc.context;
  const [right, up] = SCREEN_AXES[rotation] || SCREEN_AXES[0];
  const across = Math.abs(right[0]) * im.w + Math.abs(right[1]) * im.h;
  const tall = Math.abs(up[0]) * im.w + Math.abs(up[1]) * im.h;
  const corners = [[im.x, im.y], [im.x + im.w, im.y], [im.x, im.y + im.h], [im.x + im.w, im.y + im.h]];
  const score = ([x, y]) => x * (right[0] + up[0]) + y * (right[1] + up[1]);
  const origin = corners.reduce((a, c) => (score(c) < score(a) ? c : a)); // the picture's bottom-left on screen
  const rect = [r3(im.x), r3(im.y), r3(im.x + im.w), r3(im.y + im.h)];
  const ops = [
    pushGraphicsState(),
    concatTransformationMatrix(r3(right[0] * across), r3(right[1] * across), r3(up[0] * tall), r3(up[1] * tall), r3(origin[0]), r3(origin[1])),
    drawObject("Im0"),
    popGraphicsState(),
  ];
  const ap = ctx.formXObject(ops, { BBox: rect, Resources: ctx.obj({ XObject: { Im0: imageRef } }) });
  const annot = ctx.obj({
    Type: "Annot",
    Subtype: "Stamp",
    Rect: rect,
    F: 4, // print
    IT: "StampImage",
    NM: PDFString.of(`penmit:${im.id}`),
    T: PDFHexString.fromText("Penmit PDF"),
    M: PDFString.fromDate(new Date(im.t || Date.now())),
    AP: { N: ctx.register(ap) },
  });
  return ctx.register(annot);
}

// byPage: Map(page key -> strokes), keys being PDF page indexes or "b:<id>" for blank pages.
// blanks: the inserted blank pages ({ id, after, pos, w, h, paper }), added to the copy in place.
// pictures: Map(page key -> pictures); getPicture(src) -> { bytes, mime } or null.
export async function exportAnnotated(pdfBytes, byPage, blanks = [], pictures = new Map(), getPicture = async () => null) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(e?.message || "")) throw new EncryptedPdfError(e.message);
    throw e;
  }
  const original = doc.getPages();
  const n = original.length;
  const pageFor = new Map(original.map((page, i) => [i, page]));
  // Same order as on screen: blanks before the first page, then after each page by position.
  // Inserting in that order, each blank's place is the PDF pages before it plus the blanks before it.
  const place = (b) => Math.min(Math.max(b.after, -1), n - 1);
  const sorted = [...blanks].sort((a, b) => place(a) - place(b) || a.pos - b.pos || (a.id < b.id ? -1 : 1));
  sorted.forEach((b, i) => {
    const page = doc.insertPage(place(b) + 1 + i, [b.w, b.h]);
    const paper = paperOf(b);
    if (paper !== "plain") page.pushOperators(...paperOps(paper, b.w, b.h));
    pageFor.set(`b:${b.id}`, page);
  });

  const images = new Map(); // src -> embedded image (each file once, however often it is used)
  const embed = async (src) => {
    if (!images.has(src)) {
      let ref = null;
      try {
        const file = await getPicture(src);
        if (file) ref = (file.mime === "image/jpeg" ? await doc.embedJpg(file.bytes) : await doc.embedPng(file.bytes)).ref;
      } catch (e) {
        console.warn("picture", src, e);
      }
      images.set(src, ref);
    }
    return images.get(src);
  };

  for (const key of new Set([...pictures.keys(), ...byPage.keys()])) {
    const page = pageFor.get(key);
    const pics = pictures.get(key) || [];
    const strokes = byPage.get(key) || [];
    if (!page || (!strokes.length && !pics.length)) continue;
    let annots = page.node.Annots();
    if (!annots) {
      annots = doc.context.obj([]);
      page.node.set(PDFName.of("Annots"), annots);
    }
    const rotation = ((page.getRotation().angle % 360) + 360) % 360;
    for (const im of pics) {
      const ref = await embed(im.src);
      if (ref) annots.push(pictureAnnotation(doc, im, rotation, ref));
    }
    for (const s of strokes) annots.push(inkAnnotation(doc, s));
  }
  return doc.save({ useObjectStreams: false });
}
