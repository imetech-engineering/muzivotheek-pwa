// Krabbels op de bladmuziek. Coördinaten zijn fracties van de hele pagina
// (0..1), zodat ze kloppen bij elke zoom, schermgrootte en marge-instelling.
//
// Item: { t: "pen" | "marker", c: kleur, w: dikte (fractie paginabreedte), p: [x,y,x,y,...] }
//       { t: "text", c: kleur, s: grootte (fractie paginabreedte), x, y, v: tekst }

import { db } from "./db.js";

const key = (songId, page) => songId + ":" + page;

export async function loadInk(songId, page) {
  return (await db.get("notes", key(songId, page))) || [];
}

export async function saveInk(songId, page, items) {
  if (items.length) await db.put("notes", key(songId, page), items);
  else await db.del("notes", key(songId, page));
}

// Teken alle items op ctx. box = zichtbaar deel van de pagina (bij bijsnijden),
// w/h = pixelgrootte van het canvas.
export function drawInk(ctx, items, box, w, h, selected = null) {
  ctx.clearRect(0, 0, w, h);
  const sx = w / box.w;
  const sy = h / box.h;
  const X = (x) => (x - box.x) * sx;
  const Y = (y) => (y - box.y) * sy;
  for (const it of items) {
    if (it.t === "text") {
      ctx.fillStyle = it.c;
      ctx.font = fontFor(it, Math.max(6, it.s * sx));
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(it.v, X(it.x), Y(it.y));
      if (it === selected) {
        // Geselecteerd teken: stippelkader eromheen.
        const m = ctx.measureText(it.v);
        const px = Math.max(6, it.s * sx);
        const bw = m.width + px * 0.5;
        const bh = px * 1.3;
        ctx.save();
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = Math.max(1.5, px / 20);
        ctx.strokeStyle = "#c41f6e";
        ctx.strokeRect(X(it.x) - bw / 2, Y(it.y) - bh / 2, bw, bh);
        ctx.restore();
      }
      continue;
    }
    const p = it.p;
    if (!p || p.length < 2) continue;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = it.c;
    ctx.lineWidth = Math.max(1, it.w * sx);
    if (it.t === "marker") {
      ctx.globalAlpha = 0.35;
      ctx.lineCap = "butt";
    }
    ctx.beginPath();
    ctx.moveTo(X(p[0]), Y(p[1]));
    if (p.length === 2) ctx.lineTo(X(p[0]) + 0.1, Y(p[1]));
    for (let i = 2; i < p.length - 2; i += 2) {
      // Vloeiende lijn: kwadratische curve door middens.
      const mx = (p[i] + p[i + 2]) / 2;
      const my = (p[i + 1] + p[i + 3]) / 2;
      ctx.quadraticCurveTo(X(p[i]), Y(p[i + 1]), X(mx), Y(my));
    }
    if (p.length >= 4) ctx.lineTo(X(p[p.length - 2]), Y(p[p.length - 1]));
    ctx.stroke();
    ctx.restore();
  }
}

// Index van het item dat het dichtst bij (x,y) ligt binnen straal r, anders -1.
export function hitTest(items, x, y, r, aspect) {
  let best = -1;
  let bestD = r;
  const d = (ax, ay) => Math.hypot(ax - x, (ay - y) * aspect);
  items.forEach((it, i) => {
    if (it.t === "text") {
      const dd = d(it.x, it.y) - it.s * 0.6;
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
      return;
    }
    for (let j = 0; j < it.p.length; j += 2) {
      const dd = d(it.p[j], it.p[j + 1]) - it.w / 2;
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
  });
  return best;
}

// Lettertype per soort teken: m = muziektekens (Noto Music), i = cursief
// (rit., a tempo), t = gewone tekst.
export const MUSIC_FONT = '"Muzi Music"';
export function fontFor(it, px) {
  const kind = it.f || (it.b ? "i" : "t");
  if (kind === "m") return `${px}px ${MUSIC_FONT}, serif`;
  if (kind === "i") return `italic 600 ${px}px Georgia, "Times New Roman", serif`;
  return `600 ${px}px system-ui, sans-serif`;
}

export async function loadMusicFont() {
  try {
    await document.fonts.load(`32px ${MUSIC_FONT}`, "\u{1D191}");
  } catch (e) {}
}

// Tekens voor de stempel-kiezer. v = wat er getekend wordt, f = soort.
export const STAMP_GROUPS = [
  {
    name: "Dynamiek",
    items: [
      ["ppp", "\u{1D18F}\u{1D18F}\u{1D18F}"],
      ["pp", "\u{1D18F}\u{1D18F}"],
      ["p", "\u{1D18F}"],
      ["mp", "\u{1D190}\u{1D18F}"],
      ["mf", "\u{1D190}\u{1D191}"],
      ["f", "\u{1D191}"],
      ["ff", "\u{1D191}\u{1D191}"],
      ["fff", "\u{1D191}\u{1D191}\u{1D191}"],
      ["fp", "\u{1D191}\u{1D18F}"],
      ["sfz", "\u{1D18D}\u{1D191}\u{1D18E}"],
      ["cresc", "\u{1D192}"],
      ["decresc", "\u{1D193}"],
    ].map(([l, v]) => ({ label: l, v, f: "m" })),
  },
  {
    name: "Tekens",
    items: [
      ["fermate", "\u{1D110}"],
      ["adem", "\u{1D112}"],
      ["caesuur", "\u{1D113}"],
      ["segno", "\u{1D10B}"],
      ["coda", "\u{1D10C}"],
      ["herhaal begin", "\u{1D106}"],
      ["herhaal eind", "\u{1D107}"],
      ["kruis", "\u266F"],
      ["mol", "\u266D"],
      ["herstel", "\u266E"],
      ["dubbelkruis", "\u{1D12A}"],
      ["dubbelmol", "\u{1D12B}"],
      ["neerstreek", "\u{1D1AA}"],
      ["opstreek", "\u{1D1AB}"],
    ].map(([l, v]) => ({ label: l, v, f: "m" })),
  },
  {
    name: "Aandacht",
    items: [
      { label: "kijk uit", v: "\u{1F453}", f: "t" },
      { label: "omhoog", v: "\u2191", f: "t" },
      { label: "omlaag", v: "\u2193", f: "t" },
      { label: "accent", v: ">", f: "i" },
      { label: "uitroep", v: "!", f: "i" },
      { label: "vraag", v: "?", f: "i" },
      { label: "1", v: "\u2460", f: "t" },
      { label: "2", v: "\u2461", f: "t" },
      { label: "3", v: "\u2462", f: "t" },
      { label: "4", v: "\u2463", f: "t" },
    ],
  },
  {
    name: "Aanwijzing",
    items: ["rit.", "rall.", "a tempo", "cresc.", "dim.", "solo", "tutti", "tacet", "V.S."].map((v) => ({ label: v, v, f: "i" })),
  },
];

// Grootte van tekens: fractie van de paginabreedte.
export const STAMP_SIZES = [0.02, 0.03, 0.045, 0.065, 0.09];

export const COLORS = ["#e11d48", "#2563eb", "#111111", "#16a34a", "#f59e0b", "#9333ea"];
