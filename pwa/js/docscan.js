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

// ---------- krom blad rechttrekken ----------
//
// Een gebogen blad (boek, opgerold papier) geeft kromme notenbalken. Die horen
// recht te lopen; daaraan meten we de kromming:
//   1. Alleen de liggende lijnen overhouden (notenbalken, tekstregels).
//   2. Het blad in staande stroken knippen; per strook een "streepjescode"
//      (aantal zwarte pixels per rij).
//   3. Vanuit het midden naar links en rechts: hoeveel schuift het patroon op
//      t.o.v. de buurstrook? Per stuk blad (boven, midden, onder...) apart.
//   4. Die verschuivingen glad maken (kromme per rij) en de pixels terugschuiven.
// Geeft een nieuwe RGBA-Mat, of null als het blad al recht is of er te weinig
// lijnen zijn om op te meten.

const DW_STRIPS = 24;
const DW_MAX_STEP = 6; // max verschuiving tussen buurstroken (px, verkleind)

// Kleinste-kwadraten polynoom (graad g) door punten met gewichten.
function polyFit(xs, ys, ws, g) {
  const n = g + 1;
  const A = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let i = 0; i < xs.length; i++) {
    if (!ws[i]) continue;
    const p = [];
    for (let k = 0, v = 1; k < n; k++, v *= xs[i]) p.push(v);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) A[r][c] += ws[i] * p[r] * p[c];
      A[r][n] += ws[i] * p[r] * ys[i];
    }
  }
  // Gauss-eliminatie (klein stelsel).
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
    if (Math.abs(A[piv][c]) < 1e-12) return null;
    [A[c], A[piv]] = [A[piv], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

const polyAt = (co, x) => co.reduce((a, c, i) => a + c * x ** i, 0);

// Verschuiving van patroon b t.o.v. a rond rij y0 (venster [y0-h, y0+h]), hooguit r:
// genormaliseerde kruiscorrelatie, met parabool voor een fractie van een pixel.
function bestShift(a, b, y0, h, r) {
  const n = a.length;
  const lo = Math.max(0, Math.round(y0 - h));
  const hi = Math.min(n - 1, Math.round(y0 + h));
  let ma = 0;
  let cnt = 0;
  for (let y = lo; y <= hi; y++) {
    ma += a[y];
    cnt++;
  }
  ma /= cnt || 1;
  let va = 0;
  for (let y = lo; y <= hi; y++) va += (a[y] - ma) ** 2;
  if (va < 1e-6) return null;
  const scores = [];
  for (let t = -r; t <= r; t++) {
    let mb = 0;
    let c = 0;
    for (let y = lo; y <= hi; y++) {
      const yy = y + t;
      if (yy >= 0 && yy < n) mb += b[yy];
      c++;
    }
    mb /= c || 1;
    let s = 0;
    let vb = 0;
    for (let y = lo; y <= hi; y++) {
      const yy = y + t;
      const bv = (yy >= 0 && yy < n ? b[yy] : 0) - mb;
      s += (a[y] - ma) * bv;
      vb += bv * bv;
    }
    scores.push(vb > 1e-6 ? s / Math.sqrt(va * vb) : -1);
  }
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  const best = scores[bi];
  if (best < 0.5) return null; // te onzeker
  let frac = 0;
  if (bi > 0 && bi < scores.length - 1) {
    const l = scores[bi - 1];
    const rr = scores[bi + 1];
    const d = l - 2 * best + rr;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (l - rr)) / d));
  }
  return { d: bi - r + frac, score: best };
}

