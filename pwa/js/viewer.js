// Volledig-scherm lezer voor één nummer (of een afspeellijst).
//
// Bladeren: tik rechts/links, veeg, pedaal (toetsen), of auto-scroll.
// Midden tikken toont/verbergt de knoppen. Knijpen of dubbeltik = zoomen.

import { db } from "./db.js";
import { loadPdf, renderPage, pageAspect, findContentBox } from "./pdf.js";
import { getSong, saveSong, markOpened } from "./library.js";
import { getSetlist } from "./setlists.js";
import { settings, setSetting } from "./settings.js";
import { loadInk, saveInk, drawInk, hitTest, STAMPS, DYNAMICS, COLORS } from "./ink.js";
import { Metronome, tempoName } from "./metronome.js";
import { $, h, fill, toast, promptDlg, confirmDlg, menu, fmtTime } from "./ui.js";
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
  zoom: 1,
  boxes: new Map(), // pagina -> inhoudsvak (bijsnijden)
  aspects: new Map(),
  ink: new Map(), // pagina -> items
  cache: new Map(), // sleutel -> {canvas, box}
  token: 0,
  list: null, // afspeellijst
  listIndex: 0,
  tool: null, // null | "pen" | "marker" | "eraser" | "text" | "link"
  stamp: "mf",
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
  st.zoom = 1;
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
  const stage = h("div", { class: "v-stage", id: "v-stage" }, h("div", { class: "v-pages", id: "v-pages" }));
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
  new ResizeObserver(() => st.open && debounceRender()).observe(stage);
}

let renderTimer = 0;
function debounceRender() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    st.cache.clear();
    render();
  }, 120);
}

// ---------- weergave ----------

