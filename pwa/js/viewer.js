// Volledig-scherm lezer voor één nummer (of een afspeellijst).
//
// Bladeren: tik rechts/links, veeg, pedaal (toetsen), of auto-scroll.
// Midden tikken toont/verbergt de knoppen. Knijpen of dubbeltik = zoomen.

import { db } from "./db.js";
import { loadPdf, renderPage, pageAspect, findContentBox } from "./pdf.js";
import { getSong, saveSong, markOpened } from "./library.js";
import { getSetlist } from "./setlists.js";
import { settings, setSetting } from "./settings.js";
import { loadInk, saveInk, drawInk, hitTest, STAMP_GROUPS, STAMP_SIZES, COLORS, loadMusicFont } from "./ink.js";
import { Metronome, tempoName } from "./metronome.js";
import { $, h, fill, toast, dialog, promptDlg, confirmDlg, menu, fmtTime } from "./ui.js";
import { icon } from "./icons.js";

const root = () => $("#viewer");
const S = () => settings();

const st = {
  open: false,
  song: null,
  doc: null,
  pages: 0,
  page: 1,
  half: false, // halve-pagina-stand (onderste helft huidige + bovenste helft volgende)
  boxes: new Map(), // pagina -> inhoudsvak (bijsnijden)
  aspects: new Map(),
  ink: new Map(), // pagina -> items
  cache: new Map(), // sleutel -> {canvas, box}
  token: 0,
  list: null, // afspeellijst
  listIndex: 0,
  tool: null, // null | "pen" | "marker" | "eraser" | "text" | "link"
  stamp: null,
  selected: null, // geselecteerd teken {page, item}
  undo: [],
  returnPage: 0,
  autoScroll: false,
  metro: new Metronome(),
  wake: null,
  audioUrl: null,
  loopA: null,
  loopB: null,
  penSeen: false,
};

// ---------- openen / sluiten ----------

export async function openSong(songId, opts = {}) {
  const song = await getSong(songId);
  if (!song) return toast("Nummer niet gevonden");
  const blob = await db.get("files", songId);
  if (!blob) return toast("PDF ontbreekt");

  if (!st.open) {
    st.open = true;
    buildDom();
    loadMusicFont().then(() => st.open && document.querySelectorAll("#v-pages .v-page").forEach(drawPageInk));
    root().hidden = false;
    document.body.classList.add("viewing");
    history.pushState({ viewer: true }, "");
    if (S().fullscreen) enterFullscreen();
    if (S().keepAwake) requestWake();
    showChrome(true, 2500);
  }

  if (opts.setlistId) {
    st.list = await getSetlist(opts.setlistId);
    st.listIndex = opts.index || 0;
  } else if (!opts.keepList) {
    st.list = null;
  }

  if (st.doc) st.doc.destroy();
  st.song = song;
  st.doc = await loadPdf(blob);
  st.pages = st.doc.numPages;
  st.page = Math.min(Math.max(1, opts.page || 1), st.pages);
  st.half = false;
  cam.x = cam.y = 0;
  cam.z = 1;
  st.selected = null;
  st.boxes.clear();
  st.aspects.clear();
  st.cache.clear();
  st.ink.clear();
  st.undo = [];
  st.returnPage = 0;
  st.metro.setBpm(song.bpm || 100);
  if (song.beats) st.metro.beats = song.beats;
  setTool(null);
  stopAutoScroll();
  closePanels();
  setupAudio();
  markOpened(songId);
  updateChrome();
  await render();
}

export function closeViewer(fromPop = false) {
  if (!st.open) return;
  st.open = false;
  clearTimeout(chromeTimer);
  st.metro.stop();
  stopAutoScroll();
  const a = $("#v-audio-el");
  if (a) a.pause();
  if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
  st.audioUrl = null;
  if (st.doc) st.doc.destroy();
  st.doc = null;
  st.cache.clear();
  root().hidden = true;
  root().innerHTML = "";
  document.body.classList.remove("viewing");
  releaseWake();
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (!fromPop) history.back();
  document.dispatchEvent(new CustomEvent("library"));
  document.dispatchEvent(new CustomEvent("viewer-closed"));
}

window.addEventListener("popstate", () => {
  if (st.open) closeViewer(true);
});

function enterFullscreen() {
  const el = document.documentElement;
  if (el.requestFullscreen && !document.fullscreenElement) el.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
}

async function requestWake() {
  try {
    if ("wakeLock" in navigator) st.wake = await navigator.wakeLock.request("screen");
  } catch (e) {}
}
function releaseWake() {
  try {
    st.wake && st.wake.release();
  } catch (e) {}
  st.wake = null;
}
document.addEventListener("visibilitychange", () => {
  if (st.open && document.visibilityState === "visible" && S().keepAwake) requestWake();
});

// ---------- opbouw ----------

function btn(ic, label, onclick, cls = "") {
  return h("button", { type: "button", class: "vbtn " + cls, title: label, "aria-label": label, onclick, html: icon(ic) + `<span>${label}</span>` });
}

function buildDom() {
  const r = root();
  r.innerHTML = "";
  // De "camera": alle pagina's staan in #v-cam; zoomen en schuiven is één
  // transform op dat element. Er wordt nooit native gescrold, dus niets verspringt.
  const stage = h("div", { class: "v-stage", id: "v-stage" }, h("div", { class: "v-cam", id: "v-cam" }, h("div", { class: "v-pages", id: "v-pages" })));
  const flash = h("div", { class: "v-flash", id: "v-flash" });

  const top = h(
    "div",
    { class: "v-top", id: "v-top" },
    h("button", { type: "button", class: "vbtn back", "aria-label": "Terug", onclick: () => closeViewer(), html: icon("back") }),
    h("div", { class: "v-title" }, h("div", { class: "t1", id: "v-t1" }), h("div", { class: "t2", id: "v-t2" })),
    h(
      "div",
      { class: "v-actions" },
      btn("bookmark", "Bladwijzer", () => togglePanel("marks")),
      btn("pen", "Krabbels", () => (st.tool ? setTool(null) : setTool("pen"))),
      btn("metronome", "Tempo", () => togglePanel("metro")),
      btn("audio", "Audio", () => togglePanel("audio"), "v-audio-btn"),
      btn("scroll", "Scroll", () => toggleAutoScroll()),
      btn("more", "Meer", () => moreMenu())
    )
  );

  const bottom = h(
    "div",
    { class: "v-bottom", id: "v-bottom" },
    h("button", { type: "button", class: "vbtn", id: "v-prevsong", "aria-label": "Vorig nummer", onclick: () => gotoSong(-1), html: icon("prevSong") }),
    h("input", { type: "range", id: "v-slider", min: 1, max: 1, value: 1, oninput: (e) => goto(+e.target.value) }),
    h("div", { class: "v-count", id: "v-count" }),
    h("button", { type: "button", class: "vbtn", id: "v-nextsong", "aria-label": "Volgend nummer", onclick: () => gotoSong(1), html: icon("nextSong") })
  );

  const tools = h("div", { class: "v-tools", id: "v-tools", hidden: true });
  const panel = h("div", { class: "v-panel", id: "v-panel", hidden: true });
  const ret = h("button", { type: "button", class: "v-return", id: "v-return", hidden: true, onclick: () => jumpBack(), html: icon("undo") + "<span>Terug</span>" });
  const scrollPill = h("div", { class: "v-scrollpill", id: "v-scrollpill", hidden: true });

  r.append(stage, flash, top, bottom, tools, panel, ret, scrollPill, h("audio", { id: "v-audio-el", preload: "auto" }));
  attachGestures(stage);
  let lastSize = "";
  new ResizeObserver(() => {
    const s = stage.clientWidth + "x" + stage.clientHeight;
    if (st.open && s !== lastSize) {
      lastSize = s;
      debounceRender();
    }
  }).observe(stage);
}

