// Titel, componist en arrangeur herkennen uit het blad zelf.
//
// Stap 1: tekst die in de PDF zit (Sibelius, MuseScore, Finale, Dorico zetten
//         titel en componist als echte tekst). Snel en betrouwbaar.
// Stap 2: OCR (Tesseract, in de browser) op de bovenkant van pagina 1, alleen
//         als stap 1 niets oplevert (scans, foto's). Eenmalig ± 9 MB downloaden,
//         daarna offline. Loopt op de achtergrond; mislukt het, dan blijft
//         gewoon de bestandsnaam staan.
//
// Wat de gebruiker zelf heeft ingevuld wordt nooit overschreven.

import { db } from "./db.js";
import { loadPdf, renderPage } from "./pdf.js";
import { getSong, saveSong } from "./library.js";
import { settings } from "./settings.js";
import { isPartText, isGarbageName, stripComposerFromTitle, cleanComposer, cleanArranger, ARRANGER_PREFIX, COMPOSER_PREFIX } from "./names.js";

const TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js";
const OCR_TIMEOUT = 60000;

// ---------- regels analyseren (gemeenschappelijk voor PDF-tekst en OCR) ----------
//
// line: { text, size (letterhoogte), x0, x1, y (0 = boven, 1 = onder; fractie van pagina) }

const NOT_TITLE = /^(score|partituur|full score|directie|conductor|tempo|allegro|andante|moderato|adagio|largo|presto|maestoso|march|mars|intro|coda|fine|d\.?[cs]\.?|\d+|[ivx]+\.?|page \d+|pagina \d+|©.*|copyright.*|all rights.*|www\..*|.*\.(com|nl|de)\b.*)$/i;
const TEMPO_MARK = /[♩=]|\bbpm\b|^\s*(q|h|e)\s*=\s*\d+/i;