function effectiveMode() {
  const stage = $("#v-stage");
  const landscape = stage.clientWidth > stage.clientHeight * 1.15;
  let m = S().viewMode;
  if (st.autoScroll) return "scroll";
  if (m === "single" && landscape && S().autoDouble && st.pages > 1) m = "double";
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

// Maak het element voor één pagina, passend in slotW x slotH (css-pixels).
async function pageEl(p, slotW, slotH, fitWidthOnly = false) {
  const aspect = await getAspect(p);
  const box = await getBox(p);
  const ca = (box.h * aspect) / box.w; // hoogte/breedte van zichtbare deel
  let w = fitWidthOnly ? slotW : Math.min(slotW, slotH / ca);
  w = Math.floor(w * st.zoom);
  const hgt = Math.floor(w * ca);
  const dpr = Math.min(window.devicePixelRatio || 1, 3);

  const key = `${p}:${w}:${S().autoCrop ? 1 : 0}`;
  let sheet = st.cache.get(key);
  if (!sheet) {
    // Volledige pagina renderen zo groot dat het bijgesneden deel scherp is.
    let fullW = (w / box.w) * dpr;
    const maxPx = 5000;
    fullW = Math.min(fullW, maxPx, Math.sqrt((24e6 * 1) / aspect));
    const full = await renderPage(st.doc, p, fullW);
    sheet = document.createElement("canvas");
    const pw = Math.round(Math.min(w * dpr, full.width * box.w));
    sheet.width = pw;
    sheet.height = Math.round(pw * ca);
    const sctx = sheet.getContext("2d", { alpha: false });
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(full, box.x * full.width, box.y * full.height, box.w * full.width, box.h * full.height, 0, 0, sheet.width, sheet.height);
    full.width = full.height = 0;
    st.cache.set(key, sheet);
    if (st.cache.size > 10) st.cache.delete(st.cache.keys().next().value);
  }
  const shown = document.createElement("canvas");
  shown.width = sheet.width;
  shown.height = sheet.height;
  shown.getContext("2d").drawImage(sheet, 0, 0);
  shown.className = "v-sheet";
  shown.style.width = w + "px";
  shown.style.height = hgt + "px";

  const ink = h("canvas", { class: "v-ink" });
  ink.width = Math.round(w * dpr);
  ink.height = Math.round(hgt * dpr);
  ink.style.width = w + "px";
  ink.style.height = hgt + "px";

  const el = h("div", { class: "v-page", dataset: { page: p } }, shown, ink);
  el.style.width = w + "px";
  el.style.height = hgt + "px";
  el._box = box;
  el._aspect = aspect;
  el._ink = ink;
  const items = await getInk(p);
  if (S().showNotes) drawInk(ink.getContext("2d"), items, box, ink.width, ink.height);

  // Sprong-knopjes.
  for (const [i, ln] of (st.song.links || []).entries()) {
    if (ln.page !== p) continue;
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
          dataset: { link: i },
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
  return el;
}

async function render() {
  if (!st.doc || !st.open || !$("#v-stage")) return;
  try {
    await renderInner();
  } catch (e) {
    if (st.open) console.error(e);
  }
}

async function renderInner() {
  const token = ++st.token;
  const stage = $("#v-stage");
  const wrap = $("#v-pages");
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const mode = effectiveMode();
  root().dataset.mode = mode;
  root().classList.toggle("night", !!S().nightSheet);
  root().classList.toggle("zoomed", st.zoom > 1.01);

  if (mode === "scroll") return renderScroll(token, W, H);
  stage.onscroll = null;

  const gap = 6;
  let els = [];
  if (mode === "double") {
    const p = st.page;
    const a = await pageEl(p, (W - gap) / 2, H);
    els.push(a);
    if (p + 1 <= st.pages) els.push(await pageEl(p + 1, (W - gap) / 2, H));
  } else if (st.half && st.page < st.pages) {
    const cur = await pageEl(st.page, W, H);
    const next = await pageEl(st.page + 1, W, H);
    const hh = Math.max(parseFloat(cur.style.height), parseFloat(next.style.height));
    const ww = Math.max(parseFloat(cur.style.width), parseFloat(next.style.width));
    const topHalf = h("div", { class: "v-halfpart top" }, next);
    const botHalf = h("div", { class: "v-halfpart bottom" }, cur);
    topHalf.style.height = botHalf.style.height = hh / 2 + "px";
    const comp = h("div", { class: "v-half" }, topHalf, h("div", { class: "v-halfline" }), botHalf);
    comp.style.width = ww + "px";
    els.push(comp);
  } else {
    els.push(await pageEl(st.page, W, H));
  }
  if (token !== st.token) return;
  wrap.className = "v-pages paged";
  fill(wrap, ...els);
  stage.scrollTop = 0;
  stage.scrollLeft = zoomScrollTarget ? zoomScrollTarget.x : 0;
  if (zoomScrollTarget) stage.scrollTop = zoomScrollTarget.y;
  zoomScrollTarget = null;
  updateChrome();
  prerender(W, H, mode);
}

// Volgende pagina's alvast klaarzetten zodat omslaan direct gaat.
function prerender(W, H, mode) {
  const n = mode === "double" ? 2 : 1;
  const slot = mode === "double" ? (W - 6) / 2 : W;
  const want = [];
  for (let i = 0; i < n + 1; i++) want.push(st.page + n + i);
  const token = st.token;
  setTimeout(async () => {
    for (const p of want) {
      if (token !== st.token || p > st.pages) return;
      await pageEl(p, slot, H).catch(() => {});
    }
  }, 150);
}

async function renderScroll(token, W, H) {
  const stage = $("#v-stage");
  const wrap = $("#v-pages");
  const colW = Math.min(W, Math.max(H * 0.9, W * 0.7));
  wrap.className = "v-pages scroll";
  const placeholders = [];
  for (let p = 1; p <= st.pages; p++) {
    const aspect = await getAspect(p);
    const ph = h("div", { class: "v-slot", dataset: { page: p } });
    ph.style.width = Math.floor(colW * st.zoom) + "px";
    ph.style.height = Math.floor(colW * st.zoom * aspect * 0.9) + "px";
    placeholders.push(ph);
  }
  if (token !== st.token) return;
  fill(wrap, ...placeholders);
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting || en.target._done) continue;
        en.target._done = true;
        const p = +en.target.dataset.page;
        pageEl(p, colW, H, true).then((el) => {
          if (token !== st.token) return;
          const before = en.target.offsetHeight;
          fill(en.target, el);
          en.target.style.height = el.style.height;
          // Scrollpositie vasthouden als een pagina boven het beeld van hoogte verandert.
          if (en.target.offsetTop < stage.scrollTop) stage.scrollTop += el.offsetHeight - before;
        });
      }
    },
    { root: stage, rootMargin: "150% 0px" }
  );
  placeholders.forEach((p) => io.observe(p));
  const target = placeholders[st.page - 1];
  if (target) stage.scrollTop = target.offsetTop;
  stage.onscroll = () => {
    const mid = stage.scrollTop + H * 0.35;
    let cur = 1;
    for (const ph of placeholders) if (ph.offsetTop <= mid) cur = +ph.dataset.page;
    if (cur !== st.page) {
      st.page = cur;
      updateChrome();
    }
  };
  updateChrome();
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
  const last = mode === "double" ? Math.min(st.pages, st.page + 1) : st.page;
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