let renderTimer = 0;
function debounceRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => render(), 120);
}

// ---------- camera (zoom + schuiven) ----------

const cam = { x: 0, y: 0, z: 1 };
const MAX_ZOOM = 5;
let camRaf = 0;
let camAnim = 0;
let camTarget = null;

function stageSize() {
  const s = $("#v-stage");
  return { W: s.clientWidth, H: s.clientHeight };
}

function contentSize() {
  const c = $("#v-pages");
  return { w: c.offsetWidth, h: c.offsetHeight };
}

// Houd de inhoud in beeld: kleiner dan het scherm = centreren, groter = niet voorbij de rand.
function clampCam(c = cam) {
  const { W, H } = stageSize();
  const { w, h: ch } = contentSize();
  const sw = w * c.z;
  const sh = ch * c.z;
  c.x = sw <= W ? (W - sw) / 2 : Math.min(0, Math.max(W - sw, c.x));
  c.y = sh <= H ? (H - sh) / 2 : Math.min(0, Math.max(H - sh, c.y));
  return c;
}

function applyCam() {
  if (camRaf) return;
  camRaf = requestAnimationFrame(() => {
    camRaf = 0;
    const el = $("#v-cam");
    if (el) el.style.transform = `translate3d(${cam.x}px, ${cam.y}px, 0) scale(${cam.z})`;
    root().classList.toggle("zoomed", cam.z > 1.01);
    if (root().dataset.mode === "scroll") trackScrollPage();
  });
}

function stopCamAnim() {
  cancelAnimationFrame(camAnim);
  camAnim = 0;
}

function animateCam(target, ms = 220, done) {
  stopCamAnim();
  clampCam(target);
  camTarget = target;
  const from = { ...cam };
  const t0 = performance.now();
  const frame = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - Math.pow(1 - k, 3);
    cam.x = from.x + (target.x - from.x) * e;
    cam.y = from.y + (target.y - from.y) * e;
    cam.z = from.z + (target.z - from.z) * e;
    applyCam();
    if (k < 1) camAnim = requestAnimationFrame(frame);
    else {
      camAnim = 0;
      done && done();
    }
  };
  camAnim = requestAnimationFrame(frame);
}

// Zoom naar z met het punt (sx, sy) op het scherm vast.
function zoomAt(z, sx, sy, animate = true) {
  z = Math.max(1, Math.min(MAX_ZOOM, z));
  const px = (sx - cam.x) / cam.z;
  const py = (sy - cam.y) / cam.z;
  const t = { x: sx - px * z, y: sy - py * z, z };
  if (animate) animateCam(t, 220, sharpenSoon);
  else {
    Object.assign(cam, clampCam(t));
    applyCam();
    sharpenSoon();
  }
}

function zoomCenter(factor) {
  const { W, H } = stageSize();
  // Snel achter elkaar tikken: verder rekenen vanaf waar de animatie heen ging.
  if (camAnim && camTarget) {
    stopCamAnim();
    Object.assign(cam, camTarget);
  }
  zoomAt(cam.z * factor, W / 2, H / 2);
}

// Na het zoomen de pagina's scherper tekenen (zelfde maat op het scherm, meer pixels).
let sharpenTimer = 0;
function sharpenSoon() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(sharpen, 180);
}

async function sharpen() {
  if (!st.open) return;
  const token = st.token;
  for (const el of document.querySelectorAll("#v-pages .v-page")) {
    if (token !== st.token) return;
    const want = targetRes(el._w, el._box, el._aspect);
    if (Math.abs(want - el._res) / el._res < 0.15) continue;
    const sheet = await getSheet(el._p, el._box, el._aspect, want);
    if (token !== st.token) return;
    const c = el._sheet;
    c.width = sheet.width;
    c.height = sheet.height;
    c.getContext("2d").drawImage(sheet, 0, 0);
    el._res = want;
    el._ink.width = sheet.width;
    el._ink.height = sheet.height;
    drawPageInk(el);
  }
}

// ---------- weergave ----------

function effectiveMode() {
  const { W, H } = stageSize();
  const landscape = W > H * 1.15;
  let m = S().viewMode;
  if (st.autoScroll) return "scroll";
  if (m === "auto") m = landscape && st.pages > 1 ? "double" : "single";
  if (m === "double" && st.pages < 2) m = "single";
  return m;
}

async function getAspect(p) {
  if (!st.aspects.has(p)) st.aspects.set(p, await pageAspect(st.doc, p));
  return st.aspects.get(p);
}

async function getBox(p) {
  if (!S().autoCrop) return { x: 0, y: 0, w: 1, h: 1 };
  if (!st.boxes.has(p)) {
    const c = await renderPage(st.doc, p, 500);
    st.boxes.set(p, findContentBox(c));
  }
  return st.boxes.get(p);
}

async function getInk(p) {
  if (!st.ink.has(p)) st.ink.set(p, await loadInk(st.song.id, p));
  return st.ink.get(p);
}

const DPR = () => Math.min(window.devicePixelRatio || 1, 3);

// Aantal pixels in de breedte voor een pagina die w css-pixels breed is.
function targetRes(w, box, aspect) {
  let px = w * DPR() * Math.max(1, cam.z);
  // Geheugen van tablets sparen: hele pagina hooguit ~12 megapixel.
  px = Math.min(px, 4096, box.w * Math.sqrt(12e6 / aspect));
  return Math.round(px);
}

// Bijgesneden pagina als canvas van pixelW breed (met cache).
async function getSheet(p, box, aspect, pixelW) {
  const key = `${p}:${pixelW}:${S().autoCrop ? 1 : 0}`;
  let sheet = st.cache.get(key);
  if (sheet) {
    st.cache.delete(key);
    st.cache.set(key, sheet);
    return sheet;
  }
  const ca = (box.h * aspect) / box.w;
  const full = await renderPage(st.doc, p, pixelW / box.w);
  sheet = document.createElement("canvas");
  sheet.width = pixelW;
  sheet.height = Math.round(pixelW * ca);
  const sctx = sheet.getContext("2d", { alpha: false });
  sctx.imageSmoothingQuality = "high";
  sctx.drawImage(full, box.x * full.width, box.y * full.height, box.w * full.width, box.h * full.height, 0, 0, sheet.width, sheet.height);
  full.width = full.height = 0;
  st.cache.set(key, sheet);
  if (st.cache.size > 8) {
    const old = st.cache.keys().next().value;
    const c = st.cache.get(old);
    c.width = c.height = 0;
    st.cache.delete(old);
  }
  return sheet;
}

// Element voor één pagina, passend in slotW x slotH (css-pixels, zoom 1).
async function pageEl(p, slotW, slotH, fitWidthOnly = false) {
  const aspect = await getAspect(p);
  const box = await getBox(p);
  const ca = (box.h * aspect) / box.w;
  const w = Math.floor(fitWidthOnly ? slotW : Math.min(slotW, slotH / ca));
  const hgt = Math.floor(w * ca);
  const res = targetRes(w, box, aspect);
  const sheet = await getSheet(p, box, aspect, res);

  const shown = document.createElement("canvas");
  shown.width = sheet.width;
  shown.height = sheet.height;
  shown.getContext("2d").drawImage(sheet, 0, 0);
  shown.className = "v-sheet";

  const ink = h("canvas", { class: "v-ink" });
  ink.width = sheet.width;
  ink.height = sheet.height;

  const el = h("div", { class: "v-page", dataset: { page: p } }, shown, ink);
  el.style.width = w + "px";
  el.style.height = hgt + "px";
  Object.assign(el, { _p: p, _w: w, _h: hgt, _box: box, _aspect: aspect, _ink: ink, _sheet: shown, _res: res, _args: [p, slotW, slotH, fitWidthOnly] });
  await getInk(p);
  drawPageInk(el);
  addLinks(el);
  return el;
}

