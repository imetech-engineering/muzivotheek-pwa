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

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

async function makeZip(entries, onProgress) {
  const parts = [];
  const central = [];
  let offset = 0;
  let i = 0;
  for (const { name, data } of entries) {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === "string" ? enc.encode(data) : data;
    const nameB = enc.encode(name);
    const crc = crc32(bytes);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // utf-8 namen
    lh.setUint16(8, 0, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, bytes.length, true);
    lh.setUint32(22, bytes.length, true);
    lh.setUint16(26, nameB.length, true);
    parts.push(lh.buffer, nameB, bytes);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, bytes.length, true);
    ch.setUint32(24, bytes.length, true);
    ch.setUint16(28, nameB.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, nameB);
    offset += 30 + nameB.length + bytes.length;
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

async function readZip(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const dv = new DataView(buf.buffer);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Geen geldig back-upbestand");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("Back-up is beschadigd");
    const method = dv.getUint16(p + 10, true);
    const size = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
    if (method !== 0) throw new Error("Back-up is ingepakt met een ander programma");
    const lnlen = dv.getUint16(lho + 26, true);
    const lxlen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lxlen;
    out.set(name, buf.subarray(start, start + size));
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
  const metaBytes = files.get("muzivotheek.json");
  if (!metaBytes) throw new Error("Dit is geen Muzivotheek-back-up");
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));
  if (mode === "replace") {
    for (const s of ["songs", "files", "thumbs", "notes", "audio", "setlists"]) await db.clear(s);
  }
  let n = 0;
  for (const s of meta.songs || []) {
    const pdf = files.get(`pdf/${s.id}.pdf`);
    if (!pdf) continue;
    await db.put("files", s.id, new Blob([pdf], { type: "application/pdf" }));
    await db.put("songs", s.id, s);
    n++;
  }
  for (const l of meta.setlists || []) await db.put("setlists", l.id, l);
  for (const [k, v] of Object.entries(meta.notes || {})) await db.put("notes", k, v);
  for (const a of meta.audio || []) {
    const b = files.get(`audio/${a.id}`);
    if (b) await db.put("audio", a.id, { blob: new Blob([b], { type: a.type || "audio/mpeg" }), name: a.name, type: a.type });
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
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}