export function next() {
  if (!st.open) return;
  if (root().dataset.mode === "scroll") return scrollBy(1);
  if (st.zoom > 1.01 && scrollZoomed(1)) return;
  if (S().halfTurn && root().dataset.mode === "single" && !st.half && st.page < st.pages) {
    st.half = true;
    return render();
  }
  st.half = false;
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
  if (root().dataset.mode === "scroll") return scrollBy(-1);
  if (st.zoom > 1.01 && scrollZoomed(-1)) return;
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
    const el = $(`#v-pages .v-slot[data-page="${st.page}"]`);
    if (el) $("#v-stage").scrollTop = el.offsetTop;
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
  const stage = $("#v-stage");
  stage.scrollBy({ top: dir * stage.clientHeight * 0.85, behavior: "smooth" });
}

// Bij inzoomen: eerst naar beneden/opzij schuiven voordat er wordt omgeslagen.
function scrollZoomed(dir) {
  const s = $("#v-stage");
  const maxY = s.scrollHeight - s.clientHeight;
  if (dir > 0 && s.scrollTop < maxY - 4) {
    s.scrollBy({ top: s.clientHeight * 0.85, behavior: "smooth" });
    return true;
  }
  if (dir < 0 && s.scrollTop > 4) {
    s.scrollBy({ top: -s.clientHeight * 0.85, behavior: "smooth" });
    return true;
  }
  return false;
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

let zoomScrollTarget = null;

function attachGestures(stage) {
  const pts = new Map();
  let start = null;
  let pinch = null;
  let lastTap = null;
  let drawing = null;
  let pan = null;
  let vel = { x: 0, y: 0 };
  let inertia = 0;

  stage.addEventListener("pointerdown", (e) => {
    cancelAnimationFrame(inertia);
    stage.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === "pen") st.penSeen = true;

    if (pts.size === 2) {
      // Knijpen begint: lopende tekening of veeg annuleren.
      if (drawing && !drawing.done && !drawing.erase) {
        // Net begonnen streek weghalen: het was een knijpgebaar.
        drawing.items.splice(drawing.items.indexOf(drawing.it), 1);
        redrawInk(drawing.el, drawing.items);
      }
      drawing = null;
      start = null;
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, scale: 1 };
      return;
    }
    if (pts.size > 2) return;

    const drawTool = st.tool && st.tool !== "link";
    const touchPans = st.penSeen && e.pointerType === "touch";
    if (drawTool && !touchPans) {
      drawing = beginDraw(e);
      if (drawing) return;
    }
    start = { x: e.clientX, y: e.clientY, t: performance.now(), sl: stage.scrollLeft, st: stage.scrollTop, type: e.pointerType };
    pan = { x: e.clientX, y: e.clientY, t: performance.now() };
    vel = { x: 0, y: 0 };
  });

  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      pinch.scale = Math.max(1 / st.zoom, Math.min(4 / st.zoom, d / pinch.d));
      const w = $("#v-pages");
      const r = stage.getBoundingClientRect();
      w.style.transformOrigin = `${pinch.cx - r.left + stage.scrollLeft}px ${pinch.cy - r.top + stage.scrollTop}px`;
      w.style.transform = `scale(${pinch.scale})`;
      return;
    }
    if (drawing) return moveDraw(drawing, e);
    if (!start) return;
    // Slepen: schuiven als de inhoud groter is dan het scherm.
    const canScroll = stage.scrollHeight > stage.clientHeight + 2 || stage.scrollWidth > stage.clientWidth + 2;
    if (canScroll) {
      const now = performance.now();
      const dt = Math.max(1, now - pan.t);
      vel = { x: (pan.x - e.clientX) / dt, y: (pan.y - e.clientY) / dt };
      pan = { x: e.clientX, y: e.clientY, t: now };
      stage.scrollLeft = start.sl - (e.clientX - start.x);
      stage.scrollTop = start.st - (e.clientY - start.y);
    }
  });

  const end = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pinch) {
      if (pts.size === 0) {
        const s = pinch.scale;
        const w = $("#v-pages");
        w.style.transform = "";
        const r = stage.getBoundingClientRect();
        const fx = pinch.cx - r.left + stage.scrollLeft;
        const fy = pinch.cy - r.top + stage.scrollTop;
        setZoom(st.zoom * s, { fx, fy, cx: pinch.cx - r.left, cy: pinch.cy - r.top, s });
        pinch = null;
      }
      return;
    }
    if (drawing) {
      endDraw(drawing);
      drawing = null;
      return;
    }
    if (!start || e.type === "pointercancel") {
      start = null;
      return;
    }
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    const dt = performance.now() - start.t;
    const s0 = start;
    start = null;
    const moved = Math.hypot(dx, dy);
    const canScroll = stage.scrollHeight > stage.clientHeight + 2 || stage.scrollWidth > stage.clientWidth + 2;

    // Vegen links/rechts = omslaan (niet in scroll-stand en niet ingezoomd).
    if (S().swipe && moved > 50 && Math.abs(dx) > Math.abs(dy) * 1.4 && dt < 600 && !canScroll && root().dataset.mode !== "scroll") {
      dx < 0 ? next() : prev();
      return;
    }
    if (moved > 12) {
      if (canScroll) glide();
      return;
    }
    handleTap(e, s0);
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);

  function glide() {
    let { x, y } = vel;
    let last = performance.now();
    const frame = (now) => {
      const dt = now - last;
      last = now;
      stage.scrollLeft += x * dt;
      stage.scrollTop += y * dt;
      x *= Math.pow(0.95, dt / 16);
      y *= Math.pow(0.95, dt / 16);
      if (Math.abs(x) + Math.abs(y) > 0.02) inertia = requestAnimationFrame(frame);
    };
    if (Math.abs(x) + Math.abs(y) > 0.1) inertia = requestAnimationFrame(frame);
  }

  function handleTap(e, s0) {
    const r = stage.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width;
    if (st.tool === "link") return placeLink(e);
    if (st.tool) return; // tekenstand: tikken doet niets extra

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
    if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(lastTap.timer);
      lastTap = null;
      const fxp = e.clientX - r.left + stage.scrollLeft;
      const fyp = e.clientY - r.top + stage.scrollTop;
      const target = st.zoom > 1.01 ? 1 : 2;
      setZoom(target, { fx: fxp, fy: fyp, cx: e.clientX - r.left, cy: e.clientY - r.top, s: target / st.zoom });
      return;
    }
    const timer = setTimeout(() => {
      lastTap = null;
      if (panelOpen()) closePanels();
      else showChrome(!chromeVisible());
    }, 260);
    lastTap = { t: now, x: e.clientX, y: e.clientY, timer };
  }

  stage.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const s = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      setZoom(st.zoom * s, { fx: e.clientX - r.left + stage.scrollLeft, fy: e.clientY - r.top + stage.scrollTop, cx: e.clientX - r.left, cy: e.clientY - r.top, s });
    },
    { passive: false }
  );
}