function drawPageInk(el) {
  const items = S().showNotes ? st.ink.get(el._p) || [] : [];
  drawInk(el._ink.getContext("2d"), items, el._box, el._ink.width, el._ink.height, st.selected && st.selected.page === el._p ? st.selected.item : null);
}

// Alleen de krabbel-laag opnieuw tekenen (geen nieuwe opmaak, dus niets verspringt).
function refreshInk(p) {
  document.querySelectorAll(`#v-pages .v-page[data-page="${p}"]`).forEach(drawPageInk);
}

// Pagina opnieuw opbouwen op dezelfde plek en maat (bijv. na nieuwe sprong).
async function refreshPage(p) {
  for (const el of document.querySelectorAll(`#v-pages .v-page[data-page="${p}"]`)) {
    const n = await pageEl(...el._args);
    el.replaceWith(n);
  }
}

function addLinks(el) {
  const box = el._box;
  for (const [i, ln] of (st.song.links || []).entries()) {
    if (ln.page !== el._p) continue;
    const lx = ((ln.x - box.x) / box.w) * 100;
    const ly = ((ln.y - box.y) / box.h) * 100;
    if (lx < 0 || lx > 100 || ly < 0 || ly > 100) continue;
    el.append(
      h(
        "button",
        {
          type: "button",
          class: "v-link",
          style: `left:${lx}%;top:${ly}%`,
          onpointerdown: (e) => e.stopPropagation(),
          onpointerup: (e) => e.stopPropagation(),
          onclick: (e) => {
            e.stopPropagation();
            onLinkTap(i);
          },
        },
        "→ " + ln.to
      )
    );
  }
}

async function render(keepCam = false) {
  if (!st.doc || !st.open || !$("#v-stage")) return;
  try {
    await renderInner(keepCam);
  } catch (e) {
    if (st.open) console.error(e);
  }
}

async function renderInner(keepCam) {
  const token = ++st.token;
  const wrap = $("#v-pages");
  const { W, H } = stageSize();
  const mode = effectiveMode();
  root().classList.toggle("night", !!S().nightSheet);

  if (mode === "scroll") {
    root().dataset.mode = mode;
    return renderScroll(token, W, H);
  }

  const gap = 6;
  const els = [];
  if (mode === "double") {
    els.push(await pageEl(st.page, (W - gap) / 2, H));
    if (st.page + 1 <= st.pages) els.push(await pageEl(st.page + 1, (W - gap) / 2, H));
  } else if (st.half && st.page < st.pages) {
    const cur = await pageEl(st.page, W, H);
    const nxt = await pageEl(st.page + 1, W, H);
    // halfOrder "curTop": boven = onderste helft van deze pagina, onder = bovenste helft van de volgende.
    const parts = S().halfOrder === "nextTop" ? [[nxt, "top"], [cur, "bottom"]] : [[cur, "bottom"], [nxt, "top"]];
    const comp = h("div", { class: "v-half" });
    parts.forEach(([el, half], i) => {
      const part = h("div", { class: "v-halfpart " + half }, el);
      part.style.height = el._h / 2 + "px";
      comp.append(part);
      if (i === 0) comp.append(h("div", { class: "v-halfline" }));
    });
    comp.style.width = Math.max(cur._w, nxt._w) + "px";
    els.push(comp);
  } else {
    els.push(await pageEl(st.page, W, H));
  }
  if (token !== st.token) return;
  root().dataset.mode = mode;
  wrap.className = "v-pages paged";
  wrap.style.width = W + "px";
  wrap.style.height = H + "px";
  fill(wrap, ...els);
  if (!keepCam) {
    // Zelfde zoom houden, maar bovenaan de (nieuwe) pagina beginnen.
    cam.y = 0;
  }
  clampCam();
  applyCam();
  updateChrome();
  prerender(W, H, mode);
}

// Volgende pagina's alvast klaarzetten zodat omslaan direct gaat.
function prerender(W, H, mode) {
  const n = mode === "double" ? 2 : 1;
  const slot = mode === "double" ? (W - 6) / 2 : W;
  const token = st.token;
  setTimeout(async () => {
    for (let i = 0; i < n + 1; i++) {
      const p = st.page + n + i;
      if (token !== st.token || p > st.pages) return;
      const aspect = await getAspect(p);
      const box = await getBox(p);
      const ca = (box.h * aspect) / box.w;
      const w = Math.floor(Math.min(slot, H / ca));
      await getSheet(p, box, aspect, targetRes(w, box, aspect)).catch(() => {});
    }
  }, 150);
}

let scrollSlots = [];
async function renderScroll(token, W, H) {
  const wrap = $("#v-pages");
  const colW = Math.floor(Math.min(W, Math.max(H * 0.9, W * 0.7)));
  const slots = [];
  for (let p = 1; p <= st.pages; p++) {
    const aspect = await getAspect(p);
    const box = st.boxes.get(p) || (S().autoCrop ? { x: 0, y: 0, w: 1, h: 0.9 } : { x: 0, y: 0, w: 1, h: 1 });
    const ph = h("div", { class: "v-slot", dataset: { page: p } });
    ph.style.width = colW + "px";
    ph.style.height = Math.floor((colW * box.h * aspect) / box.w) + "px";
    slots.push(ph);
  }
  if (token !== st.token) return;
  scrollSlots = slots;
  wrap.className = "v-pages scroll";
  wrap.style.width = W + "px";
  wrap.style.height = "";
  fill(wrap, ...slots);
  const target = slots[st.page - 1];
  cam.y = target ? -target.offsetTop * cam.z : 0;
  clampCam();
  applyCam();

  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting || en.target._done) continue;
        en.target._done = true;
        const p = +en.target.dataset.page;
        pageEl(p, colW, H, true).then((el) => {
          if (token !== st.token) return;
          const before = en.target.offsetHeight;
          const aboveView = (en.target.offsetTop + before) * cam.z + cam.y < 0;
          fill(en.target, el);
          en.target.style.height = el.style.height;
          // Pagina boven het beeld werd hoger of lager: beeld vasthouden.
          if (aboveView) {
            cam.y -= (el._h - before) * cam.z;
            clampCam();
            applyCam();
          }
        });
      }
    },
    { root: $("#v-stage"), rootMargin: "150% 0px" }
  );
  slots.forEach((s) => io.observe(s));
  updateChrome();
}

function trackScrollPage() {
  const { H } = stageSize();
  const mid = (-cam.y + H * 0.35) / cam.z;
  let cur = 1;
  for (const s of scrollSlots) if (s.offsetTop <= mid) cur = +s.dataset.page;
  if (cur !== st.page) {
    st.page = cur;
    updateChrome();
  }
}

function updateChrome() {
  if (!st.open || !st.song || !$("#v-t1")) return;
  $("#v-t1").textContent = st.song.title;
  const bits = [];
  if (st.list) bits.push(`${st.listIndex + 1}/${st.list.songIds.length} · ${st.list.name}`);
  if (st.song.composer) bits.push(st.song.composer);
  if (st.song.key) bits.push(st.song.key);
  if (st.song.bpm) bits.push(st.song.bpm + " bpm");
  $("#v-t2").textContent = bits.join(" · ");
  const mode = root().dataset.mode;
  const last = mode === "double" ? Math.min(st.pages, st.page + 1) : st.half ? st.page + 1 : st.page;
  $("#v-count").textContent = (last > st.page ? `${st.page}-${last}` : st.page) + " / " + st.pages;
  const sl = $("#v-slider");
  sl.max = st.pages;
  sl.value = st.page;
  sl.hidden = st.pages < 2;
  $("#v-prevsong").hidden = $("#v-nextsong").hidden = !st.list;
  if (st.list) {
    $("#v-prevsong").disabled = st.listIndex <= 0;
    $("#v-nextsong").disabled = st.listIndex >= st.list.songIds.length - 1;
  }
  root().classList.toggle("has-audio", !!st.song.audioId);
}

