// Bibliotheek: nummers importeren, bewerken, sorteren en verwijderen.

import { db, uid } from "./db.js";
import { loadPdf, makeThumb } from "./pdf.js";

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
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Importeer één PDF. Geeft het nieuwe nummer terug, of null als het al bestaat.
export async function importPdf(file, extra = {}) {
  await allSongs();
  const title = titleFromFilename(file.name || "Naamloos");
  const dup = [...songs.values()].find((s) => s.fileName === file.name && s.fileSize === file.size);
  if (dup) return { song: dup, duplicate: true };

  const blob = file instanceof Blob ? file : new Blob([file], { type: "application/pdf" });
  const doc = await loadPdf(blob);
  const id = uid();
  const thumb = await makeThumb(doc).catch(() => null);
  const song = {
    id,
    title,
    composer: "",
    arranger: "",
    folder: extra.folder || "",
    genre: "",
    key: "",
    bpm: 0,
    beats: 0,
    tags: [],
    notes: "",
    favorite: false,
    pages: doc.numPages,
    fileName: file.name || "",
    fileSize: file.size || 0,
    added: Date.now(),
    opened: 0,
    played: 0,
    bookmarks: [], // {page, label}
    links: [], // {page, x, y, to}
    audioId: null,
  };
  doc.destroy();
  await db.put("files", id, blob);
  if (thumb) await db.put("thumbs", id, thumb);
  await saveSong(song);
  return { song, duplicate: false };
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
  const hay = [song.title, song.composer, song.arranger, song.folder, song.genre, song.key, (song.tags || []).join(" ")]
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