function setZoom(z, focus) {
  const nz = Math.max(1, Math.min(4, z));
  if (Math.abs(nz - st.zoom) < 0.01) {
    render();
    return;
  }
  const real = nz / st.zoom;
  st.zoom = nz;
  if (focus) {
    const stage = $("#v-stage");
    // Houd het punt onder de vingers op dezelfde plek.
    const pagesRect = $("#v-pages").getBoundingClientRect();
    const sr = stage.getBoundingClientRect();
    const offX = pagesRect.left - sr.left + stage.scrollLeft;
    const offY = pagesRect.top - sr.top + stage.scrollTop;
    zoomScrollTarget = {
      x: Math.max(0, (focus.fx - offX) * real - focus.cx),
      y: Math.max(0, (focus.fy - offY) * real - focus.cy),
    };
  }
  render();
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
  } else if (e.key === "+" || e.key === "=") return setZoom(st.zoom * 1.25);
  else if (e.key === "-") return setZoom(st.zoom / 1.25);
  if (!dir) return;
  e.preventDefault();
  if (S().pedalSwap) dir = -dir;
  dir > 0 ? next() : prev();
});

// ---------- krabbels ----------

function setTool(t) {
  st.tool = t;
  root().classList.toggle("drawing", !!t);
  const bar = $("#v-tools");
  if (!bar) return;
  bar.hidden = !t;
  if (t) {
    showChrome(false);
    renderToolbar();
    if (!S().showNotes) {
      setSetting("showNotes", true);
      render();
    }
  }
}