// ---------- bladeren ----------

function step() {
  return root().dataset.mode === "double" ? 2 : 1;
}

// Ingezoomd: eerst verder naar beneden schuiven, pas aan de onderkant omslaan.
function panPage(dir) {
  const { H } = stageSize();
  const { h: ch } = contentSize();
  const minY = H - ch * cam.z;
  if (dir > 0 && cam.y > minY + 2) {
    animateCam({ x: cam.x, y: cam.y - H * 0.85, z: cam.z });
    return true;
  }
  if (dir < 0 && cam.y < -2) {
    animateCam({ x: cam.x, y: cam.y + H * 0.85, z: cam.z });
    return true;
  }
  return false;
}

export function next() {
  if (!st.open) return;
  const mode = root().dataset.mode;
  if (mode === "scroll") return scrollBy(1);
  if (cam.z > 1.01 && panPage(1)) return;
  if (S().halfTurn && mode === "single" && !st.half && st.page < st.pages) {
    st.half = true;
    return render();
  }
  if (st.half) {
    st.half = false;
    st.page += 1;
    turnAnim(1);
    return render();
  }
  if (st.page + step() <= st.pages) {
    st.page += step();
    turnAnim(1);
    render();
  } else if (st.list && st.listIndex < st.list.songIds.length - 1) {
    gotoSong(1);
  } else {
    bump(1);
  }
}

export function prev() {
  if (!st.open) return;
  const mode = root().dataset.mode;
  if (mode === "scroll") return scrollBy(-1);
  if (cam.z > 1.01 && panPage(-1)) return;
  if (st.half) {
    st.half = false;
    return render();
  }
  if (st.page > 1) {
    st.page = Math.max(1, st.page - step());
    turnAnim(-1);
    render();
  } else if (st.list && st.listIndex > 0) {
    gotoSong(-1, true);
  } else {
    bump(-1);
  }
}

function goto(p) {
  st.page = Math.min(Math.max(1, p), st.pages);
  st.half = false;
  if (root().dataset.mode === "scroll") {
    const el = scrollSlots[st.page - 1];
    if (el) {
      stopCamAnim();
      cam.y = -el.offsetTop * cam.z;
      clampCam();
      applyCam();
    }
    updateChrome();
  } else render();
}

async function gotoSong(dir, toEnd = false) {
  if (!st.list) return;
  const i = st.listIndex + dir;
  if (i < 0 || i >= st.list.songIds.length) return;
  st.listIndex = i;
  const id = st.list.songIds[i];
  const s = await getSong(id);
  await openSong(id, { keepList: true, page: toEnd && s ? s.pages : 1 });
  toast(`${i + 1}. ${s ? s.title : ""}`, 1500);
}

function scrollBy(dir) {
  const { H } = stageSize();
  animateCam({ x: cam.x, y: cam.y - dir * H * 0.85, z: cam.z }, 300);
}

function turnAnim(dir) {
  const w = $("#v-pages");
  w.classList.remove("turn-l", "turn-r");
  void w.offsetWidth;
  w.classList.add(dir > 0 ? "turn-l" : "turn-r");
}

function bump(dir) {
  const w = $("#v-pages");
  w.classList.remove("bump-l", "bump-r");
  void w.offsetWidth;
  w.classList.add(dir > 0 ? "bump-l" : "bump-r");
}

// ---------- knoppenbalk ----------

let chromeTimer = 0;
function showChrome(show, autoHideMs = 0) {
  root().classList.toggle("chrome", show);
  clearTimeout(chromeTimer);
  if (show && autoHideMs) chromeTimer = setTimeout(() => !st.tool && !panelOpen() && showChrome(false), autoHideMs);
}
const chromeVisible = () => root().classList.contains("chrome");
const panelOpen = () => !!$("#v-panel") && !$("#v-panel").hidden;

// ---------- gebaren ----------
//
// 1 vinger: tikken (omslaan / knoppen), vegen (omslaan), schuiven als ingezoomd.
// 2 vingers: knijpen = zoomen, samen bewegen = schuiven. Werkt ook in tekenstand.

