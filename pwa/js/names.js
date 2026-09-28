// Titel, componist, arrangeur en partij uit een bestandsnaam halen.
//
//   "01 Arsenal - Jan Van der Roost.pdf"      -> Arsenal / Jan Van der Roost
//   "Arsenal - 2e Cornet.pdf"                 -> Arsenal / partij 2e Cornet
//   "03. Highland Cathedral (arr. P. Kernen)" -> Highland Cathedral / arr. P. Kernen
//   "Bes Trompet 1 - Ode an die Freude.pdf"   -> Ode an die Freude / partij Bes Trompet 1
//   "IMG_2034.jpg"                            -> (geen bruikbare titel)

const INSTRUMENTS = [
  "cornet", "kornet", "trompet", "trumpet", "bugel", "flugelhorn", "flügelhorn", "flugel", "althoorn", "alt horn", "althorn",
  "tenor horn", "tenorhoorn", "tenorhorn", "bariton", "baritone", "euphonium", "trombone", "bastrombone", "bass trombone",
  "tuba", "bas", "bass", "sousafoon", "sousaphone", "hoorn", "horn", "saxofoon", "saxophone", "sax", "altsax", "tenorsax",
  "baritonsax", "sopraansax", "klarinet", "clarinet", "basklarinet", "fluit", "flute", "dwarsfluit", "piccolo", "hobo", "oboe",
  "fagot", "bassoon", "slagwerk", "percussie", "percussion", "drums", "drumstel", "kleine trom", "grote trom", "snare",
  "pauken", "timpani", "klokkenspel", "glockenspiel", "xylofoon", "xylophone", "vibrafoon", "mallets", "marimba",
  "directie", "partituur", "score", "conductor", "full score", "piano", "keyboard", "gitaar", "guitar", "contrabas",
  "repiano", "soprano", "sopraan", "cello", "viool", "violin", "altviool", "viola", "zang", "vocal",
];
const PART_WORD = new RegExp(`(^|[\\s(])(${INSTRUMENTS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?=$|[\\s\\d).,])`, "i");
// Woorden die vóór een instrument bij de partij horen: "2e", "1st", "Bes", "Eb", "solo".
const PART_PREFIX = /^(?:\d+(?:e|de|ste|st|nd|rd|th)?|[ivx]+|solo|1st|2nd|3rd|4th|bes|bb|b♭|es|eb|e♭|in|f|c|alt|tenor|bas|bariton)$/i;

const ARR = /^(?:arr(?:\.|angement|anged)?|bew(?:\.|erking)?|orch(?:\.|estration)?|transcr(?:\.|iptie|iption)?)\s*(?:by|door|:)?\s*/i;
const COMP = /^(?:music\s+by|muziek(?:\s*:)?|comp(?:\.|onist|osed\s+by|oser)?\s*:?|by|door|words\s+and\s+music\s+by)\s+/i;

export function isPartText(s) {
  return PART_WORD.test(" " + s + " ");
}

// Naam zonder zin: camera-/scannerbestanden, alleen cijfers, "document", ...
export function isGarbageName(s) {
  const t = (s || "").trim();
  if (!t) return true;
  if (/^(img|dsc|pxl|scan|scanned|document|doc|file|bestand|image|afbeelding|photo|foto|whatsapp image|screenshot|schermafbeelding|cam|pic)[\s_\-]*[\d\s_\-.:()]*(?:at [\d.\s]+)?$/i.test(t)) return true;
  if (/^[\d\s_\-.()]+$/.test(t)) return true;
  if (/^(pagina|page|blad|p|foto|photo|deel|part|img|image|bijlage|attachment)[\s_\-.]*\d*[a-z]?$/i.test(t)) return true;
  if (/^[a-f0-9-]{16,}$/i.test(t)) return true; // lange code
  return false;
}

// Voorloopnummer: "01 ", "1. ", "12 - ", "03a) ". Alleen als het duidelijk een
// volgnummer is (voorloopnul of scheidingsteken), of als strict=false.
export function stripTrackNumber(s, strict = true) {
  const re = strict ? /^\s*(?:0\d{1,2}[a-z]?\s*[.\-_):]?\s+|\d{1,3}[a-z]?\s*[.\-_):]\s*)/i : /^\s*\d{1,3}[a-z]?\s*[.\-_):]?\s+/i;
  const out = s.replace(re, "");
  return out.trim() ? out : s;
}

function tidy(s) {
  return s
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—.,:;]+|[\s\-–—.,:;]+$/g, "")
    .trim();
}

