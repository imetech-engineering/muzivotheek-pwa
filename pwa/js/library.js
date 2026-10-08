// Bibliotheek: nummers importeren, bewerken, sorteren en verwijderen.

import { db, uid } from "./db.js";
import { loadPdf, makeThumb } from "./pdf.js";
import { parseFileName, isGarbageName } from "./names.js";
import { imagesToPdf, isImageFile } from "./imgpdf.js";
import { queueRecognize } from "./recognize.js";
import { rotateItems, rotatePoint } from "./ink.js";

let songs = null; // cache: Map id -> song

export async function allSongs() {
  if (!songs) {
    songs = new Map();
    const keys = await db.keys("songs");
    const vals = await db.all("songs");
    keys.forEach((k, i) => songs.set(k, vals[i]));
  }
  return [...songs.values()];
}

export async function getSong(id) {
  await allSongs();
  return songs.get(id) || null;
}

export async function saveSong(song) {
  await allSongs();
  song.updated = Date.now();
  songs.set(song.id, song);
  await db.put("songs", song.id, song);
  document.dispatchEvent(new CustomEvent("library"));
  return song;
}

export function titleFromFilename(name) {
  return name
    .replace(/\.(pdf|jpe?g|png|webp|heic|heif)$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Foto's worden eerst een PDF (één pagina per foto).
async function asPdf(file) {
  if (Array.isArray(file)) return imagesToPdf(file);
  if (isImageFile(file) && !/pdf/i.test(file.type || "")) return imagesToPdf([file]);
  return file instanceof Blob ? file : new Blob([file], { type: "application/pdf" });
}

// Importeer één PDF. Geeft het nieuwe nummer terug, of null als het al bestaat.
// file: PDF, foto, of een lijst foto's (samen één nummer; extra.name geeft de naam).
export async function importPdf(file, extra = {}) {
  await allSongs();
  const first = Array.isArray(file) ? file[0] : file;
  const fileName = extra.name || first.name || "Naamloos";
  const size = Array.isArray(file) ? file.reduce((n, f) => n + f.size, 0) : file.size;
  const dup = [...songs.values()].find((s) => (extra.src && s.src === extra.src) || (s.fileName === fileName && s.fileSize === size));
  if (dup) return { song: dup, duplicate: true };

  // Titel, componist, arrangeur en partij uit de bestandsnaam.
  const parsed = parseFileName(fileName, { strictNumber: !extra.numbered });
  const garbage = !parsed.title;
  const title = parsed.title || titleFromFilename(fileName) || "Naamloos";

  const blob = await asPdf(file);
  const doc = await loadPdf(blob);
  const id = uid();
  const thumb = await makeThumb(doc).catch(() => null);
  const song = {
    id,
    title: garbage && isGarbageName(titleFromFilename(fileName)) ? (extra.fallbackTitle || title) : title,
    composer: parsed.composer,
    arranger: parsed.arranger,
    part: parsed.part,
    folder: extra.folder || "",
    genre: "",
    key: "",
    bpm: 0,
    beats: 0,
    tags: [],
    notes: "",
    favorite: false,
    pages: doc.numPages,
    fileName,
    fileSize: size || 0,
    added: Date.now(),
    opened: 0,
    played: 0,
    bookmarks: [], // {page, label}
    links: [], // {page, x, y, to}
    audioId: null,
    src: extra.src || null, // herkomst (gekoppelde map), om later wijzigingen te zien
    srcVersion: extra.srcVersion || null,
    // Welke velden de app zelf invulde (die mag herkenning nog verbeteren).
    auto: { title: true, titleGarbage: garbage, composer: !parsed.composer, arranger: !parsed.arranger },
  };
  doc.destroy();
  await db.put("files", id, blob);
  if (thumb) await db.put("thumbs", id, thumb);
  await saveSong(song);
  // Op de achtergrond titel/componist uit het blad halen.
  queueRecognize(id);
  return { song, duplicate: false };
}

// Nieuwe versie van de PDF uit de bron: bestand vervangen, gegevens en krabbels houden.
export async function replaceFile(song, file, srcVersion) {
  const blob = await asPdf(file);
  const doc = await loadPdf(blob);
  const thumb = await makeThumb(doc).catch(() => null);
  song.pages = doc.numPages;
  doc.destroy();
  song.fileSize = blob.size;
  song.srcVersion = srcVersion || null;
  await db.put("files", song.id, blob);
  if (thumb) await db.put("thumbs", song.id, thumb);
  await saveSong(song);
  document.dispatchEvent(new CustomEvent("thumb-changed", { detail: song.id }));
}

export async function findBySrc(src) {
  return (await allSongs()).find((s) => s.src === src) || null;
}

export async function deleteSong(id) {
  await allSongs();
  const s = songs.get(id);
  songs.delete(id);
  await db.del("songs", id);
  await db.del("files", id);
  await db.del("thumbs", id);
  await db.delPrefix("notes", id + ":");
  if (s && s.audioId) await db.del("audio", s.audioId);
  // Uit afspeellijsten halen.
  const keys = await db.keys("setlists");
  const lists = await db.all("setlists");
  for (let i = 0; i < lists.length; i++) {
    if (lists[i].songIds.includes(id)) {
      lists[i].songIds = lists[i].songIds.filter((x) => x !== id);
      await db.put("setlists", keys[i], lists[i]);
    }
  }
  document.dispatchEvent(new CustomEvent("library"));
}

export async function markOpened(id) {
  const s = await getSong(id);
  if (!s) return;
  s.opened = Date.now();
  s.played = (s.played || 0) + 1;
  songs.set(id, s);
  await db.put("songs", id, s);
}

export function invalidateCache() {
  songs = null;
}

const collator = new Intl.Collator("nl", { sensitivity: "base", numeric: true });

export function sortSongs(list, sort, desc) {
  const by = {
    title: (a, b) => collator.compare(a.title, b.title),
    composer: (a, b) => collator.compare(a.composer || "~", b.composer || "~") || collator.compare(a.title, b.title),
    added: (a, b) => b.added - a.added,
    opened: (a, b) => (b.opened || 0) - (a.opened || 0),
    played: (a, b) => (b.played || 0) - (a.played || 0) || collator.compare(a.title, b.title),
    folder: (a, b) => collator.compare(a.folder || "~", b.folder || "~") || collator.compare(a.title, b.title),
  }[sort] || ((a, b) => collator.compare(a.title, b.title));
  const out = [...list].sort(by);
  return desc ? out.reverse() : out;
}

export function matches(song, q) {
  if (!q) return true;
  const hay = [song.title, song.composer, song.arranger, song.part, song.folder, song.genre, song.key, (song.tags || []).join(" ")]
    .join(" ")
    .toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

export async function folders() {
  const set = new Set();
  for (const s of await allSongs()) if (s.folder) set.add(s.folder);
  return [...set].sort(collator.compare);
}

// ---------- samenvoegen en pagina's toevoegen ----------
// pdf-lib (vendor/, offline) plakt PDF's aan elkaar. Krabbels, bladwijzers en
// sprongen schuiven mee naar hun nieuwe paginanummer.

async function pdfLib() {
  if (!window.PDFLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("../vendor/pdf-lib/pdf-lib.min.js", import.meta.url).href;
      s.onload = resolve;
      s.onerror = () => reject(new Error("Samenvoegen kon niet laden"));
      document.head.append(s);
    });
  }
  return window.PDFLib;
}

async function concatPdfs(blobs) {
  const { PDFDocument } = await pdfLib();
  const out = await PDFDocument.create();
  for (const b of blobs) {
    let src;
    try {
      src = await PDFDocument.load(await b.arrayBuffer(), { ignoreEncryption: true });
    } catch (e) {
      throw new Error("Een van de PDF's kan niet worden samengevoegd (beveiligd of beschadigd)");
    }
    const pages = await out.copyPages(src, src.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }
  return new Blob([await out.save()], { type: "application/pdf" });
}

// Krabbels, bladwijzers en sprongen van een nummer, verschoven met `offset` pagina's.
async function shiftedExtras(song, offset) {
  const notes = [];
  for (let p = 1; p <= song.pages; p++) {
    const n = await db.get("notes", song.id + ":" + p);
    if (n && n.length) notes.push([offset + p, n]);
  }
  return {
    notes,
    bookmarks: (song.bookmarks || []).map((b) => ({ ...b, page: b.page + offset })),
    links: (song.links || []).map((l) => ({ ...l, page: l.page + offset, to: l.to + offset })),
  };
}

// Meerdere nummers worden één nummer (in de gegeven volgorde). Het eerste blijft
// bestaan (met zijn plek in afspeellijsten); de andere worden verwijderd.
export async function mergeSongs(ids, title) {
  await allSongs();
  const list = ids.map((id) => songs.get(id)).filter(Boolean);
  if (list.length < 2) throw new Error("Kies minstens twee nummers");
  const blobs = await Promise.all(list.map((s) => db.get("files", s.id)));
  const merged = await concatPdfs(blobs);
  const base = list[0];
  let offset = 0;
  const notes = [];
  const bookmarks = [];
  const links = [];
  for (const s of list) {
    const x = await shiftedExtras(s, offset);
    notes.push(...x.notes);
    bookmarks.push(...x.bookmarks);
    links.push(...x.links);
    offset += s.pages;
  }
  await db.delPrefix("notes", base.id + ":");
  for (const [p, n] of notes) await db.put("notes", base.id + ":" + p, n);
  base.bookmarks = bookmarks;
  base.links = links;
  if (title) base.title = title;
  base.auto = { ...(base.auto || {}), title: false, titleGarbage: false };
  // Niet meer één bronbestand: niet laten overschrijven door een gekoppelde map.
  base.src = null;
  base.srcVersion = null;
  await replaceFile(base, merged, null);
  for (const s of list.slice(1)) await deleteSong(s.id);
  return base;
}

// Pagina's echt draaien in het bestand (90° per keer; turns +1 rechtsom, -1 linksom).
// Krabbels en sprongen op die pagina's draaien mee, zodat ze op dezelfde plek blijven.
export async function rotatePages(id, pages, turns) {
  const song = await getSong(id);
  if (!song) throw new Error("Nummer niet gevonden");
  const { PDFDocument, degrees } = await pdfLib();
  const blob = await db.get("files", id);
  let pdf;
  try {
    pdf = await PDFDocument.load(await blob.arrayBuffer(), { ignoreEncryption: true });
  } catch (e) {
    throw new Error("Deze PDF kan niet gedraaid worden (beveiligd of beschadigd)");
  }
  const all = pdf.getPages();
  const aspects = new Map();
  for (const p of pages) {
    const pg = all[p - 1];
    if (!pg) continue;
    const { width, height } = pg.getSize();
    const rot = ((pg.getRotation().angle % 360) + 360) % 360;
    aspects.set(p, rot % 180 === 90 ? width / height : height / width);
    pg.setRotation(degrees((((rot + turns * 90) % 360) + 360) % 360));
  }
  const out = new Blob([await pdf.save()], { type: "application/pdf" });
  for (const [p, a] of aspects) {
    const key = id + ":" + p;
    const items = await db.get("notes", key);
    if (items && items.length) await db.put("notes", key, rotateItems(items, turns, a));
  }
  song.links = (song.links || []).map((l) => {
    if (!aspects.has(l.page)) return l;
    const [x, y] = rotatePoint(l.x, l.y, turns);
    return { ...l, x: +x.toFixed(4), y: +y.toFixed(4) };
  });
  await replaceFile(song, out, song.srcVersion);
  return song;
}

// Extra PDF('s) of foto's achteraan een bestaand nummer toevoegen.
export async function appendFiles(id, files) {
  const song = await getSong(id);
  if (!song) throw new Error("Nummer niet gevonden");
  const base = await db.get("files", id);
  const photos = files.filter((f) => isImageFile(f) && !/pdf/i.test(f.type || ""));
  const pdfs = files.filter((f) => !photos.includes(f));
  const extra = [...pdfs];
  if (photos.length) extra.push(await imagesToPdf(photos));
  const merged = await concatPdfs([base, ...extra]);
  song.src = null;
  song.srcVersion = null;
  const before = song.pages;
  await replaceFile(song, merged, null);
  return song.pages - before;
}