function attachGestures(stage) {
  const pts = new Map();
  let g = null; // huidig gebaar
  let lastTap = null;
  let inertia = 0;

  const local = (e) => {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const canPan = () => cam.z > 1.01 || root().dataset.mode === "scroll";

  function startPinch() {
    const [a, b] = [...pts.values()];
    g = {
      type: "pinch",
      d0: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)),
      m0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      cam0: { ...cam },
    };
  }

  function startPan(p, e) {
    g = { type: "pending", x0: p.x, y0: p.y, t0: performance.now(), cam0: { ...cam }, vx: 0, vy: 0, lx: p.x, ly: p.y, lt: performance.now(), e };
  }

  stage.addEventListener("pointerdown", (e) => {
    stopCamAnim();
    cancelAnimationFrame(inertia);
    stage.setPointerCapture(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (e.pointerType === "pen") st.penSeen = true;

    if (pts.size === 2) {
      if (g && g.type === "draw") abortDraw(g.d);
      lastTap && clearTimeout(lastTap.timer);
      lastTap = null;
      startPinch();
      return;
    }
    if (pts.size > 2) return;

    const drawTool = st.tool && st.tool !== "link";
    const touchPans = st.penSeen && e.pointerType === "touch";
    if (drawTool && !touchPans) {
      const d = beginDraw(e);
      if (d) {
        g = { type: "draw", d };
        return;
      }
    }
    startPan(p, e);
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (!g) return;

    if (g.type === "pinch" && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const z = Math.max(1, Math.min(MAX_ZOOM, (g.cam0.z * d) / g.d0));
      // Het punt dat onder de vingers lag, blijft onder de vingers (ook bij schuiven).
      const px = (g.m0.x - g.cam0.x) / g.cam0.z;
      const py = (g.m0.y - g.cam0.y) / g.cam0.z;
      cam.z = z;
      cam.x = m.x - px * z;
      cam.y = m.y - py * z;
      clampCam();
      applyCam();
      return;
    }
    if (g.type === "draw") return moveDraw(g.d, e);
    if (g.type === "pending" || g.type === "pan") {
      const dx = p.x - g.x0;
      const dy = p.y - g.y0;
      if (g.type === "pending" && Math.hypot(dx, dy) > 8) g.type = canPan() ? "pan" : "swipe";
      if (g.type === "pan") {
        const now = performance.now();
        const dt = Math.max(1, now - g.lt);
        g.vx = (p.x - g.lx) / dt;
        g.vy = (p.y - g.ly) / dt;
        g.lx = p.x;
        g.ly = p.y;
        g.lt = now;
        cam.x = g.cam0.x + dx;
        cam.y = g.cam0.y + dy;
        clampCam();
        applyCam();
      }
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (!g) return;

    if (g.type === "pinch") {
      if (pts.size === 1) {
        // Eén vinger blijft staan: verder schuiven met die vinger.
        const [q] = [...pts.values()];
        startPan(q, e);
        g.type = "pan";
        return;
      }
      if (pts.size === 0) {
        g = null;
        if (cam.z < 1.08) animateCam({ x: 0, y: cam.y, z: 1 }, 180, sharpenSoon);
        else sharpenSoon();
      }
      return;
    }
    if (g.type === "draw") {
      endDraw(g.d);
      g = null;
      return;
    }
    const cur = g;
    g = null;
    if (e.type === "pointercancel") return;
    const dx = p.x - cur.x0;
    const dy = p.y - cur.y0;
    const dt = performance.now() - cur.t0;

    if (cur.type === "pan") return glide(cur.vx, cur.vy);
    if (cur.type === "swipe") {
      if (S().swipe && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 700) dx < 0 ? next() : prev();
      return;
    }
    if (dt < 500) handleTap(p, e);
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);

  function glide(vx, vy) {
    let last = performance.now();
    const frame = (now) => {
      const dt = now - last;
      last = now;
      cam.x += vx * dt;
      cam.y += vy * dt;
      clampCam();
      applyCam();
      vx *= Math.pow(0.94, dt / 16);
      vy *= Math.pow(0.94, dt / 16);
      if (Math.abs(vx) + Math.abs(vy) > 0.02) inertia = requestAnimationFrame(frame);
    };
    if (Math.abs(vx) + Math.abs(vy) > 0.1) inertia = requestAnimationFrame(frame);
  }

  function handleTap(p, e) {
    const { W } = stageSize();
    const fx = p.x / W;
    if (st.tool === "link") return placeLink(e);
    if (st.tool) return;

    const zoneW = 0.3;
    if (S().tapZones && fx > 1 - zoneW) {
      lastTap = null;
      return next();
    }
    if (S().tapZones && fx < zoneW) {
      lastTap = null;
      return S().tapLeftPrev ? prev() : next();
    }
    // Midden: enkel = knoppen tonen/verbergen, dubbel = zoomen.
    const now = performance.now();
    if (lastTap && now - lastTap.t < 300 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 40) {
      clearTimeout(lastTap.timer);
      lastTap = null;
      if (cam.z > 1.01) animateCam({ x: 0, y: 0, z: 1 }, 220, sharpenSoon);
      else zoomAt(2.2, p.x, p.y);
      return;
    }
    const timer = setTimeout(() => {
      lastTap = null;
      if (panelOpen()) closePanels();
      else showChrome(!chromeVisible());
    }, 260);
    lastTap = { t: now, x: p.x, y: p.y, timer };
  }

  let wheelAcc = 0;
  let wheelTimer = 0;
  stage.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey) return zoomAt(cam.z * Math.exp(-e.deltaY / 300), p.x, p.y, false);
      if (canPan()) {
        stopCamAnim();
        cam.x -= e.deltaX;
        cam.y -= e.deltaY;
        clampCam();
        applyCam();
        return;
      }
      // Muiswiel zonder zoom: omslaan.
      wheelAcc += e.deltaY;
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(() => (wheelAcc = 0), 300);
      if (Math.abs(wheelAcc) > 120) {
        wheelAcc > 0 ? next() : prev();
        wheelAcc = -Math.sign(wheelAcc) * 1000; // één keer per zwiep
      }
    },
    { passive: false }
  );
}

// ---------- toetsen / pedaal ----------

document.addEventListener("keydown", (e) => {
  if (!st.open) return;
  if (e.target.closest && e.target.closest("input, textarea, select, .dlg-back")) return;
  if (e.target.tagName === "BUTTON" && (e.key === " " || e.key === "Enter")) return;
  const fwd = ["PageDown", "ArrowRight", "ArrowDown", " ", "Enter", "MediaTrackNext"];
  const back = ["PageUp", "ArrowLeft", "ArrowUp", "Backspace", "MediaTrackPrevious"];
  let dir = 0;
  if (fwd.includes(e.key)) dir = 1;
  else if (back.includes(e.key)) dir = -1;
  else if (e.key === "Escape") {
    if (st.tool) setTool(null);
    else if (panelOpen()) closePanels();
    else closeViewer();
    e.preventDefault();
    return;
  } else if (e.key === "+" || e.key === "=") return zoomCenter(1.25);
  else if (e.key === "-") return zoomCenter(1 / 1.25);
  else if ((e.ctrlKey || e.metaKey) && e.key === "z") return undo();
  if (!dir) return;
  e.preventDefault();
  if (S().pedalSwap) dir = -dir;
  dir > 0 ? next() : prev();
});

// ---------- krabbels ----------

function setTool(t) {
  st.tool = t;
  if (t !== "text") selectStamp(null);
  root().classList.toggle("drawing", !!t);
  const bar = $("#v-tools");
  if (!bar) return;
  bar.hidden = !t;
  if (t) {
    showChrome(false);
    renderToolbar();
    if (!S().showNotes) {
      setSetting("showNotes", true);
      document.querySelectorAll("#v-pages .v-page").forEach(drawPageInk);
    }
  }
}

function currentStamp() {
  return st.stamp || STAMP_GROUPS[0].items[4]; // mf
}

function renderToolbar() {
  const bar = $("#v-tools");
  const tb = (name, ic, label) =>
    h("button", {
      type: "button",
      class: "tbtn" + (st.tool === name ? " active" : ""),
      title: label,
      "aria-label": label,
      onclick: () => {
        if (name !== "text") selectStamp(null);
        st.tool = name;
        renderToolbar();
        if (name === "text" && !st.stamp) pickStamp();
      },
      html: icon(ic),
    });
  const colors = h(
    "div",
    { class: "tcolors" },
    COLORS.map((c) =>
      h("button", {
        type: "button",
        class: "tcolor" + (S().penColor === c ? " active" : ""),
        style: `--c:${c}`,
        "aria-label": "Kleur",
        onclick: () => {
          setSetting("penColor", c);
          if (st.selected) {
            st.selected.item.c = c;
            saveSelected();
          }
          renderToolbar();
        },
      })
    )
  );
  const extra = [];
  if (st.tool === "text") {
    const s = currentStamp();
    extra.push(
      h("span", { class: "tsep" }),
      h("button", { type: "button", class: "tstamp-btn f-" + s.f, title: "Teken kiezen", onclick: pickStamp }, s.v),
      h("button", { type: "button", class: "tbtn", "aria-label": "Kleiner", title: "Kleiner", onclick: () => resizeStamp(-1) }, h("span", { class: "tsize small" }, "A")),
      h("button", { type: "button", class: "tbtn", "aria-label": "Groter", title: "Groter", onclick: () => resizeStamp(1) }, h("span", { class: "tsize" }, "A"))
    );
    if (st.selected) extra.push(h("button", { type: "button", class: "tbtn", "aria-label": "Teken weghalen", title: "Teken weghalen", onclick: deleteSelected, html: icon("close") }));
  } else if (st.tool === "pen" || st.tool === "marker") {
    extra.push(
      h(
        "div",
        { class: "twidths" },
        [2, 3, 6].map((w) =>
          h("button", { type: "button", class: "twidth" + (S().penWidth === w ? " active" : ""), "aria-label": "Dikte", onclick: () => { setSetting("penWidth", w); renderToolbar(); } }, h("i", { style: `height:${w + 1}px` }))
        )
      )
    );
  }
  fill(
    bar,
    tb("pen", "pen", "Pen"),
    tb("marker", "marker", "Markeerstift"),
    tb("text", "stamp", "Tekens en tekst"),
    tb("eraser", "eraser", "Gum"),
    tb("link", "link", "Sprong maken"),
    h("span", { class: "tsep" }),
    colors,
    ...extra,
    h("span", { class: "tsep" }),
    h("button", { type: "button", class: "tbtn", title: "Ongedaan maken", "aria-label": "Ongedaan maken", onclick: undo, html: icon("undo") }),
    h("button", { type: "button", class: "tbtn", title: "Pagina wissen", "aria-label": "Pagina wissen", onclick: clearPage, html: icon("trash") }),
    h("button", { type: "button", class: "tbtn done", onclick: () => setTool(null), html: icon("check") + "<span>Klaar</span>" }),
    st.tool === "link" ? h("span", { class: "thint" }, "Tik waar de sprong moet komen") : null
  );
}

