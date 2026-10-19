// Documentscanner met OpenCV.js: blad zoeken (4 hoeken), rechttrekken en
// verbeteren (witte achtergrond, contrast, scherper, zwart-wit).
// Alleen op de telefoon (scan.html) in gebruik. OpenCV (± 11 MB, 3,5 MB over de lijn)
// wordt één keer geladen en daarna uit de cache van de telefoon gehaald.

const CV_URL = new URL("../vendor/opencv/opencv.js", import.meta.url).href;
const CV_CACHE = "muzi-opencv-4.12.0";

let cvPromise = null;

export function loadCv() {
  if (cvPromise) return cvPromise;
  cvPromise = (async () => {
    let src = CV_URL;
    try {
      const cache = await caches.open(CV_CACHE);
      let res = await cache.match(CV_URL);
      if (!res) {
        res = await fetch(CV_URL);
        if (!res.ok) throw new Error("HTTP " + res.status);
        await cache.put(CV_URL, res.clone());
      }
      src = URL.createObjectURL(await res.blob());
      caches.keys().then((ks) => ks.filter((k) => k.startsWith("muzi-opencv-") && k !== CV_CACHE).forEach((k) => caches.delete(k)));
    } catch (e) {
      console.warn("OpenCV-cache", e);
    }
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Scanner laden mislukt"));
      document.head.append(s);
    });
    let cv = window.cv;
    if (cv instanceof Promise) cv = window.cv = await cv;
    const t0 = Date.now();
    while (!(cv && cv.Mat)) {
      if (Date.now() - t0 > 60000) throw new Error("Scanner starten duurt te lang");
      await new Promise((r) => setTimeout(r, 50));
      cv = window.cv;
    }
    // Het OpenCV-object heeft een eigen .then(); een Promise die het teruggeeft
    // blijft dan eeuwig wachten. Weghalen.
    try {
      delete cv.then;
    } catch (e) {}
    if (cv.then) cv.then = undefined;
    return cv;
  })().catch((e) => {
    cvPromise = null;
    throw e;
  });
  return cvPromise;
}

// Mats netjes opruimen (OpenCV-geheugen wordt niet vanzelf vrijgegeven).
function using(fn) {
  const list = [];
  const keep = (m) => (list.push(m), m);
  try {
    return fn(keep);
  } finally {
    for (const m of list) {
      try {
        if (m && !m.isDeleted()) m.delete();
      } catch (e) {}
    }
  }
}

// Hoeken op volgorde: linksboven, rechtsboven, rechtsonder, linksonder.
export function orderQuad(pts) {
  const s = pts.map((p) => p.x + p.y);
  const d = pts.map((p) => p.x - p.y);
  const tl = pts[s.indexOf(Math.min(...s))];
  const br = pts[s.indexOf(Math.max(...s))];
  const tr = pts[d.indexOf(Math.max(...d))];
  const bl = pts[d.indexOf(Math.min(...d))];
  return [tl, tr, br, bl];
}

const polyArea = (q) => Math.abs(q.reduce((a, p, i) => a + p.x * q[(i + 1) % q.length].y - q[(i + 1) % q.length].x * p.y, 0)) / 2;

export const fullQuad = () => [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

// Blad zoeken in een (verkleind) canvas. Geeft 4 hoeken als fracties (0..1), of null.
export function detectQuad(cv, canvas) {
  const W = canvas.width;
  const H = canvas.height;
  const minArea = W * H * 0.12;
  const cands = [];
  using((k) => {
    const src = k(cv.imread(canvas));
    const gray = k(new cv.Mat());
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    const blur = k(new cv.Mat());
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const edges = k(new cv.Mat());
    cv.Canny(blur, edges, 40, 130);
    cv.dilate(edges, edges, k(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3))), new cv.Point(-1, -1), 2);

    const bright = k(new cv.Mat());
    cv.threshold(blur, bright, 0, 255, cv.THRESH_BINARY + cv.THRESH_OTSU);
    cv.morphologyEx(bright, bright, cv.MORPH_CLOSE, k(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(15, 15))));

    for (const [bin, mode] of [
      [edges, cv.RETR_LIST],
      [bright, cv.RETR_EXTERNAL],
    ]) {
      const contours = k(new cv.MatVector());
      const hier = k(new cv.Mat());
      cv.findContours(bin, contours, hier, mode, cv.CHAIN_APPROX_SIMPLE);
      for (let i = 0; i < contours.size(); i++) {
        const c = contours.get(i);
        k(c);
        const area = cv.contourArea(c);
        if (area < minArea) continue;
        const hull = k(new cv.Mat());
        cv.convexHull(c, hull);
        const peri = cv.arcLength(hull, true);
        // Steeds grover benaderen tot er 4 hoeken over zijn.
        for (const eps of [0.02, 0.03, 0.045, 0.06, 0.08]) {
          const ap = k(new cv.Mat());
          cv.approxPolyDP(hull, ap, eps * peri, true);
          if (ap.rows === 4 && cv.isContourConvex(ap)) {
            const pts = [];
            for (let j = 0; j < 4; j++) pts.push({ x: ap.data32S[j * 2], y: ap.data32S[j * 2 + 1] });
            const q = orderQuad(pts);
            const a = polyArea(q);
            // Niet het hele beeld (rand van de foto) en geen rare smalle vormen.
            const nearFull = a > W * H * 0.97;
            if (!nearFull && a >= minArea) cands.push({ q, a });
            break;
          }
          if (ap.rows < 4) break;
        }
      }
    }
  });
  if (!cands.length) return null;
  cands.sort((a, b) => b.a - a.a);
  // Iets naar binnen, zodat er geen randje tafel mee komt.
  const q = cands[0].q;
  const cx = q.reduce((a, p) => a + p.x, 0) / 4;
  const cy = q.reduce((a, p) => a + p.y, 0) / 4;
  const inset = 0.012;
  return q.map((p) => ({ x: (p.x + (cx - p.x) * inset) / W, y: (p.y + (cy - p.y) * inset) / H }));
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Rechttrekken. quad in fracties van canvas. Geeft een RGBA-Mat (zelf .delete()!).
export function warp(cv, canvas, quad, maxSide = 2600) {
  const W = canvas.width;
  const H = canvas.height;
  const q = quad.map((p) => ({ x: p.x * W, y: p.y * H }));
  const [tl, tr, br, bl] = q;
  let w = Math.max(dist(tl, tr), dist(bl, br));
  let h = Math.max(dist(tl, bl), dist(tr, br));
  const k = Math.min(1, maxSide / Math.max(w, h));
  w = Math.max(10, Math.round(w * k));
  h = Math.max(10, Math.round(h * k));
  const out = new cv.Mat();
  using((keep) => {
    const src = keep(cv.imread(canvas));
    const from = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]));
    const to = keep(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]));
    const M = keep(cv.getPerspectiveTransform(from, to));
    cv.warpPerspective(src, out, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
  });
  return out;
}

