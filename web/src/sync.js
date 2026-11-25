// Sync between this device and a storage backend (GitHub or Google Drive).
//
// Every PDF is a folder in the backend, named by the PDF's SHA-256:
//   document.pdf   the original PDF (uploaded once)
//   meta.json      name, page count, dates
//   ink.json       the handwriting, pictures' places and inserted blank pages (small text that merges cleanly)
//   img-<sha256>.png / .jpg   each picture placed on the pages, named by its contents (uploaded once)
//
// A backend implements:
//   key                       stable id of the storage location (e.g. "owner/repo", "gdrive:me@x")
//   begin()                   -> { docs: Map(docId -> { document?, meta?, ink?, pictures: Map(src -> file name) }) }
//                                with version tokens
//   read(docId, name)         -> Uint8Array
//   write(docId, name, bytes) -> version token (GitHub stages it; Drive uploads it)
//   remove(docId)             delete the document's folder
//   removeFile(docId, name)   delete one file (a picture no longer used)
//   finish(message)           GitHub commits; throws { retry: true } if someone pushed first
//   version(bytes)            the token the backend would report for these bytes

const enc = new TextEncoder();
const dec = new TextDecoder();
export const FILES = ["document.pdf", "meta.json", "ink.json"];
export const MAX_FILE = 100 * 1024 * 1024;

// Pictures' files: img-<SHA-256 of the bytes>.png or .jpg.
export const PICTURE_RE = /^img-([0-9a-f]{64})\.(png|jpg)$/;
export const pictureName = (src, mime) => `img-${src}.${mime === "image/jpeg" ? "jpg" : "png"}`;
export const pictureMime = (name) => (name.endsWith(".jpg") ? "image/jpeg" : "image/png");

// The picture files a document's ink uses: Map(src -> mime).
export function pictureFiles(model) {
  const out = new Map();
  for (const im of Object.values(model.images || {})) out.set(im.src, im.mime);
  return out;
}

export class StorageError extends Error {
  constructor(status, message, extra = {}) {
    super(message || `HTTP ${status}`);
    this.status = status;
    Object.assign(this, extra);
  }
}

export function bytesToBase64(bytes) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes]));
  });
}