export function dewarp(cv, rgba) {
  const W = rgba.cols;
  const H = rgba.rows;
  const f = Math.min(1, 1000 / W);
  const Ws = Math.max(200, Math.round(W * f));
  const Hs = Math.max(200, Math.round(H * f));
  const fx = Ws / W;
  const fy = Hs / H;

  // 1. Liggende lijnen.
  let mask;
  using((k) => {
    const g = k(new cv.Mat());
    cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
    const s = k(new cv.Mat());
    cv.resize(g, s, new cv.Size(Ws, Hs), 0, 0, cv.INTER_AREA);
    const bin = k(new cv.Mat());
    let block = Math.round(Ws / 40) | 1;
    block = Math.max(15, block);
    cv.adaptiveThreshold(s, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY_INV, block, 12);
    const lines = k(new cv.Mat());
    const kw = Math.max(9, Math.round(Ws / 70));
    cv.morphologyEx(bin, lines, cv.MORPH_OPEN, k(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(kw, 1))));
    mask = new Uint8Array(lines.data);
  });

  // 2. Streepjescode per strook.
  const n = DW_STRIPS;
  const sw = Ws / n;
  const prof = [];
  for (let s = 0; s < n; s++) {
    const p = new Float32Array(Hs);
    const x0 = Math.round(s * sw);
    const x1 = Math.round((s + 1) * sw);
    for (let y = 0; y < Hs; y++) {
      let c = 0;
      const row = y * Ws;
      for (let x = x0; x < x1; x++) if (mask[row + x]) c++;
      p[y] = c;
    }
    // Licht vervagen: lijnen van 1-2 px moeten elkaar nog "zien" bij een halve pixel verschil.
    const q = new Float32Array(Hs);
    for (let y = 0; y < Hs; y++) q[y] = 0.25 * (p[y - 1] || 0) + 0.5 * p[y] + 0.25 * (p[y + 1] || 0);
    prof.push(q);
  }

  // 3. Verschuiving per strook en per stuk blad, vanuit het midden.
  const nb = 10;
  const bh = Hs / nb;
  const mid = Math.floor(n / 2);
  const xsC = Array.from({ length: n }, (_, s) => ((s + 0.5) * sw) / Ws); // 0..1
  const D = Array.from({ length: n }, () => new Float32Array(nb * 2 - 1));
  const Wt = Array.from({ length: n }, () => new Float32Array(nb * 2 - 1));
  const yc = Array.from({ length: nb * 2 - 1 }, (_, j) => (j + 1) * (bh / 2));
  for (let j = 0; j < yc.length; j++) {
    Wt[mid][j] = 1;
    for (const dir of [1, -1]) {
      let prev = mid;
      let acc = 0;
      for (let s = mid + dir; s >= 0 && s < n; s += dir) {
        const r = bestShift(prof[prev], prof[s], yc[j] + acc, bh * 0.75, DW_MAX_STEP);
        if (r) {
          acc += r.d;
          D[s][j] = acc;
          Wt[s][j] = r.score;
          prev = s;
        } else {
          D[s][j] = acc;
          Wt[s][j] = 0; // niets te meten: verder vanaf de laatste goede strook
        }
      }
    }
  }

  // 4. Per rij-blok een gladde kromme (graad 3) door de metingen.
  const curves = yc.map((_, j) => {
    const ws = D.map((_, s) => Wt[s][j]);
    if (ws.filter((w) => w > 0).length < n * 0.45) return null;
    return polyFit(xsC, D.map((d) => d[j]), ws, 3);
  });
  const good = curves.map((c, j) => (c ? j : -1)).filter((j) => j >= 0);
  if (good.length < 2) return null;
  // Ontbrekende blokken opvullen met de dichtstbijzijnde, en wat gladstrijken over de hoogte.
  const filled = curves.map((c, j) => c || curves[good.reduce((a, g) => (Math.abs(g - j) < Math.abs(a - j) ? g : a), good[0])]);
  const smooth = filled.map((_, j) => {
    const idx = [j - 1, j, j + 1].filter((i) => i >= 0 && i < filled.length);
    return filled[j].map((_, k) => idx.reduce((a, i) => a + filled[i][k], 0) / idx.length);
  });

  // Raster met verschuivingen (verkleinde pixels), elke 8 px.
  const step = 8;
  const gw = Math.ceil(Ws / step) + 1;
  const gh = Math.ceil(Hs / step) + 1;
  const grid = new Float32Array(gw * gh);
  let maxAbs = 0;
  for (let gy = 0; gy < gh; gy++) {
    const y = gy * step;
    // Tussen twee blokken lineair; boven het eerste en onder het laatste blok vast.
    let j = 0;
    while (j < yc.length - 1 && yc[j + 1] < y) j++;
    const j2 = Math.min(yc.length - 1, j + 1);
    const t = j2 === j ? 0 : Math.max(0, Math.min(1, (y - yc[j]) / (yc[j2] - yc[j])));
    for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(1, (gx * step) / Ws);
      const v = (1 - t) * polyAt(smooth[j], x) + t * polyAt(smooth[j2], x);
      grid[gy * gw + gx] = v;
      maxAbs = Math.max(maxAbs, Math.abs(v));
    }
  }
  // Al (bijna) recht: niets doen. Absurd groot: meting niet te vertrouwen.
  dewarp.last = maxAbs / fy; // ter controle: grootste verschuiving in pixels
  if (maxAbs < 0.6 || maxAbs > Hs * 0.08) return null;

  // Pixels terugschuiven (alleen verticaal; per pixel lineair tussen twee rijen).
  const out = new cv.Mat(H, W, cv.CV_8UC4);
  const src = rgba.data;
  const dst = out.data;
  const row = W * 4;
  for (let y = 0; y < H; y++) {
    const gyf = (y * fy) / step;
    const gy0 = Math.min(gh - 2, Math.floor(gyf));
    const ty = Math.min(1, gyf - gy0);
    for (let x = 0; x < W; x++) {
      const gxf = (x * fx) / step;
      const gx0 = Math.min(gw - 2, Math.floor(gxf));
      const tx = Math.min(1, gxf - gx0);
      const i0 = gy0 * gw + gx0;
      const d =
        (1 - ty) * ((1 - tx) * grid[i0] + tx * grid[i0 + 1]) + ty * ((1 - tx) * grid[i0 + gw] + tx * grid[i0 + gw + 1]);
      let sy = y + d / fy;
      if (sy < 0) sy = 0;
      else if (sy > H - 1.001) sy = H - 1.001;
      const y0 = sy | 0;
      const a = sy - y0;
      const p0 = y0 * row + x * 4;
      const p1 = p0 + row;
      const o = y * row + x * 4;
      dst[o] = src[p0] + (src[p1] - src[p0]) * a;
      dst[o + 1] = src[p0 + 1] + (src[p1 + 1] - src[p0 + 1]) * a;
      dst[o + 2] = src[p0 + 2] + (src[p1 + 2] - src[p0 + 2]) * a;
      dst[o + 3] = 255;
    }
  }
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