// Partij aan het eind van een stuk tekst afknippen: "Arsenal 2e Cornet" -> ["Arsenal", "2e Cornet"].
function splitTrailingPart(s) {
  const words = s.split(" ");
  for (let i = 1; i < words.length; i++) {
    const rest = words.slice(i).join(" ");
    if (!PART_WORD.test(" " + words[i] + " ") && !PART_PREFIX.test(words[i])) continue;
    // Vanaf hier moet alles partij-achtig zijn (prefix, instrument, nummer).
    const tail = words.slice(i);
    const ok = tail.every((w) => PART_PREFIX.test(w) || /^\d+$/.test(w) || isPartText(w)) && isPartText(rest);
    if (ok) return [words.slice(0, i).join(" "), rest];
  }
  return [s, ""];
}

export function parseFileName(fileName, { strictNumber = true } = {}) {
  let base = String(fileName || "")
    .replace(/\.(pdf|jpe?g|png|webp|heic)$/i, "")
    .replace(/[_]+/g, " ");
  base = tidy(stripTrackNumber(base, strictNumber));
  const out = { title: "", composer: "", arranger: "", part: "" };
  if (isGarbageName(base)) return out;

  // Haakjes: "(arr. X)", "(Componist)", "(2e Cornet)".
  base = base.replace(/\(([^)]{2,60})\)/g, (m, inner) => {
    const t = tidy(inner);
    if (ARR.test(t)) out.arranger = tidy(t.replace(ARR, ""));
    else if (isPartText(t)) out.part = t;
    else if (!out.composer && /[a-z]/i.test(t) && !/^\d+$/.test(t)) out.composer = tidy(t.replace(COMP, ""));
    else return m;
    return " ";
  });

  const segs = tidy(base)
    .split(/\s+[-–—]\s+|\s*\|\s*|\s+-{2}\s+/)
    .map(tidy)
    .filter(Boolean);
  const rest = [];
  for (const seg of segs) {
    if (ARR.test(seg)) out.arranger = out.arranger || tidy(seg.replace(ARR, ""));
    else if (isPartText(seg) && seg.split(" ").every((w) => PART_PREFIX.test(w) || /^\d+$/.test(w) || isPartText(w))) out.part = out.part || seg;
    else rest.push(seg);
  }
  // "Titel arr. Naam" binnen één stuk.
  const inlineArr = /\s+(?:arr\.?|arranged by|bew\.?|bewerking)\s+(.{2,60})$/i;
  for (let i = 0; i < rest.length; i++) {
    const m = rest[i].match(inlineArr);
    if (m) {
      out.arranger = out.arranger || tidy(m[1]);
      rest[i] = tidy(rest[i].slice(0, m.index));
    }
  }
  if (rest.length) {
    let [title, part] = splitTrailingPart(rest[0]);
    if (part && !out.part) out.part = part;
    out.title = title;
    if (rest[1] && !out.composer) out.composer = tidy(rest[1].replace(COMP, ""));
    if (rest.length > 2) out.title = [out.title, ...rest.slice(2)].join(" - ");
  }
  // Partij na de componist: "Arsenal - Van der Roost 2e Cornet".
  if (out.composer) {
    const [c, p] = splitTrailingPart(out.composer);
    if (p) {
      out.composer = c;
      out.part = out.part || p;
    }
  }
  return out;
}

// Titel eindigt op de (later herkende) componistnaam? Dan die eraf halen.
export function stripComposerFromTitle(title, composer) {
  if (!title || !composer) return title;
  const t = title.trim();
  const c = composer.trim();
  if (t.length > c.length + 2 && t.toLowerCase().endsWith(" " + c.toLowerCase())) return tidy(t.slice(0, t.length - c.length));
  // Alleen achternaam: "Arsenal Van der Roost" met componist "Jan Van der Roost".
  for (let n = 3; n >= 1; n--) {
    const tail = c.split(" ").slice(-n).join(" ");
    if (tail.length > 3 && t.toLowerCase().endsWith(" " + tail.toLowerCase())) return tidy(t.slice(0, t.length - tail.length));
  }
  return title;
}

export const cleanComposer = (s) => tidy(String(s || "").replace(COMP, "").replace(/[©(].*$/, ""));
export const cleanArranger = (s) => tidy(String(s || "").replace(ARR, ""));
export { ARR as ARRANGER_PREFIX, COMP as COMPOSER_PREFIX };
