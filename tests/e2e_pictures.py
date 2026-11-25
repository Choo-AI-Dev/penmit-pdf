"""Paper for blank pages (plain, lined, grid, dots) and pictures on pages: paste, choose a file,
drop, move, resize, select, erase around, delete, undo, keep after reopening, and save them in
the PDF upright (on a rotated page too). Run `node tests/make_test_pdf.mjs` first."""
import http.server, socketserver, threading, json, subprocess, sys, struct, zlib, base64
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
WEB = str(ROOT / "web")
S = str(ROOT / "tests" / "out") + "/"
PORT = 8797


class H(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".mjs": "text/javascript", ".js": "text/javascript", ".wasm": "application/wasm"}
    def __init__(self, *a, **k): super().__init__(*a, directory=WEB, **k)
    def log_message(self, *a): pass


socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), H)
threading.Thread(target=srv.serve_forever, daemon=True).start()


def png_file(path, w, h, rgb):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xffffffff)
    raw = b"".join(b"\x00" + bytes(rgb) * w for _ in range(h))
    Path(path).write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


INK = """async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });
  const get = (s) => new Promise((res) => { const q = db.transaction(s).objectStore(s).getAll(); q.onsuccess = () => res(q.result); });
  const ink = await get('ink'), images = await get('images');
  db.close();
  const m = ink[0] || { strokes: {}, images: {}, pages: {}, deleted: {} };
  return { strokes: Object.values(m.strokes).map(s => ({ id: s.id, page: s.page })), pictures: Object.values(m.images || {}),
           pages: m.pages || {}, files: images.map(f => ({ id: f.id, src: f.src, mime: f.mime, size: f.bytes.byteLength })) };
}"""

# A test picture: red top half, blue bottom half, so it shows which way up it is.
PICTURE = """async ([w, h, type]) => {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#e02020'; x.fillRect(0, 0, w, h / 2);
  x.fillStyle = '#2040e0'; x.fillRect(0, h / 2, w, h - h / 2);
  const blob = await new Promise(r => c.toBlob(r, type || 'image/png', 0.92));
  return new File([blob], type === 'image/jpeg' ? 'pic.jpg' : 'pic.png', { type: blob.type });
}"""
PASTE = "async (args) => { const file = await (" + PICTURE + ")(args); const dt = new DataTransfer(); dt.items.add(file);" \
        " document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }"
DROP = "async ([args, x, y]) => { const file = await (" + PICTURE + ")(args); const dt = new DataTransfer(); dt.items.add(file);" \
       " document.elementFromPoint(x, y).dispatchEvent(new DragEvent('drop', { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true })); }"
NOISE_PASTE = """async () => {
  const c = document.createElement('canvas'); c.width = 3000; c.height = 2000;
  const x = c.getContext('2d'); const img = x.createImageData(3000, 2000);
  for (let i = 0; i < img.data.length; i += 4) { img.data[i] = Math.random() * 255; img.data[i + 1] = Math.random() * 255; img.data[i + 2] = 128; img.data[i + 3] = 255; }
  x.putImageData(img, 0, 0);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'noise.png', { type: 'image/png' }));
  document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}"""
# Colour of a canvas layer of a page at a point on screen.
PIXEL = """([layer, x, y]) => {
  const el = document.elementFromPoint(x, y)?.closest('.page');
  const c = el?.querySelector('canvas.' + layer);
  if (!c || !c.width) return null;
  const r = c.getBoundingClientRect();
  const d = c.getContext('2d').getImageData(Math.floor((x - r.left) * c.width / r.width), Math.floor((y - r.top) * c.height / r.height), 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}"""