// Kiezer met alle tekens als symbolen, per groep.
async function pickStamp() {
  let chosen = null;
  const grid = h(
    "div",
    { class: "stamp-picker" },
    STAMP_GROUPS.map((g) =>
      h(
        "section",
        {},
        h("h3", {}, g.name),
        h(
          "div",
          { class: "stamp-grid" },
          g.items.map((it) =>
            h(
              "button",
              {
                type: "button",
                class: "stamp-opt" + (st.stamp && st.stamp.v === it.v ? " on" : ""),
                title: it.label,
                "aria-label": it.label,
                onclick: () => {
                  chosen = it;
                  dialog.close && dialog.close(true);
                },
              },
              h("span", { class: "glyph f-" + it.f }, it.v)
            )
          )
        )
      )
    )
  );
  const own = await dialog({ title: "Kies een teken", content: grid, buttons: [{ label: "Eigen tekst…", value: "own" }, { label: "Sluiten", value: false }] });
  if (own === "own") {
    const t = await promptDlg("Eigen tekst", "", { placeholder: "bijv. Solo, 2x, adem, Jan" });
    if (t) chosen = { label: t, v: t, f: "t" };
  }
  if (chosen) {
    st.stamp = chosen;
    st.tool = "text";
    selectStamp(null);
  }
  renderToolbar();
}

function stampSize() {
  const i = Math.max(0, Math.min(STAMP_SIZES.length - 1, S().stampSize ?? 2));
  return STAMP_SIZES[i];
}

function resizeStamp(dir) {
  if (st.selected) {
    const it = st.selected.item;
    const before = st.ink.get(st.selected.page).map((x) => ({ ...x }));
    it.s = Math.max(0.01, Math.min(0.2, it.s * (dir > 0 ? 1.25 : 0.8)));
    st.undo.push({ page: st.selected.page, before });
    saveSelected();
  } else {
    setSetting("stampSize", Math.max(0, Math.min(STAMP_SIZES.length - 1, (S().stampSize ?? 2) + dir)));
    toast(["Heel klein", "Klein", "Normaal", "Groot", "Heel groot"][S().stampSize], 900);
  }
}

function selectStamp(sel) {
  const prevPage = st.selected && st.selected.page;
  st.selected = sel;
  if (prevPage) refreshInk(prevPage);
  if (sel) refreshInk(sel.page);
  if ($("#v-tools") && !$("#v-tools").hidden) renderToolbar();
}

function saveSelected() {
  if (!st.selected) return;
  const p = st.selected.page;
  saveInk(st.song.id, p, st.ink.get(p));
  refreshInk(p);
}

function deleteSelected() {
  if (!st.selected) return;
  const { page, item } = st.selected;
  const items = st.ink.get(page);
  st.undo.push({ page, before: items.slice() });
  items.splice(items.indexOf(item), 1);
  saveInk(st.song.id, page, items);
  selectStamp(null);
}

function pageAt(e) {
  const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains("v-page"));
  if (!el) return null;
  const r = el._ink.getBoundingClientRect();
  const box = el._box;
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  return { el, page: el._p, x: box.x + fx * box.w, y: box.y + fy * box.h, rect: r };
}

function beginDraw(e) {
  const hit = pageAt(e);
  if (!hit) return null;
  if (!st.ink.has(hit.page)) st.ink.set(hit.page, []);
  const items = st.ink.get(hit.page);
  const pageW = hit.rect.width / hit.el._box.w; // schermbreedte van de hele pagina
  const before = items.map((x) => ({ ...x }));

  if (st.tool === "text") {
    // Bestaand teken aangeraakt: selecteren en verslepen. Anders: nieuw teken.
    const i = hitTest(items.filter((x) => x.t === "text"), hit.x, hit.y, 16 / pageW, hit.el._aspect);
    const texts = items.filter((x) => x.t === "text");
    let item;
    if (i >= 0) item = texts[i];
    else {
      const s = currentStamp();
      item = { t: "text", c: S().penColor, s: stampSize(), x: hit.x, y: hit.y, v: s.v, f: s.f };
      items.push(item);
    }
    selectStamp({ page: hit.page, item });
    return { stamp: true, page: hit.page, el: hit.el, item, items, before, dx: item.x - hit.x, dy: item.y - hit.y, moved: i < 0 };
  }
  if (st.tool === "eraser") {
    const d = { erase: true, page: hit.page, el: hit.el, items, before, pageW };
    eraseAt(d, hit);
    return d;
  }
  const w = (st.tool === "marker" ? S().penWidth * 5 : S().penWidth) / pageW;
  const it = { t: st.tool, c: st.tool === "marker" ? markerColor(S().penColor) : S().penColor, w, p: [hit.x, hit.y] };
  items.push(it);
  refreshInk(hit.page);
  return { page: hit.page, el: hit.el, it, items, before };
}

function markerColor(c) {
  return c === "#111111" ? "#fde047" : c;
}

function toPage(d, ev) {
  const r = d.el._ink.getBoundingClientRect();
  const box = d.el._box;
  return { x: box.x + ((ev.clientX - r.left) / r.width) * box.w, y: box.y + ((ev.clientY - r.top) / r.height) * box.h };
}

function moveDraw(d, e) {
  if (d.stamp) {
    const q = toPage(d, e);
    d.item.x = +(q.x + d.dx).toFixed(4);
    d.item.y = +(q.y + d.dy).toFixed(4);
    d.moved = true;
    refreshInk(d.page);
    return;
  }
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const q = toPage(d, ev);
    if (d.erase) eraseAt(d, q);
    else d.it.p.push(+q.x.toFixed(4), +q.y.toFixed(4));
  }
  if (!d.erase) refreshInk(d.page);
}

function eraseAt(d, pt) {
  const i = hitTest(d.items, pt.x, pt.y, 14 / d.pageW, d.el._aspect);
  if (i >= 0) {
    d.items.splice(i, 1);
    refreshInk(d.page);
  }
}

function endDraw(d) {
  if (d.stamp && !d.moved) return;
  if (d.erase && d.items.length === d.before.length) return;
  st.undo.push({ page: d.page, before: d.before });
  saveInk(st.song.id, d.page, d.items);
  if (d.stamp) renderToolbar();
}

// Tweede vinger kwam erbij: het was knijpen, geen tekenen.
function abortDraw(d) {
  if (d.stamp || d.erase) {
    st.ink.set(d.page, d.before);
    if (d.stamp) selectStamp(null);
  } else {
    d.items.splice(d.items.indexOf(d.it), 1);
  }
  refreshInk(d.page);
}

async function undo() {
  const u = st.undo.pop();
  if (!u) return toast("Niets om ongedaan te maken");
  st.ink.set(u.page, u.before);
  selectStamp(null);
  await saveInk(st.song.id, u.page, u.before);
  refreshInk(u.page);
}

async function clearPage() {
  const pages = [...new Set([...document.querySelectorAll("#v-pages .v-page")].map((el) => el._p))].filter((p) => (st.ink.get(p) || []).length);
  if (!pages.length) return toast("Geen krabbels op deze pagina");
  const label = pages.length > 1 ? `pagina ${pages.join(" en ")}` : `pagina ${pages[0]}`;
  if (!(await confirmDlg("Krabbels wissen?", `Alle krabbels op ${label} verdwijnen.`, "Wissen", true))) return;
  selectStamp(null);
  for (const p of pages) {
    st.undo.push({ page: p, before: st.ink.get(p).slice() });
    st.ink.set(p, []);
    await saveInk(st.song.id, p, []);
    refreshInk(p);
  }
}

