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
export function drawInk(ctx, items, box, w, h) {
  ctx.clearRect(0, 0, w, h);
  const sx = w / box.w;
  const sy = h / box.h;
  const X = (x) => (x - box.x) * sx;
  const Y = (y) => (y - box.y) * sy;
  for (const it of items) {
    if (it.t === "text") {
      ctx.fillStyle = it.c;
      ctx.font = `${it.b ? "italic bold" : "600"} ${Math.max(6, it.s * sx)}px Georgia, "Times New Roman", serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(it.v, X(it.x), Y(it.y));
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

export const STAMPS = ["pp", "p", "mp", "mf", "f", "ff", "cresc.", "dim.", "rit.", "a tempo", "♯", "♭", "♮", "V", "𝄐", "↑", "↓", "!", "?", "①", "②", "③"];
export const DYNAMICS = new Set(["pp", "p", "mp", "mf", "f", "ff", "cresc.", "dim.", "rit.", "a tempo"]);
export const COLORS = ["#e11d48", "#2563eb", "#111111", "#16a34a", "#f59e0b", "#9333ea"];
