// Back-up: alles in één .zip (PDF's, audio, krabbels, lijsten, instellingen).
// Eenvoudige zip zonder compressie (PDF's comprimeren toch nauwelijks).

import { db } from "./db.js";
import { invalidateCache } from "./library.js";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

// CRC32 in stukken: past een grote PDF/mp3 niet in het geheugen hoeft.
function crcUpdate(c, bytes) {
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return c;
}

const enc = new TextEncoder();
const CHUNK = 4 * 1024 * 1024;

// Geeft { part, size, crc }. Blobs gaan als verwijzing in de zip (niet gekopieerd naar het geheugen).
async function prep(data) {
  if (data instanceof Blob) {
    let c = 0xffffffff;
    for (let off = 0; off < data.size; off += CHUNK) c = crcUpdate(c, new Uint8Array(await data.slice(off, off + CHUNK).arrayBuffer()));
    return { part: data, size: data.size, crc: (c ^ 0xffffffff) >>> 0 };
  }
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return { part: bytes, size: bytes.length, crc: (crcUpdate(0xffffffff, bytes) ^ 0xffffffff) >>> 0 };
}

async function makeZip(entries, onProgress) {
  const parts = [];
  const central = [];
  let offset = 0;
  let i = 0;
  for (const { name, data } of entries) {
    const { part, size, crc } = await prep(data);
    const nameB = enc.encode(name);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // utf-8 namen
    lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(lh.buffer, nameB, part);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameB);
    offset += 30 + nameB.length + size;
    if (offset > 3.8e9) throw new Error("De back-up is te groot (meer dan 4 GB)");
    onProgress && onProgress(++i, entries.length);
  }
  const cdSize = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
}

// Leest alleen het inhoudsoverzicht; de bestanden zelf blijven stukken (slices) van het back-upbestand.
async function readZip(blob) {
  const tailLen = Math.min(blob.size, 65557);
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  const tdv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tdv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Geen geldig back-upbestand");
  const count = tdv.getUint16(eocd + 10, true);
  const cdSize = tdv.getUint32(eocd + 12, true);
  const cdStart = tdv.getUint32(eocd + 16, true);
  const cd = new Uint8Array(await blob.slice(cdStart, cdStart + cdSize).arrayBuffer());
  const dv = new DataView(cd.buffer);
  const dec = new TextDecoder();
  const out = new Map();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Back-up is beschadigd");
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    if (method !== 0) throw new Error("Back-up is ingepakt met een ander programma");
    const lh = new DataView(await blob.slice(lho, lho + 30).arrayBuffer());
    const start = lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.set(name, blob.slice(start, start + size));
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

export async function exportBackup(onProgress) {
  const entries = [];
  const songKeys = await db.keys("songs");
  const songs = await db.all("songs");
  const setlists = await db.all("setlists");
  const noteKeys = await db.keys("notes");
  const notes = await db.all("notes");
  const audioKeys = await db.keys("audio");
  const audio = await db.all("audio");
  let settings = {};
  try {
    settings = JSON.parse(localStorage.getItem("muzivotheek.settings") || "{}");
  } catch (e) {}

  const meta = {
    app: "muzivotheek",
    version: 1,
    created: new Date().toISOString(),
    songs,
    setlists,
    notes: Object.fromEntries(noteKeys.map((k, i) => [k, notes[i]])),
    audio: audioKeys.map((k, i) => ({ id: k, name: audio[i].name, type: audio[i].type })),
    settings,
  };
  entries.push({ name: "muzivotheek.json", data: JSON.stringify(meta) });
  for (const id of songKeys) {
    const f = await db.get("files", id);
    if (f) entries.push({ name: `pdf/${id}.pdf`, data: f });
  }
  audioKeys.forEach((k, i) => entries.push({ name: `audio/${k}`, data: audio[i].blob }));
  return makeZip(entries, onProgress);
}

// mode: "merge" (bij bestaande voegen) of "replace" (alles vervangen)
export async function importBackup(file, mode = "merge") {
  const files = await readZip(file);
  const metaBlob = files.get("muzivotheek.json");
  if (!metaBlob) throw new Error("Dit is geen MuzIVOtheek-back-up");
  const meta = JSON.parse(await metaBlob.text());
  if (mode === "replace") {
    for (const s of ["songs", "files", "thumbs", "notes", "audio", "setlists"]) await db.clear(s);
  }
  let n = 0;
  for (const s of meta.songs || []) {
    const pdf = files.get(`pdf/${s.id}.pdf`);
    if (!pdf) continue;
    await db.put("files", s.id, pdf.slice(0, pdf.size, "application/pdf"));
    await db.put("songs", s.id, s);
    n++;
  }
  for (const l of meta.setlists || []) await db.put("setlists", l.id, l);
  for (const [k, v] of Object.entries(meta.notes || {})) await db.put("notes", k, v);
  for (const a of meta.audio || []) {
    const b = files.get(`audio/${a.id}`);
    if (b) await db.put("audio", a.id, { blob: b.slice(0, b.size, a.type || "audio/mpeg"), name: a.name, type: a.type });
  }
  if (meta.settings && mode === "replace") {
    try {
      localStorage.setItem("muzivotheek.settings", JSON.stringify(meta.settings));
    } catch (e) {}
  }
  invalidateCache();
  return n;
}

export function downloadBlob(blob, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 600000);
}