// ---------- sprongen (herhalingen, D.S., coda) ----------

async function placeLink(e) {
  const hit = pageAt(e);
  if (!hit) return;
  const v = await promptDlg(`Sprong naar welke pagina? (1-${st.pages})`, "", { type: "number", okLabel: "Maken" });
  const to = parseInt(v, 10);
  if (!to || to < 1 || to > st.pages) return;
  st.song.links = st.song.links || [];
  st.song.links.push({ page: hit.page, x: +hit.x.toFixed(4), y: +hit.y.toFixed(4), to });
  await saveSong(st.song);
  setTool(null);
  toast("Sprong gemaakt. Tik erop om te springen.");
  refreshPage(hit.page);
}

async function onLinkTap(i) {
  const ln = st.song.links[i];
  if (!ln) return;
  if (st.tool === "link" || st.tool === "eraser") {
    if (await confirmDlg("Sprong verwijderen?", "", "Verwijderen", true)) {
      st.song.links.splice(i, 1);
      await saveSong(st.song);
      refreshPage(ln.page);
    }
    return;
  }
  st.returnPage = st.page;
  $("#v-return").hidden = false;
  goto(ln.to);
}

function jumpBack() {
  if (st.returnPage) goto(st.returnPage);
  st.returnPage = 0;
  $("#v-return").hidden = true;
}

// ---------- panelen: bladwijzers, metronoom, audio ----------

function closePanels() {
  const p = $("#v-panel");
  if (p) {
    p.hidden = true;
    p.dataset.kind = "";
  }
}

function togglePanel(kind) {
  const p = $("#v-panel");
  if (!p.hidden && p.dataset.kind === kind) return closePanels();
  p.dataset.kind = kind;
  p.hidden = false;
  clearTimeout(chromeTimer);
  if (kind === "marks") renderMarks(p);
  if (kind === "metro") renderMetro(p);
  if (kind === "audio") renderAudio(p);
}

function panelHead(title) {
  return h("div", { class: "vp-head" }, h("b", {}, title), h("button", { type: "button", class: "vbtn", "aria-label": "Sluiten", onclick: closePanels, html: icon("close") }));
}

function renderMarks(p) {
  const marks = (st.song.bookmarks || []).slice().sort((a, b) => a.page - b.page);
  fill(p, 
    panelHead("Bladwijzers"),
    h(
      "div",
      { class: "vp-list" },
      marks.length
        ? marks.map((m) =>
            h(
              "div",
              { class: "vp-row" },
              h("button", { type: "button", class: "vp-mark", onclick: () => { goto(m.page); closePanels(); } }, h("span", { class: "pg" }, m.page), m.label),
              h("button", {
                type: "button",
                class: "vbtn",
                "aria-label": "Verwijderen",
                html: icon("trash"),
                onclick: async () => {
                  st.song.bookmarks = st.song.bookmarks.filter((x) => x !== m);
                  await saveSong(st.song);
                  renderMarks(p);
                },
              })
            )
          )
        : h("p", { class: "muted" }, "Nog geen bladwijzers.")
    ),
    h(
      "button",
      {
        type: "button",
        class: "btn primary block",
        onclick: async () => {
          const label = await promptDlg("Naam bladwijzer", `Pagina ${st.page}`, { placeholder: "bijv. Trio, Coda, Solo" });
          if (label == null) return;
          st.song.bookmarks = st.song.bookmarks || [];
          st.song.bookmarks.push({ page: st.page, label: label || `Pagina ${st.page}` });
          await saveSong(st.song);
          renderMarks(p);
        },
        html: icon("plus") + "<span>Deze pagina</span>",
      }
    )
  );
}

let bpmSaveTimer = 0;
function renderMetro(p) {
  const m = st.metro;
  const bpmEl = h("div", { class: "metro-bpm" }, String(m.bpm));
  const nameEl = h("div", { class: "metro-name" }, tempoName(m.bpm));
  const set = (v) => {
    m.setBpm(v);
    bpmEl.textContent = m.bpm;
    nameEl.textContent = tempoName(m.bpm);
    clearTimeout(bpmSaveTimer);
    bpmSaveTimer = setTimeout(() => {
      st.song.bpm = m.bpm;
      st.song.beats = m.beats;
      saveSong(st.song);
      updateChrome();
    }, 800);
  };
  const playBtn = h("button", {
    type: "button",
    class: "btn primary metro-play",
    html: icon(m.running ? "pause" : "play"),
    onclick: () => {
      m.toggle();
      playBtn.innerHTML = icon(m.running ? "pause" : "play");
    },
  });
  m.onBeat = (beat, accent) => {
    if (!S().metroFlash) return;
    const f = $("#v-flash");
    if (!f) return;
    f.classList.remove("on", "accent");
    void f.offsetWidth;
    f.classList.add("on");
    if (accent) f.classList.add("accent");
  };
  const beats = h(
    "select",
    { class: "field small", onchange: (e) => { m.beats = +e.target.value; set(m.bpm); } },
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((n) => h("option", { value: n, selected: n === m.beats }, n + "/4"))
  );
  fill(p, 
    panelHead("Metronoom"),
    h(
      "div",
      { class: "metro-row" },
      h("button", { type: "button", class: "round", onclick: () => set(m.bpm - 1) }, "−"),
      h("div", { class: "metro-mid" }, bpmEl, nameEl),
      h("button", { type: "button", class: "round", onclick: () => set(m.bpm + 1) }, "+")
    ),
    h("input", { type: "range", min: 30, max: 240, value: m.bpm, class: "block", oninput: (e) => set(+e.target.value) }),
    h(
      "div",
      { class: "metro-row" },
      h("button", { type: "button", class: "btn", onclick: () => { const b = m.tap(); if (b) set(b); } }, "Tik tempo"),
      beats,
      playBtn
    )
  );
}

function setupAudio() {
  const a = $("#v-audio-el");
  a.pause();
  if (st.audioUrl) URL.revokeObjectURL(st.audioUrl);
  st.audioUrl = null;
  st.loopA = st.loopB = null;
  a.removeAttribute("src");
  if (!st.song.audioId) return;
  db.get("audio", st.song.audioId).then((rec) => {
    if (!rec || !st.open) return;
    st.audioUrl = URL.createObjectURL(rec.blob);
    a.src = st.audioUrl;
    a.preservesPitch = true;
  });
  a.ontimeupdate = () => {
    if (st.loopA != null && st.loopB != null && a.currentTime >= st.loopB) a.currentTime = st.loopA;
    const pos = $("#vp-pos");
    if (pos && !pos._drag) {
      pos.max = a.duration || 0;
      pos.value = a.currentTime;
      $("#vp-time").textContent = fmtTime(a.currentTime) + " / " + fmtTime(a.duration);
    }
  };
}