export function base64ToBytes(b64) {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Git's id for a file's contents; used as the version token by both backends.
export async function gitBlobSha(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = enc.encode(`blob ${view.byteLength}\0`);
  const buf = new Uint8Array(header.length + view.byteLength);
  buf.set(header, 0);
  buf.set(view, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sortedObject(obj) {
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

// Stable JSON, so the same ink always produces the same bytes (and the same version token).
// Ink without blank pages or pictures keeps its old layout, so files written before those
// existed keep the same bytes (and version token).
export function inkToBytes(model) {
  const data = { v: 1, strokes: sortedObject(model.strokes), deleted: sortedObject(model.deleted) };
  if (model.pages && Object.keys(model.pages).length) data.pages = sortedObject(model.pages);
  if (model.images && Object.keys(model.images).length) data.images = sortedObject(model.images);
  return enc.encode(JSON.stringify(data));
}

export function inkFromBytes(id, bytes) {
  const data = JSON.parse(dec.decode(bytes));
  return { id, strokes: data.strokes || {}, images: data.images || {}, deleted: data.deleted || {}, pages: data.pages || {} };
}

// A blank page's paper can change; the later change wins (`u`, or when the page was made).
const pageTime = (b) => b?.u ?? b?.t ?? 0;

// Union of strokes, pictures and blank pages from both sides, minus anything either side deleted.
export function mergeInk(a, b) {
  const strokes = { ...a.strokes, ...b.strokes };
  const images = { ...(a.images || {}), ...(b.images || {}) };
  const pages = { ...(a.pages || {}) };
  for (const [k, v] of Object.entries(b.pages || {})) if (!pages[k] || pageTime(v) >= pageTime(pages[k])) pages[k] = v;
  const deleted = { ...a.deleted };
  for (const [k, v] of Object.entries(b.deleted)) deleted[k] = Math.max(deleted[k] || 0, v);
  for (const k of Object.keys(deleted)) { delete strokes[k]; delete images[k]; delete pages[k]; }
  return { id: a.id, strokes, images, deleted, pages };
}

const sameKeys = (a = {}, b = {}) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => k in b);
};
const samePages = (a = {}, b = {}) =>
  sameKeys(a, b) && Object.keys(a).every((k) => pageTime(a[k]) === pageTime(b[k]) && (a[k].paper || "plain") === (b[k].paper || "plain"));
export function sameInk(a, b) {
  return sameKeys(a.strokes, b.strokes) && sameKeys(a.images, b.images) && sameKeys(a.deleted, b.deleted) && samePages(a.pages, b.pages);
}

// Upload the pictures the ink uses that the backend lacks, fetch the ones this device lacks, and
// delete files no picture uses any more. Runs before ink.json is written, so the ink never
// points at a picture that isn't there.
async function syncPictures(backend, store, id, model, remote) {
  const want = pictureFiles(model);
  const have = remote?.pictures || new Map();
  for (const [src, mime] of want) {
    if (have.has(src)) {
      if (!(await store.hasPicture(id, src))) await store.putPicture(id, src, mime, await backend.read(id, have.get(src)));
      continue;
    }
    const bytes = await store.getPicture(id, src);
    if (!bytes) continue; // another device has it and will upload it
    await backend.write(id, pictureName(src, mime), bytes);
  }
  for (const [src, name] of have) if (!want.has(src)) await backend.removeFile(id, name);
}

// store: { listDocs, getDoc, getFile, getInk, putDoc, putFile, putInk, removeDoc, onDocDownloaded,
//          hasPicture, getPicture, putPicture }
export async function sync(backend, store, { onProgress = () => {} } = {}) {
  for (let attempt = 0; ; attempt++) {
    onProgress("scan");
    const { docs: remote } = await backend.begin();
    const key = backend.key;
    const local = await store.listDocs();
    const localIds = new Set(local.map((d) => d.id));
    const after = [];
    const stats = { up: 0, down: 0, merged: 0, removed: 0 };

    for (const d0 of local) {
      // Sync records only count for the place they were made with; after switching storage
      // everything is treated as new rather than as deleted.
      const d = d0.synced?.repo === key ? d0 : { ...d0, synced: null };
      const r = remote.get(d.id);
      if (d.deleted) {
        if (r) await backend.remove(d.id);
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }
      if (!r?.document && d.synced) {
        // Synced here before and gone now: another device deleted it.
        after.push(() => store.removeDoc(d.id));
        stats.removed++;
        continue;
      }

      onProgress("doc", d.name);
      const synced = { ...(d.synced || {}), repo: key };
      if (!r?.document) {
        const file = await store.getFile(d.id);
        if (file.byteLength > MAX_FILE) throw new StorageError(413, d.name, { tooLarge: d.name });
        synced.document = await backend.write(d.id, "document.pdf", new Uint8Array(file));
        stats.up++;
      } else {
        synced.document = r.document;
      }

      // Handwriting: merge when the backend has changes this device hasn't seen.
      const localInk = await store.getInk(d.id);
      let merged = localInk;
      if (r?.ink && r.ink !== d.synced?.ink) {
        const remoteInk = inkFromBytes(d.id, await backend.read(d.id, "ink.json"));
        merged = mergeInk(localInk, remoteInk);
        if (!sameInk(merged, localInk)) stats.merged++;
      }
      await syncPictures(backend, store, d.id, merged, r);
      const inkBytes = inkToBytes(merged);
      let inkVersion = await backend.version(inkBytes);
      if (inkVersion !== r?.ink) {
        inkVersion = await backend.write(d.id, "ink.json", inkBytes);
        if (r?.ink) stats.up++;
      }
      synced.ink = inkVersion;

      // Metadata: the newer rename wins.
      let meta = { id: d.id, name: d.name, pageCount: d.pageCount, size: d.size, addedAt: d.addedAt, updatedAt: d.updatedAt };
      if (r?.meta && r.meta !== d.synced?.meta) {
        const remoteMeta = JSON.parse(dec.decode(await backend.read(d.id, "meta.json")));
        if ((remoteMeta.updatedAt || 0) > (d.updatedAt || 0)) meta = { ...meta, name: remoteMeta.name, updatedAt: remoteMeta.updatedAt };
      }
      const metaBytes = enc.encode(JSON.stringify(meta, null, 2));
      let metaVersion = await backend.version(metaBytes);
      if (metaVersion !== r?.meta) metaVersion = await backend.write(d.id, "meta.json", metaBytes);
      synced.meta = metaVersion;

      after.push(async () => {
        // Strokes drawn while syncing are kept: merge once more with what is stored now.
        const now = await store.getInk(d.id);
        await store.putInk(mergeInk(now, merged));
        const current = (await store.getDoc(d.id)) || d;
        await store.putDoc({ ...current, name: meta.name, updatedAt: meta.updatedAt, synced });
      });
    }

    // In the backend but not on this device: download.
    for (const [id, r] of remote) {
      if (localIds.has(id) || !r.document) continue;
      onProgress("download", id);
      const meta = r.meta ? JSON.parse(dec.decode(await backend.read(id, "meta.json"))) : { id, name: `${id.slice(0, 8)}.pdf` };
      const pdf = await backend.read(id, "document.pdf");
      const ink = r.ink ? inkFromBytes(id, await backend.read(id, "ink.json")) : { id, strokes: {}, images: {}, deleted: {}, pages: {} };
      for (const [src, mime] of pictureFiles(ink)) {
        if (r.pictures?.has(src) && !(await store.hasPicture(id, src))) await store.putPicture(id, src, mime, await backend.read(id, r.pictures.get(src)));
      }
      after.push(async () => {
        await store.putFile(id, pdf);
        await store.putInk(ink);
        await store.putDoc({
          id, name: meta.name, size: pdf.byteLength, pageCount: meta.pageCount || 0,
          addedAt: meta.addedAt || Date.now(), updatedAt: meta.updatedAt || Date.now(),
          synced: { repo: key, document: r.document, ink: r.ink || null, meta: r.meta || null },
        });
        await store.onDocDownloaded?.(id);
      });
      stats.down++;
    }

    onProgress("commit");
    const device = navigator.userAgentData?.platform || navigator.platform || "device";
    try {
      await backend.finish(`Sync from Penmit PDF (${device})`);
    } catch (e) {
      if (e.retry && attempt < 2) continue; // someone else saved first: start over from theirs
      throw e;
    }
    for (const fn of after) await fn();
    return stats;
  }
}