function renderToolbar() {
  const bar = $("#v-tools");
  const tb = (name, ic, label) =>
    h("button", { type: "button", class: "tbtn" + (st.tool === name ? " active" : ""), title: label, "aria-label": label, onclick: () => { st.tool = name; renderToolbar(); if (name === "text") pickStamp(); }, html: icon(ic) });
  const colors = h(
    "div",
    { class: "tcolors" },
    COLORS.map((c) =>
      h("button", { type: "button", class: "tcolor" + (S().penColor === c ? " active" : ""), style: `--c:${c}`, "aria-label": "Kleur", onclick: () => { setSetting("penColor", c); renderToolbar(); } })
    )
  );
  const widths = h(
    "div",
    { class: "twidths" },
    [2, 3, 6].map((w) =>
      h("button", { type: "button", class: "twidth" + (S().penWidth === w ? " active" : ""), "aria-label": "Dikte", onclick: () => { setSetting("penWidth", w); renderToolbar(); } }, h("i", { style: `height:${w + 1}px` }))
    )
  );
  fill(bar, 
    tb("pen", "pen", "Pen"),
    tb("marker", "marker", "Markeerstift"),
    tb("text", "stamp", "Teken/tekst"),
    tb("eraser", "eraser", "Gum"),
    tb("link", "link", "Sprong maken"),
    h("span", { class: "tsep" }),
    colors,
    widths,
    h("span", { class: "tsep" }),
    h("button", { type: "button", class: "tbtn", title: "Ongedaan maken", "aria-label": "Ongedaan maken", onclick: undo, html: icon("undo") }),
    h("button", { type: "button", class: "tbtn", title: "Pagina wissen", "aria-label": "Pagina wissen", onclick: clearPage, html: icon("trash") }),
    h("button", { type: "button", class: "tbtn done", onclick: () => setTool(null), html: icon("check") + "<span>Klaar</span>" })
  );
  if (st.tool === "text") bar.append(h("span", { class: "tstamp" }, st.stamp));
  if (st.tool === "link") bar.append(h("span", { class: "thint" }, "Tik waar de sprong moet komen"));
}

