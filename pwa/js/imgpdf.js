// Foto's (JPG/PNG/WebP) omzetten naar een PDF, zodat alles in de app er
// hetzelfde mee werkt (krabbels, zoomen, lijsten). Eén foto = één pagina.

export const isImageFile = (f) => /^image\//.test(f.type || "") || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name || "");
export const isPdfFile = (f) => (f.type || "") === "application/pdf" || /\.pdf$/i.test(f.name || "");

const MAX_SIDE = 2600; // genoeg voor scherp lezen, niet te zwaar

async function toJpeg(file) {
  let bmp;
  try {
    // Draaiing van telefoonfoto's (EXIF) meteen goedzetten.
    bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch (e) {
    // Terugval via <img>.
    const url = URL.createObjectURL(file);
    try {
      bmp = await new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error(`"${file.name}" is geen leesbare afbeelding`));
        img.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  const w0 = bmp.width;
  const h0 = bmp.height;
  const k = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * k));
  const h = Math.max(1, Math.round(h0 * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { alpha: false });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  if (bmp.close) bmp.close();
  const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", 0.9));
  c.width = c.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w, h };
}

// Minimale PDF met per pagina één JPEG (DCTDecode: de JPEG gaat er ongewijzigd in).
export async function imagesToPdf(files) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let pos = 0;
  const push = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    pos += b.length;
  };
  const obj = (n, body) => {
    offsets[n] = pos;
    push(`${n} 0 obj\n`);
    body();
    push("\nendobj\n");
  };

  const imgs = [];
  for (const f of files) imgs.push(await toJpeg(f));
  const n = imgs.length;
  // Objecten: 1 catalog, 2 pages, dan per pagina: page, image, content.
  const pageNo = (i) => 3 + i * 3;
  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  obj(2, () => push(`<< /Type /Pages /Count ${n} /Kids [${imgs.map((_, i) => `${pageNo(i)} 0 R`).join(" ")}] >>`));
  imgs.forEach((im, i) => {
    // Paginabreedte A4 (595 pt), hoogte naar verhouding.
    const pw = 595;
    const ph = Math.round((595 * im.h) / im.w);
    const p = pageNo(i);
    obj(p, () => push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${p + 1} 0 R >> >> /Contents ${p + 2} 0 R >>`));
    obj(p + 1, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.bytes.length} >>\nstream\n`);
      push(im.bytes);
      push("\nendstream");
    });
    const content = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
    obj(p + 2, () => push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`));
  });
  const total = 3 + n * 3;
  const xref = pos;
  let x = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) x += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(x);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts, { type: "application/pdf" });
}