function looksLikeName(s) {
  const t = s.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (/\d{3,}/.test(t) || TEMPO_MARK.test(t)) return false;
  const words = t.split(/\s+/);
  if (words.length > 6) return false;
  // Minstens één woord met hoofdletter, veel woorden met hoofdletter of tussenvoegsel.
  const capOrParticle = words.filter((w) => /^[A-ZÀ-Ý]/.test(w) || /^(van|de|der|den|von|la|le|du|di|da|ten|ter|'t)$/i.test(w) || /^[A-Z]\.?$/.test(w));
  return capOrParticle.length >= Math.ceil(words.length * 0.7) && /[a-zà-ÿ]/i.test(t);
}

export function analyseLines(lines) {
  const top = lines.filter((l) => l.y < 0.4 && l.text.trim().length > 1);
  if (!top.length) return {};
  const out = {};

  // Componist/arrangeur: eerst op sleutelwoorden ("Music by", "arr.", "Muziek:").
  for (const l of top) {
    const t = l.text.trim();
    if (!out.arranger && ARRANGER_PREFIX.test(t) && t.length < 70) out.arranger = cleanArranger(t);
    else if (!out.composer && COMPOSER_PREFIX.test(t) && t.length < 70) out.composer = cleanComposer(t);
    else {
      const m = t.match(/\b(?:arr\.?|arranged by|bew\.?)\s+(.{3,50})$/i);
      if (m && !out.arranger) out.arranger = cleanArranger(m[1]);
    }
  }

  // Titel: grootste letters bovenaan, geen partij/tempo/"Score".
  const sizes = top.map((l) => l.size).sort((a, b) => b - a);
  const candidates = top
    .filter((l) => !NOT_TITLE.test(l.text.trim()) && !isPartText(l.text) && !TEMPO_MARK.test(l.text) && /[a-z]{2}/i.test(l.text) && !ARRANGER_PREFIX.test(l.text.trim()) && !COMPOSER_PREFIX.test(l.text.trim()))
    .sort((a, b) => b.size - a.size || a.y - b.y);
  const titleLine = candidates[0];
  if (titleLine && titleLine.size >= sizes[0] * 0.8) out.title = titleLine.text.trim().replace(/\s+/g, " ");

  // Geen sleutelwoord? Componist staat meestal rechts bovenaan, kleiner dan de titel.
  if (!out.composer) {
    const right = top
      .filter((l) => l !== titleLine && l.x1 > 0.62 && l.x0 > 0.35 && looksLikeName(l.text.replace(/\(.*?\)/g, "")) && !isPartText(l.text) && !NOT_TITLE.test(l.text.trim()))
      .filter((l) => !titleLine || l.size < titleLine.size)
      .sort((a, b) => a.y - b.y);
    if (right[0]) {
      const t = right[0].text.trim();
      if (!/\barr\b/i.test(t)) out.composer = cleanComposer(t.replace(/\(\s*\d{4}\s*[-–]\s*\d{4}\s*\)/, "").replace(/\b\d{4}\s*[-–]\s*\d{4}\b/, ""));
    }
  }
  // Partij: korte regel bovenaan met een instrument ("2nd Cornet Bb", "Solo Cornet").
  const partLine = top.find((l) => l !== titleLine && isPartText(l.text) && l.text.trim().length <= 30 && !TEMPO_MARK.test(l.text));
  if (partLine) out.part = partLine.text.trim();

  for (const k of Object.keys(out)) {
    out[k] = (out[k] || "").replace(/\s+/g, " ").trim();
    if (!out[k] || out[k].length > 80) delete out[k];
  }
  return out;
}

// ---------- stap 1: tekst uit de PDF ----------

export async function fromPdfText(doc) {
  const page = await doc.getPage(1);
  const vp = page.getViewport({ scale: 1 });
  const tc = await page.getTextContent();
  page.cleanup();
  // Stukjes tekst op dezelfde hoogte samenvoegen tot regels.
  const items = tc.items
    .filter((it) => it.str && it.str.trim())
    .map((it) => {
      const [a, b, c, d, e, f] = it.transform;
      const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
      return { str: it.str, x0: e / vp.width, x1: (e + (it.width || 0)) / vp.width, y: 1 - f / vp.height, size };
    })
    .sort((p, q) => p.y - q.y || p.x0 - q.x0);
  const lines = [];
  for (const it of items) {
    const l = lines.find((l) => Math.abs(l.y - it.y) < 0.006 && Math.abs(l.size - it.size) < l.size * 0.25 && it.x0 - l.x1 < 0.08);
    if (l) {
      l.text += (it.x0 - l.x1 > 0.004 ? " " : "") + it.str;
      l.x1 = Math.max(l.x1, it.x1);
    } else lines.push({ text: it.str, x0: it.x0, x1: it.x1, y: it.y, size: it.size });
  }
  const chars = lines.reduce((n, l) => n + l.text.length, 0);
  return { lines, hasText: chars > 15, info: analyseLines(lines) };
}

// ---------- stap 2: OCR ----------

let ocrWorker = null;
let ocrIdle = 0;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Tekstherkenning kon niet laden"));
    document.head.append(s);
  });
}

async function getWorker() {
  clearTimeout(ocrIdle);
  if (!ocrWorker) {
    await loadScript(TESSERACT);
    // Standaardpaden van tesseract.js 5 (jsDelivr); taaldata wordt in IndexedDB bewaard.
    ocrWorker = window.Tesseract.createWorker(["nld", "eng"], 1, { logger: () => {} });
    ocrWorker.catch(() => (ocrWorker = null));
  }
  return ocrWorker;
}

function releaseWorkerSoon() {
  clearTimeout(ocrIdle);
  ocrIdle = setTimeout(async () => {
    const w = ocrWorker;
    ocrWorker = null;
    try {
      (await w).terminate();
    } catch (e) {}
  }, 90000);
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("Tekstherkenning duurde te lang")), ms))]);
}