async function pickStamp() {
  const v = await menu(
    "Kies een teken",
    [...STAMPS.map((s) => ({ label: s, value: s })), { label: "Eigen tekst…", value: "__own" }]
  );
  if (v === "__own") {
    const t = await promptDlg("Tekst", "", { placeholder: "bijv. Solo, 2x, adem" });
    if (t) st.stamp = t;
  } else if (v) st.stamp = v;
  renderToolbar();
}

function pageAt(e) {
  const el = document.elementsFromPoint(e.clientX, e.clientY).find((x) => x.classList && x.classList.contains("v-page"));
  if (!el) return null;
  const r = el._ink.getBoundingClientRect();
  const box = el._box;
  const fx = (e.clientX - r.left) / r.width;
  const fy = (e.clientY - r.top) / r.height;
  return { el, page: +el.dataset.page, x: box.x + fx * box.w, y: box.y + fy * box.h, rect: r };
}

function beginDraw(e) {
  const hit = pageAt(e);
  if (!hit) return null;
  const items = st.ink.get(hit.page) || [];
  st.ink.set(hit.page, items);
  const pageW = hit.rect.width / hit.el._box.w; // css-breedte van hele pagina
  if (st.tool === "text") {
    const it = { t: "text", c: S().penColor, s: 22 / pageW, x: hit.x, y: hit.y, v: st.stamp, b: DYNAMICS.has(st.stamp) };
    items.push(it);
    st.undo.push({ page: hit.page, before: items.slice(0, -1) });
    redrawInk(hit.el, items);
    saveInk(st.song.id, hit.page, items);
    return { done: true, page: hit.page };
  }
  if (st.tool === "eraser") {
    const d = { erase: true, page: hit.page, el: hit.el, items, before: items.slice(), pageW };
    eraseAt(d, hit);
    return d;
  }
  const w = (st.tool === "marker" ? S().penWidth * 5 : S().penWidth) / pageW;
  const it = { t: st.tool, c: st.tool === "marker" ? markerColor(S().penColor) : S().penColor, w, p: [hit.x, hit.y] };
  const before = items.slice();
  items.push(it);
  redrawInk(hit.el, items);
  return { page: hit.page, el: hit.el, it, items, before };
}

function markerColor(c) {
  return c === "#111111" ? "#fde047" : c;
}

function moveDraw(d, e) {
  if (d.done) return;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events) {
    const r = d.el._ink.getBoundingClientRect();
    const box = d.el._box;
    const x = box.x + ((ev.clientX - r.left) / r.width) * box.w;
    const y = box.y + ((ev.clientY - r.top) / r.height) * box.h;
    if (d.erase) eraseAt(d, { x, y });
    else d.it.p.push(+x.toFixed(4), +y.toFixed(4));
  }
  if (!d.erase) redrawInk(d.el, d.items);
}

function eraseAt(d, pt) {
  const i = hitTest(d.items, pt.x, pt.y, 14 / d.pageW, d.el._aspect);
  if (i >= 0) {
    d.items.splice(i, 1);
    redrawInk(d.el, d.items);
  }
}

function endDraw(d) {
  if (d.done) return;
  if (d.erase && d.items.length === d.before.length) return;
  st.undo.push({ page: d.page, before: d.before });
  saveInk(st.song.id, d.page, d.items);
}

function redrawInk(el, items) {
  const c = el._ink;
  drawInk(c.getContext("2d"), items, el._box, c.width, c.height);
  // Cache van halve pagina's e.d. blijft geldig: krabbels zitten los op de laag.
}