# Share of non-white pixels in a canvas.
INKED = """(canvas) => {
  if (!canvas.width) return 0;
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0 && (d[i] < 235 || d[i + 1] < 235 || d[i + 2] < 235)) n++;
  return n / (canvas.width * canvas.height);
}"""
# Render a saved PDF with the app's pdf.js and sample colours inside boxes (PDF space).
RENDER = """async ([b64, probes]) => {
  const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const pdf = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
  const out = [];
  for (const pr of probes) {
    const page = await pdf.getPage(pr.page + 1);
    const vp = page.getViewport({ scale: 1 });
    const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    if (!pr.box) { out.push((""" + INKED + """)(c)); continue; }
    const [x0, y0] = vp.convertToViewportPoint(pr.box[0], pr.box[1]);
    const [x1, y1] = vp.convertToViewportPoint(pr.box[2], pr.box[3]);
    const L = Math.min(x0, x1), R = Math.max(x0, x1), T = Math.min(y0, y1), B = Math.max(y0, y1);
    const at = (fx, fy) => [...ctx.getImageData(Math.floor(L + (R - L) * fx), Math.floor(T + (B - T) * fy), 1, 1).data].slice(0, 3);
    out.push({ top: at(0.5, 0.2), bottom: at(0.5, 0.8) });
  }
  return out;
}"""

red = lambda c: c is not None and c[0] > 180 and c[1] < 90 and c[2] < 90
blue = lambda c: c is not None and c[2] > 180 and c[0] < 90

fails = []
def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)