function renderAudio(p) {
  const a = $("#v-audio-el");
  if (!st.song.audioId) {
    const input = h("input", { type: "file", accept: "audio/*", hidden: true, onchange: async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await attachAudio(st.song, f);
      setupAudio();
      updateChrome();
      renderAudio(p);
    } });
    fill(p, panelHead("Audio"), h("p", { class: "muted" }, "Koppel een opname om mee te spelen."), input, h("button", { type: "button", class: "btn primary block", onclick: () => input.click(), html: icon("upload") + "<span>Audio kiezen</span>" }));
    return;
  }
  const play = h("button", { type: "button", class: "btn primary", html: icon(a.paused ? "play" : "pause"), onclick: () => { a.paused ? a.play() : a.pause(); } });
  a.onplay = a.onpause = () => (play.innerHTML = icon(a.paused ? "play" : "pause"));
  const pos = h("input", { type: "range", id: "vp-pos", min: 0, step: 0.1, max: a.duration || 0, value: a.currentTime, class: "block" });
  pos.addEventListener("pointerdown", () => (pos._drag = true));
  pos.addEventListener("change", () => { a.currentTime = +pos.value; pos._drag = false; });
  const loopBtn = (label, which) =>
    h("button", {
      type: "button",
      class: "btn" + (st[which] != null ? " on" : ""),
      onclick: (e) => {
        st[which] = st[which] == null ? a.currentTime : null;
        if (st.loopA != null && st.loopB != null && st.loopB <= st.loopA) st.loopB = null;
        renderAudio(p);
      },
    }, label + (st[which] != null ? " " + fmtTime(st[which]) : ""));
  const speed = h(
    "select",
    { class: "field small", onchange: (e) => (a.playbackRate = +e.target.value) },
    [0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1, 1.1, 1.25].map((v) => h("option", { value: v, selected: Math.abs(a.playbackRate - v) < 0.01 }, Math.round(v * 100) + "%"))
  );
  fill(p, 
    panelHead("Audio"),
    pos,
    h("div", { class: "vp-time", id: "vp-time" }, fmtTime(a.currentTime) + " / " + fmtTime(a.duration)),
    h(
      "div",
      { class: "metro-row" },
      h("button", { type: "button", class: "btn", "aria-label": "10 s terug", onclick: () => (a.currentTime = Math.max(0, a.currentTime - 10)) }, "−10s"),
      play,
      h("button", { type: "button", class: "btn", "aria-label": "10 s verder", onclick: () => (a.currentTime += 10) }, "+10s"),
      speed
    ),
    h("div", { class: "metro-row" }, h("span", { class: "muted" }, "Herhaal"), loopBtn("A", "loopA"), loopBtn("B", "loopB"))
  );
}

export async function attachAudio(song, file) {
  if (song.audioId) await db.del("audio", song.audioId);
  const id = "a" + song.id;
  await db.put("audio", id, { blob: file, name: file.name, type: file.type });
  song.audioId = id;
  await saveSong(song);
}

// ---------- auto-scroll ----------

let scrollRaf = 0;
function toggleAutoScroll() {
  st.autoScroll ? stopAutoScroll() : startAutoScroll();
}

function startAutoScroll() {
  const wasScroll = root().dataset.mode === "scroll";
  st.autoScroll = true;
  showChrome(false);
  const pill = $("#v-scrollpill");
  pill.hidden = false;
  let paused = false;
  const draw = () => {
    fill(
      pill,
      h("button", { type: "button", class: "vbtn", "aria-label": paused ? "Verder" : "Pauze", onclick: () => { paused = !paused; draw(); }, html: icon(paused ? "play" : "pause") }),
      h("button", { type: "button", class: "vbtn", "aria-label": "Langzamer", onclick: () => { setSetting("scrollSpeed", Math.max(5, S().scrollSpeed - 5)); draw(); } }, "−"),
      h("span", {}, S().scrollSpeed),
      h("button", { type: "button", class: "vbtn", "aria-label": "Sneller", onclick: () => { setSetting("scrollSpeed", Math.min(200, S().scrollSpeed + 5)); draw(); } }, "+"),
      h("button", { type: "button", class: "vbtn", "aria-label": "Stoppen", onclick: stopAutoScroll, html: icon("close") })
    );
  };
  draw();
  const go = () => {
    let last = performance.now();
    const frame = (now) => {
      if (!st.autoScroll) return;
      const dt = (now - last) / 1000;
      last = now;
      if (!paused && !camAnim) {
        const { H } = stageSize();
        const minY = H - contentSize().h * cam.z;
        cam.y = Math.max(minY, cam.y - S().scrollSpeed * dt);
        applyCam();
        if (cam.y <= minY + 1) {
          paused = true;
          draw();
        }
      }
      scrollRaf = requestAnimationFrame(frame);
    };
    scrollRaf = requestAnimationFrame(frame);
  };
  if (wasScroll) go();
  else render().then(go);
}

function stopAutoScroll() {
  if (!st.autoScroll) return;
  st.autoScroll = false;
  cancelAnimationFrame(scrollRaf);
  const pill = $("#v-scrollpill");
  if (pill) pill.hidden = true;
  if (S().viewMode !== "scroll" && st.open) render();
}

// ---------- meer-menu ----------

async function moreMenu() {
  const mode = S().viewMode;
  const v = await menu(st.song.title, [
    { label: "Eén pagina", value: "single", icon: icon("single"), active: mode === "single" },
    { label: "Twee pagina's naast elkaar", value: "double", icon: icon("double"), active: mode === "double" },
    { label: "Automatisch (liggend = twee)", value: "auto", icon: icon("expand"), active: mode === "auto" },
    { label: "Doorlopend scrollen", value: "scroll", icon: icon("vertical"), active: mode === "scroll" },
    { label: "Halve pagina omslaan", value: "half", icon: icon("half"), active: S().halfTurn },
    S().halfTurn ? { label: S().halfOrder === "nextTop" ? "Halve pagina: volgende boven" : "Halve pagina: huidige boven", value: "halforder", icon: icon("repeat") } : null,
    { label: "Witte randen wegsnijden", value: "crop", icon: icon("crop"), active: S().autoCrop },
    { label: "Nachtstand (wit op zwart)", value: "night", icon: icon("moon"), active: S().nightSheet },
    { label: "Krabbels tonen", value: "notes", icon: icon("pen"), active: S().showNotes },
    { label: "Groter", value: "zin", icon: icon("zoomIn") },
    { label: "Kleiner", value: "zout", icon: icon("zoomOut") },
    { label: "Naar pagina…", value: "goto", icon: icon("right") },
    { label: "Volledig scherm", value: "fs", icon: icon("expand") },
    { label: "Gegevens bewerken", value: "edit", icon: icon("edit") },
  ].filter(Boolean));
  if (!v) return;
  if (["single", "double", "auto", "scroll"].includes(v)) {
    setSetting("viewMode", v);
    cam.z = 1;
    st.half = false;
  } else if (v === "half") {
    setSetting("halfTurn", !S().halfTurn);
    st.half = false;
  } else if (v === "halforder") setSetting("halfOrder", S().halfOrder === "nextTop" ? "curTop" : "nextTop");
  else if (v === "crop") {
    setSetting("autoCrop", !S().autoCrop);
    st.cache.clear();
  } else if (v === "night") setSetting("nightSheet", !S().nightSheet);
  else if (v === "notes") {
    setSetting("showNotes", !S().showNotes);
    document.querySelectorAll("#v-pages .v-page").forEach(drawPageInk);
    return;
  } else if (v === "zin") return zoomCenter(1.25);
  else if (v === "zout") return zoomCenter(1 / 1.25);
  else if (v === "goto") {
    const n = await promptDlg(`Naar pagina (1-${st.pages})`, "", { type: "number" });
    if (n) goto(parseInt(n, 10));
    return;
  } else if (v === "fs") {
    document.fullscreenElement ? document.exitFullscreen().catch(() => {}) : enterFullscreen();
    return;
  } else if (v === "edit") {
    document.dispatchEvent(new CustomEvent("edit-song", { detail: { id: st.song.id, onSaved: async () => { st.song = await getSong(st.song.id); updateChrome(); setupAudio(); } } }));
    return;
  }
  render();
}

export const viewerOpen = () => st.open;