async function undo() {
  const u = st.undo.pop();
  if (!u) return toast("Niets om ongedaan te maken");
  st.ink.set(u.page, u.before);
  await saveInk(st.song.id, u.page, u.before);
  render();
}

async function clearPage() {
  const p = st.page;
  const items = st.ink.get(p) || [];
  if (!items.length) return toast("Geen krabbels op deze pagina");
  if (!(await confirmDlg("Krabbels wissen?", `Alle krabbels op pagina ${p} verdwijnen.`, "Wissen", true))) return;
  st.undo.push({ page: p, before: items.slice() });
  st.ink.set(p, []);
  await saveInk(st.song.id, p, []);
  render();
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
  render();
}

async function onLinkTap(i) {
  const ln = st.song.links[i];
  if (!ln) return;
  if (st.tool === "link" || st.tool === "eraser") {
    if (await confirmDlg("Sprong verwijderen?", "", "Verwijderen", true)) {
      st.song.links.splice(i, 1);
      await saveSong(st.song);
      render();
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
    fill(pill, 
      h("button", { type: "button", class: "vbtn", onclick: () => { paused = !paused; draw(); }, html: icon(paused ? "play" : "pause") }),
      h("button", { type: "button", class: "vbtn", onclick: () => { setSetting("scrollSpeed", Math.max(5, S().scrollSpeed - 5)); draw(); } }, "−"),
      h("span", {}, S().scrollSpeed),
      h("button", { type: "button", class: "vbtn", onclick: () => { setSetting("scrollSpeed", Math.min(200, S().scrollSpeed + 5)); draw(); } }, "+"),
      h("button", { type: "button", class: "vbtn", onclick: stopAutoScroll, html: icon("close") })
    );
  };
  draw();
  const go = () => {
    const stage = $("#v-stage");
    let last = performance.now();
    let acc = 0;
    const frame = (now) => {
      if (!st.autoScroll) return;
      const dt = (now - last) / 1000;
      last = now;
      if (!paused) {
        acc += S().scrollSpeed * dt;
        if (acc >= 1) {
          stage.scrollTop += Math.floor(acc);
          acc -= Math.floor(acc);
        }
        if (stage.scrollTop + stage.clientHeight >= stage.scrollHeight - 2 && st.list && st.listIndex < st.list.songIds.length - 1) {
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
    { label: "Doorlopend scrollen", value: "scroll", icon: icon("vertical"), active: mode === "scroll" },
    { label: "Halve pagina omslaan", value: "half", icon: icon("half"), active: S().halfTurn },
    { label: "Witte randen wegsnijden", value: "crop", icon: icon("crop"), active: S().autoCrop },
    { label: "Nachtstand (wit op zwart)", value: "night", icon: icon("moon"), active: S().nightSheet },
    { label: "Krabbels tonen", value: "notes", icon: icon("pen"), active: S().showNotes },
    { label: "Groter", value: "zin", icon: icon("zoomIn") },
    { label: "Kleiner", value: "zout", icon: icon("zoomOut") },
    { label: "Naar pagina…", value: "goto", icon: icon("right") },
    { label: "Volledig scherm", value: "fs", icon: icon("expand") },
    { label: "Gegevens bewerken", value: "edit", icon: icon("edit") },
  ]);
  if (!v) return;
  if (["single", "double", "scroll"].includes(v)) {
    setSetting("viewMode", v);
    st.zoom = 1;
    st.half = false;
  } else if (v === "half") setSetting("halfTurn", !S().halfTurn);
  else if (v === "crop") {
    setSetting("autoCrop", !S().autoCrop);
    st.cache.clear();
  } else if (v === "night") setSetting("nightSheet", !S().nightSheet);
  else if (v === "notes") setSetting("showNotes", !S().showNotes);
  else if (v === "zin") return setZoom(st.zoom * 1.25);
  else if (v === "zout") return setZoom(st.zoom / 1.25);
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