// Achtergrond (papier) schatten: tekst weghalen met een max-filter op klein formaat.
function background(cv, ch, keep) {
  const small = keep(new cv.Mat());
  const f = 8;
  cv.resize(ch, small, new cv.Size(Math.max(8, Math.round(ch.cols / f)), Math.max(8, Math.round(ch.rows / f))), 0, 0, cv.INTER_AREA);
  cv.dilate(small, small, keep(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7))));
  const kk = Math.max(3, Math.min(31, (Math.round(Math.min(small.cols, small.rows) / 12) | 1)));
  cv.medianBlur(small, small, kk % 2 ? kk : kk + 1);
  const bg = keep(new cv.Mat());
  cv.resize(small, bg, new cv.Size(ch.cols, ch.rows), 0, 0, cv.INTER_LINEAR);
  return bg;
}

// Papier wit maken: delen door de achtergrond.
function flatten(cv, ch, keep) {
  const bg = background(cv, ch, keep);
  const out = keep(new cv.Mat());
  cv.divide(ch, bg, out, 255);
  return out;
}

function sharpen(cv, m, amount, keep) {
  const blur = keep(new cv.Mat());
  cv.GaussianBlur(m, blur, new cv.Size(0, 0), 1.4);
  cv.addWeighted(m, 1 + amount, blur, -amount, 0, m);
}

// mode: "bw" (zwart-wit), "gray", "color", "orig". Geeft een nieuwe Mat (zelf .delete()!).
export function enhance(cv, rgba, mode) {
  if (mode === "orig") return rgba.clone();
  return using((keep) => {
    if (mode === "color") {
      const rgb = keep(new cv.Mat());
      cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
      const chans = keep(new cv.MatVector());
      cv.split(rgb, chans);
      const outs = new cv.MatVector();
      keep(outs);
      for (let i = 0; i < 3; i++) {
        const c = keep(chans.get(i));
        const f = flatten(cv, c, keep);
        f.convertTo(f, -1, 1.15, -0.15 * 255);
        outs.push_back(f);
      }
      const merged = keep(new cv.Mat());
      cv.merge(outs, merged);
      sharpen(cv, merged, 0.5, keep);
      return merged.clone();
    }
    const gray = keep(new cv.Mat());
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const flat = flatten(cv, gray, keep);
    if (mode === "gray") {
      flat.convertTo(flat, -1, 1.3, -0.3 * 255);
      sharpen(cv, flat, 0.6, keep);
      return flat.clone();
    }
    // Zwart-wit: lokaal drempelen (dunne notenbalken blijven heel) en
    // overal waar het papier duidelijk licht is gewoon wit (geen spikkels).
    let block = Math.round(Math.min(flat.cols, flat.rows) / 45);
    block = Math.max(15, block % 2 ? block : block + 1);
    const ad = keep(new cv.Mat());
    cv.adaptiveThreshold(flat, ad, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, block, 9);
    const light = keep(new cv.Mat());
    cv.threshold(flat, light, 232, 255, cv.THRESH_BINARY);
    const out = keep(new cv.Mat());
    cv.bitwise_or(ad, light, out);
    return out.clone();
  });
}

// Mat → canvas (optioneel gedraaid in stappen van 90°).
export function matToCanvas(cv, mat, rot = 0, canvas = document.createElement("canvas")) {
  const tmp = document.createElement("canvas");
  cv.imshow(tmp, mat);
  const r = ((rot % 360) + 360) % 360;
  const swap = r === 90 || r === 270;
  canvas.width = swap ? tmp.height : tmp.width;
  canvas.height = swap ? tmp.width : tmp.height;
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((r * Math.PI) / 180);
  ctx.drawImage(tmp, -tmp.width / 2, -tmp.height / 2);
  ctx.restore();
  tmp.width = tmp.height = 0;
  return canvas;
}
