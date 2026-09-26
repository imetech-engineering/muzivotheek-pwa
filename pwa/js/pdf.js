// PDF inladen en tekenen met pdf.js (meegeleverd in vendor/, werkt dus offline).

import * as pdfjs from "../vendor/pdfjs/pdf.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdfjs/pdf.worker.min.mjs", import.meta.url).href;
const FONTS = new URL("../vendor/pdfjs/standard_fonts/", import.meta.url).href;

export async function loadPdf(blob) {
  const data = new Uint8Array(await blob.arrayBuffer());
  return pdfjs.getDocument({ data, standardFontDataUrl: FONTS, isEvalSupported: false }).promise;
}

// Teken een pagina op een nieuw canvas met de gegeven breedte in pixels.
export async function renderPage(doc, pageNo, pixelWidth) {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const scale = Math.max(0.1, pixelWidth / base.width);
  const vp = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  page.cleanup();
  return canvas;
}

export async function pageAspect(doc, pageNo) {
  const page = await doc.getPage(pageNo);
  const vp = page.getViewport({ scale: 1 });
  return vp.height / vp.width;
}

// Zoek de rand van de inhoud (alles wat niet bijna-wit is). Resultaat als
// fracties van de pagina, zodat het op elke resolutie bruikbaar is.
export function findContentBox(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const step = Math.max(1, Math.floor(w / 400));
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const dark = (x, y) => {
    const i = (y * w + x) * 4;
    return data[i] + data[i + 1] + data[i + 2] < 600;
  };
  const rowHas = (y) => {
    let n = 0;
    for (let x = 0; x < w; x += step) if (dark(x, y) && ++n > 1) return true;
    return false;
  };
  const colHas = (x, y0, y1) => {
    let n = 0;
    for (let y = y0; y < y1; y += step) if (dark(x, y) && ++n > 1) return true;
    return false;
  };
  let top = 0;
  while (top < h && !rowHas(top)) top += step;
  let bottom = h - 1;
  while (bottom > top && !rowHas(bottom)) bottom -= step;
  let left = 0;
  while (left < w && !colHas(left, top, bottom)) left += step;
  let right = w - 1;
  while (right > left && !colHas(right, top, bottom)) right -= step;
  if (bottom <= top || right <= left) return { x: 0, y: 0, w: 1, h: 1 };
  // Kleine marge laten staan.
  const pad = 0.012;
  const x0 = Math.max(0, left / w - pad);
  const y0 = Math.max(0, top / h - pad);
  const x1 = Math.min(1, right / w + pad);
  const y1 = Math.min(1, bottom / h + pad);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export async function makeThumb(doc) {
  const c = await renderPage(doc, 1, 240);
  return new Promise((res) => c.toBlob((b) => res(b), "image/jpeg", 0.75));
}