png_file(S + "green.png", 200, 100, (30, 170, 60))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1180, "height": 860}, locale="ko-KR", accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("dialog", lambda d: d.accept())
    page.goto(f"http://localhost:{PORT}/")
    page.wait_for_selector("#library:not([hidden])")
    cdp = ctx.new_cdp_session(page)

    def settle(ms=700):
        page.wait_for_timeout(ms)

    def ink():
        settle(600)
        return page.evaluate(INK)

    def drag(points, ptype="mouse"):
        x0, y0 = points[0]
        cdp.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x0, "y": y0, "button": "left", "buttons": 1, "clickCount": 1, "pointerType": ptype, "force": 0.5})
        for x, y in points[1:]:
            cdp.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "left", "buttons": 1, "pointerType": ptype, "force": 0.5})
        cdp.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": points[-1][0], "y": points[-1][1], "button": "left", "buttons": 0, "clickCount": 1, "pointerType": ptype})
        page.wait_for_timeout(150)

    def line(x0, y0, x1, y1, n=24):
        return [(x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n) for i in range(n + 1)]

    def tool(name):
        page.locator(f".tool[data-tool={name}]").click()

    def sel_box():
        loc = page.locator(".selection")
        return loc.bounding_box() if loc.count() else None

    def pixel(layer, x, y):
        return page.evaluate(PIXEL, [layer, x, y])

    page.set_input_files("#file-input", S + "test.pdf")
    page.wait_for_selector("#reader:not([hidden])")
    settle(1200)

    # ---------- pasting a picture ----------
    page.evaluate(PASTE, [400, 300])
    data = ink()
    check(len(data["pictures"]) == 1 and len(data["files"]) == 1, f"a pasted picture is placed and its file stored ({len(data['pictures'])}, {len(data['files'])})")
    pic = data["pictures"][0]
    check(pic["page"] == 0 and pic["mime"] == "image/png" and abs(pic["w"] / pic["h"] - 4 / 3) < 0.02, f"on the current page, with its shape ({pic['page']}, {pic['w']}x{pic['h']})")
    check(data["files"][0]["src"] == pic["src"] and data["files"][0]["id"].endswith("/" + pic["src"]), "the file is named by its contents")
    check(page.locator(".tool[data-tool=lasso]").get_attribute("aria-checked") == "true" and sel_box() is not None, "the lasso is picked and the picture is selected")
    check(page.locator(".sel-bar .sel-color").count() == 0 and page.locator(".sel-bar .sel-delete").count() == 1, "a picture alone has no colour buttons")
    check(page.locator("#toast").is_visible() and "옮기고" in page.locator("#toast").inner_text(), "the first picture shows how to move it")
    box = sel_box()
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    check(red(pixel("img", cx, box["y"] + box["height"] * 0.25)) and blue(pixel("img", cx, box["y"] + box["height"] * 0.75)), "it is drawn upright (red on top)")
    p0 = page.locator(".page").first.bounding_box()
    check(abs(cx - (p0["x"] + p0["width"] / 2)) < 30, "in the middle of the page across")

    # Moving and resizing.
    drag(line(cx, cy, cx + 80, cy + 40))
    data = ink()
    moved = data["pictures"][0]
    scale = p0["width"] / 612
    check(moved["id"] != pic["id"] and abs((moved["x"] - pic["x"]) * scale - 80) < 3 and abs((pic["y"] - moved["y"]) * scale - 40) < 3,
          f"dragging moves it ({moved['x'] - pic['x']:.1f}, {moved['y'] - pic['y']:.1f})")
    box = sel_box()
    drag(line(box["x"] + box["width"] - 6, box["y"] + box["height"] - 6, box["x"] + box["width"] + 54, box["y"] + box["height"] + 39))
    data = ink()
    big = data["pictures"][0]
    check(big["w"] > moved["w"] * 1.05 and abs(big["w"] / big["h"] - 4 / 3) < 0.02, f"a corner resizes it and keeps its shape ({moved['w']} -> {big['w']})")
    page.keyboard.press("Control+z")
    data = ink()
    check(len(data["pictures"]) == 1 and abs(data["pictures"][0]["w"] - moved["w"]) < 0.01, "undo puts the size back")
    page.keyboard.press("Control+Shift+z")
    data = ink()
    check(abs(data["pictures"][0]["w"] - big["w"]) < 0.01, "redo makes it big again")
    pic = data["pictures"][0]

    # Writing over it with the pen, then selecting both with the lasso.
    page.keyboard.press("Escape")
    box = None
    T = page.evaluate("() => { const p = document.querySelectorAll('.page')[0]; const r = p.getBoundingClientRect(); return [r.left, r.top]; }")
    to_screen = lambda x, y: (T[0] + x * scale, T[1] + (792 - y) * scale)
    sx0, sy0 = to_screen(pic["x"], pic["y"] + pic["h"])
    sx1, sy1 = to_screen(pic["x"] + pic["w"], pic["y"])
    tool("pen")
    drag(line(sx0 + 20, (sy0 + sy1) / 2, sx1 - 20, (sy0 + sy1) / 2 + 10), "pen")
    data = ink()
    check(len(data["strokes"]) == 1 and len(data["pictures"]) == 1, "the pen writes on top of the picture")
    ink_px = pixel("ink", (sx0 + sx1) / 2, (sy0 + sy1) / 2 + 5)
    check(ink_px is not None and ink_px[3] > 0, "and the writing shows over it")
    tool("lasso")
    loop = [(sx0 - 20, sy0 - 20), (sx1 + 20, sy0 - 20), (sx1 + 20, sy1 + 20), (sx0 - 20, sy1 + 20), (sx0 - 20, sy0 - 15)]
    pts = []
    for (ax, ay), (bx, by) in zip(loop, loop[1:]): pts += line(ax, ay, bx, by, 12)
    drag(pts, "pen")
    check(page.locator(".sel-bar .sel-color").count() == 4, "the lasso picks the picture and the writing (colour buttons for the writing)")
    page.keyboard.press("Delete")
    data = ink()
    check(not data["strokes"] and not data["pictures"], "Delete removes both")
    page.keyboard.press("Control+z")
    data = ink()
    check(len(data["strokes"]) == 1 and len(data["pictures"]) == 1, "undo brings both back")
    pic = data["pictures"][0]

    # A tap with the lasso picks the picture; the eraser leaves pictures alone.
    page.keyboard.press("Escape")
    drag([(sx0 + 30, sy0 + 30)], "pen")
    check(sel_box() is not None, "tapping a picture with the lasso selects it")
    page.keyboard.press("Escape")
    tool("eraser")
    drag(line(sx0 + 10, (sy0 + sy1) / 2 + 5, sx1 - 10, (sy0 + sy1) / 2 + 5), "pen")
    data = ink()
    check(not data["strokes"] and len(data["pictures"]) == 1, "the eraser removes the writing, not the picture")

    # ---------- choosing a picture file, dropping one ----------
    page.set_input_files("#picture-input", S + "green.png")
    data = ink()
    check(len(data["pictures"]) == 2 and len({f["src"] for f in data["files"]}) == 2, "a chosen picture file is added")
    page.keyboard.press("Escape")
    p0 = page.locator(".page").first.bounding_box()
    dx, dy = p0["x"] + p0["width"] * 0.3, min(p0["y"] + p0["height"] * 0.8, 700)
    page.evaluate(DROP, [[160, 120, "image/jpeg"], dx, dy])
    data = ink()
    dropped = [q for q in data["pictures"] if q["mime"] == "image/jpeg"]
    box = sel_box()
    check(len(dropped) == 1 and box and abs(box["x"] + box["width"] / 2 - dx) < 3 and abs(box["y"] + box["height"] / 2 - dy) < 3,
          "a dropped picture lands where it was dropped (as JPEG)")
    page.keyboard.press("Escape")

    # A big photo is scaled down and stored as JPEG when it has no transparency.
    page.evaluate(NOISE_PASTE)
    page.wait_for_timeout(1500)
    data = ink()
    noise = max(data["pictures"], key=lambda q: q["t"])
    size = page.evaluate("async (key) => { const db = await new Promise((res) => { const r = indexedDB.open('penmit'); r.onsuccess = () => res(r.result); });"
                         " const f = await new Promise((res) => { const q = db.transaction('images').objectStore('images').get(key); q.onsuccess = () => res(q.result); }); db.close();"
                         " const bm = await createImageBitmap(new Blob([f.bytes], { type: f.mime })); return [bm.width, bm.height, f.mime]; }",
                         next(f["id"] for f in data["files"] if f["src"] == noise["src"]))
    check(size == [2400, 1600, "image/jpeg"], f"a 3000 px photo is stored at 2400 px as JPEG ({size})")
    page.keyboard.press("Delete")
    settle()

    # ---------- a picture on a rotated page ----------
    page.evaluate("document.querySelectorAll('.page')[4].scrollIntoView({ block: 'center' })")
    settle(900)
    page.evaluate(PASTE, [400, 300])
    data = ink()
    rot = [q for q in data["pictures"] if q["page"] == 4]
    check(len(rot) == 1 and abs(rot[0]["h"] / rot[0]["w"] - 4 / 3) < 0.02, f"on the rotated page it is turned in PDF space ({rot and (rot[0]['w'], rot[0]['h'])})")
    box = sel_box()
    cx = box["x"] + box["width"] / 2
    check(abs(box["width"] / box["height"] - 4 / 3) < 0.05 and red(pixel("img", cx, box["y"] + box["height"] * 0.25)) and blue(pixel("img", cx, box["y"] + box["height"] * 0.75)),
          "but upright on screen")
    page.keyboard.press("Escape")

    # ---------- paper ----------
    page.locator("#pages-btn").click()
    settle()
    page.locator("#thumbs .thumb").nth(0).locator(".thumb-more").click()
    page.locator(".menu [data-action=add-blank]").click()
    check(page.locator("#paper").is_visible() and page.locator("#paper .paper-opt").count() == 4, "adding a blank page asks which paper")
    check(page.locator("#paper-sub").inner_text() == "1쪽 뒤에 넣어요", f"and says where it goes ({page.locator('#paper-sub').inner_text()})")
    page.locator("#paper .paper-opt[value=lined]").click()
    settle(900)
    blank = page.locator(".page").nth(1)
    check("blank-page" in blank.get_attribute("class") and blank.get_attribute("data-paper") == "lined", "a lined page was added after page 1")
    lined_share = blank.locator("canvas.pdf").evaluate(INKED)
    check(0.003 < lined_share < 0.2, f"its lines are drawn ({lined_share:.4f})")
    thumb_share = page.locator("#thumbs .thumb").nth(1).locator("canvas").evaluate(INKED)
    check(thumb_share > 0.003, f"and in its thumbnail ({thumb_share:.4f})")
    check("줄 노트" in page.locator("#thumbs .thumb").nth(1).inner_text(), "the thumbnail says lined")
    data = ink()
    check([v.get("paper") for v in data["pages"].values()] == ["lined"], "the paper is kept with the page")

    page.locator("#add-blank").click()
    check(page.locator("#paper .paper-opt[value=lined]").get_attribute("aria-checked") == "true", "the last paper is offered first")
    page.locator("#paper button[value=cancel]").click()
    settle()
    check(page.locator(".page").count() == 7, "cancel adds nothing")
    page.locator("#add-blank").click()
    page.locator("#paper .paper-opt[value=dots]").click()
    settle(900)
    dots = page.locator(".page[data-paper=dots]")
    check(dots.count() == 1 and 0.0005 < dots.locator("canvas.pdf").evaluate(INKED) < 0.1, "a dot page")
    idx = int(dots.get_attribute("data-index"))
    page.locator("#thumbs .thumb").nth(idx).locator(".thumb-more").click()
    page.locator(".menu [data-action=change-paper]").click()
    check(page.locator("#paper-title").inner_text() == "종이 바꾸기" and page.locator("#paper .paper-opt[value=dots]").get_attribute("aria-checked") == "true", "changing the paper shows the current one")
    page.locator("#paper .paper-opt[value=grid]").click()
    settle(900)
    data = ink()
    grid = [v for v in data["pages"].values() if v.get("paper") == "grid"]
    check(page.locator(".page[data-paper=grid]").count() == 1 and len(grid) == 1 and grid[0].get("u", 0) >= grid[0]["t"], "the dot page became grid paper")
    check(page.locator(".page[data-paper=grid] canvas.pdf").evaluate(INKED) > 0.01, "and shows the grid")
    page.locator("#add-blank").click()
    page.locator("#paper .paper-opt[value=plain]").click()
    settle(900)
    check(page.locator(".page[data-paper=plain]").count() == 1 and page.locator(".page[data-paper=plain] canvas.pdf").evaluate("c => c.width") == 0, "plain paper is just white")

    # A picture on the lined page, then removing that page takes the picture with it.
    page.evaluate("document.querySelector('.page[data-paper=lined]').scrollIntoView({ block: 'center' })")
    settle(900)
    page.set_input_files("#picture-input", S + "green.png")
    data = ink()
    lined_id = next(k for k, v in data["pages"].items() if v.get("paper") == "lined")
    check(any(q["page"] == f"b:{lined_id}" for q in data["pictures"]), "a picture goes on a blank page too")
    page.keyboard.press("Escape")

    # ---------- saving the PDF ----------
    data = ink()
    with page.expect_download() as dl:
        page.locator("#export").click()
    out = S + "pictures_export.pdf"
    dl.value.save_as(out)
    annots = json.loads(subprocess.run(["node", str(ROOT / "tests/count_annotations.mjs"), out], capture_output=True, text=True, check=True).stdout)
    stamps = [a for a in annots if a["sub"] == "/Stamp"]
    check(len(stamps) == len(data["pictures"]) and all(a["ap"] for a in stamps), f"each picture is an image stamp with an appearance ({len(stamps)} of {len(data['pictures'])})")
    blanks = len(data["pages"])
    order = {k: i for i, k in enumerate(["0"] + [k for k, v in sorted(data["pages"].items(), key=lambda kv: kv[1]["pos"])])}
    first = next(q for q in data["pictures"] if q["page"] == 0 and q["mime"] == "image/png" and abs(q["w"] / q["h"] - 4 / 3) < 0.02)
    rotq = next(q for q in data["pictures"] if q["page"] == 4)
    probes = [
        {"page": 0, "box": [first["x"], first["y"], first["x"] + first["w"], first["y"] + first["h"]]},
        {"page": 4 + blanks, "box": [rotq["x"], rotq["y"], rotq["x"] + rotq["w"], rotq["y"] + rotq["h"]]},
    ]
    for k, v in data["pages"].items():
        probes.append({"page": order[k], "paper": v.get("paper", "plain")})
    res = page.evaluate(RENDER, [base64.b64encode(Path(out).read_bytes()).decode(), probes])
    check(red(res[0]["top"]) and blue(res[0]["bottom"]), f"the picture is upright in the saved PDF {res[0]}")
    check(red(res[1]["top"]) and blue(res[1]["bottom"]), f"also on the rotated page {res[1]}")
    paper_ok = {pr["paper"]: share for pr, share in zip(probes[2:], res[2:])}
    check(paper_ok.get("lined", 0) > 0.003 and paper_ok.get("grid", 0) > 0.01 and paper_ok.get("plain", 1) < 0.0005, f"the blank pages keep their paper in the saved PDF {paper_ok}")

    # ---------- reopening ----------
    page.locator("#back").click()
    page.wait_for_selector("#library:not([hidden])")
    page.locator(".doc-open").first.click()
    page.wait_for_selector("#reader:not([hidden])")
    settle(1500)
    page.evaluate("document.querySelectorAll('.page')[0].scrollIntoView({ block: 'start' })")
    settle(900)
    # Colour of page 1's picture layer at a point in PDF space (the page is 612 x 792, unrotated).
    at_pdf = """([x, y]) => { const c = document.querySelectorAll('.page')[0].querySelector('canvas.img'); if (!c.width) return null;
      const d = c.getContext('2d').getImageData(Math.floor(x / 612 * c.width), Math.floor((792 - y) / 792 * c.height), 1, 1).data; return [d[0], d[1], d[2], d[3]]; }"""
    mx = first["x"] + first["w"] / 2
    check(red(page.evaluate(at_pdf, [mx, first["y"] + first["h"] * 0.8])) and blue(page.evaluate(at_pdf, [mx, first["y"] + first["h"] * 0.2])),
          "pictures are there after reopening")
    files_before = len(ink()["files"])

    # Removing the lined page (it has a picture, so it asks first).
    page.locator("#pages-btn").click()
    settle()
    lined_idx = int(page.locator(".page[data-paper=lined]").get_attribute("data-index"))
    page.locator("#thumbs .thumb").nth(lined_idx).locator(".thumb-more").click()
    page.locator(".menu [data-action=remove-blank]").click()
    settle(900)
    data = ink()
    check(not any(str(q["page"]) == f"b:{lined_id}" for q in data["pictures"]), "removing a blank page removes its pictures")
    page.locator("#back").click()
    page.wait_for_selector("#library:not([hidden])")
    page.locator(".doc-open").first.click()
    page.wait_for_selector("#reader:not([hidden])")
    settle(1200)
    data = ink()
    check(len(data["files"]) == len({q["src"] for q in data["pictures"]}) and len(data["files"]) <= files_before,
          f"files no picture uses are tidied away on opening ({files_before} -> {len(data['files'])})")
    check(not errors, f"no page errors {errors}")
    ctx.close()

    # ---------- a narrow phone: the picture button fits ----------
    phone = b.new_context(viewport={"width": 360, "height": 740}, locale="ko-KR", has_touch=True, is_mobile=True)
    ph = phone.new_page()
    ph.goto(f"http://localhost:{PORT}/")
    ph.wait_for_selector("#library:not([hidden])")
    ph.set_input_files("#file-input", S + "test.pdf")
    ph.wait_for_selector("#reader:not([hidden])")
    ph.wait_for_timeout(800)
    fit = ph.evaluate("() => { const t = document.querySelector('#toolbar'); const b = document.querySelector('#add-picture').getBoundingClientRect(); return [t.scrollWidth <= t.clientWidth + 1, b.right <= innerWidth, b.width > 0]; }")
    check(fit == [True, True, True], f"on a 360 px phone the toolbar fits, picture button included {fit}")
    ph.locator("#add-picture").click()
    check(ph.locator(".menu [data-action=paste-picture]").count() == 1 and ph.locator(".menu [data-action=choose-picture]").count() == 1, "the picture button offers paste and choose")
    phone.close()
    b.close()

srv.shutdown()
print("\nFAILED:" if fails else "\nALL PASSED", fails)
sys.exit(1 if fails else 0)