export async function fromOcr(doc) {
  // Bovenste 40% van pagina 1, groot genoeg voor kleine letters.
  const full = await renderPage(doc, 1, 1700);
  const cropH = Math.round(full.height * 0.4);
  const c = document.createElement("canvas");
  c.width = full.width;
  c.height = cropH;
  c.getContext("2d").drawImage(full, 0, 0);
  full.width = full.height = 0;
  const worker = await withTimeout(getWorker(), OCR_TIMEOUT);
  try {
    const { data } = await withTimeout(worker.recognize(c), OCR_TIMEOUT);
    const W = c.width;
    const H = cropH / 0.4; // naar hele pagina terugrekenen
    const lines = (data.lines || [])
      .filter((l) => l.confidence > 45 && l.text.trim().length > 1)
      .map((l) => ({ text: l.text.replace(/\s+/g, " ").trim(), x0: l.bbox.x0 / W, x1: l.bbox.x1 / W, y: l.bbox.y0 / H, size: l.bbox.y1 - l.bbox.y0 }));
    return { lines, info: analyseLines(lines) };
  } finally {
    c.width = c.height = 0;
    releaseWorkerSoon();
  }
}

// ---------- samenvoegen met wat er al is ----------

// song.auto houdt bij welke velden de app zelf heeft ingevuld (die mag hij verbeteren).
export function mergeInfo(song, info) {
  const auto = song.auto || {};
  const changed = [];
  const canSet = (k) => !song[k] || auto[k];
  if (info.composer && canSet("composer")) {
    if (song.composer !== info.composer) changed.push("componist");
    song.composer = info.composer;
    auto.composer = true;
  }
  if (info.arranger && canSet("arranger")) {
    if (song.arranger !== info.arranger) changed.push("arrangeur");
    song.arranger = info.arranger;
    auto.arranger = true;
  }
  if (info.part && !song.part) {
    song.part = info.part;
    changed.push("partij");
  }
  // Titel alleen vervangen als de bestandsnaam niets bruikbaars gaf.
  if (info.title && (auto.titleGarbage || !song.title)) {
    song.title = info.title;
    auto.titleGarbage = false;
    auto.title = true;
    changed.push("titel");
  }
  // "01 Arsenal Jan Van der Roost": componist uit de titel halen.
  if (auto.title !== false && song.composer) {
    const t = stripComposerFromTitle(song.title, song.composer);
    if (t !== song.title) {
      song.title = t;
      changed.push("titel");
    }
  }
  song.auto = auto;
  return changed;
}

// ---------- wachtrij ----------

const queue = [];
let running = false;

export function queueRecognize(songId, { force = false } = {}) {
  if (!force && settings().autoRecognize === false) return;
  if (!queue.includes(songId)) queue.push(songId);
  if (!running) runQueue();
}

async function runQueue() {
  running = true;
  while (queue.length) {
    const id = queue.shift();
    try {
      await recognizeSong(id);
    } catch (e) {
      console.warn("herkennen mislukt", e);
    }
  }
  running = false;
}

// Geeft de lijst gewijzigde velden terug (voor een melding), of [].
export async function recognizeSong(id, { allowOcr = true } = {}) {
  const song = await getSong(id);
  if (!song) return [];
  const blob = await db.get("files", id);
  if (!blob) return [];
  const doc = await loadPdf(blob);
  let info = {};
  try {
    const t = await fromPdfText(doc).catch(() => ({ hasText: false, info: {} }));
    info = t.info || {};
    const needMore = !info.composer || (song.auto && song.auto.titleGarbage && !info.title);
    if (allowOcr && needMore && !t.hasText && navigatorOnlineOrCached()) {
      const o = await fromOcr(doc).catch((e) => {
        console.warn("OCR mislukt", e);
        return { info: {} };
      });
      info = { ...o.info, ...info };
    }
  } finally {
    doc.destroy();
  }
  const fresh = await getSong(id); // kan intussen bewerkt zijn
  if (!fresh) return [];
  const changed = mergeInfo(fresh, info);
  fresh.recognized = Date.now();
  await saveSong(fresh);
  if (changed.length) document.dispatchEvent(new CustomEvent("recognized", { detail: { id, title: fresh.title, composer: fresh.composer, changed } }));
  return changed;
}

// OCR kan offline als de onderdelen al eens gedownload zijn.
function navigatorOnlineOrCached() {
  return navigator.onLine || !!window.Tesseract;
}

export { isGarbageName };
