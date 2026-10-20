// Scannen op de telefoon (scan.html), zoals een scan-app. editScan:
//   review: na een nieuwe foto. Blad wordt zelf gezocht, rechtgetrokken en verbeterd;
//     zelfde scherm als aanpassen. Klaar of terug = gebruiken, prullenbak = weggooien.
//   anders: een verstuurde pagina achteraf aanpassen.
// In beide: inzoomen, hoeken verslepen (met vergrootglas), draaien, filter kiezen,
// krom blad rechttrekken. Instellingen: {quad, mode, rot, curve}.

import { h, toast } from "./ui.js";
import { icon } from "./icons.js";
import { decodeImage } from "./imgpdf.js";
import { loadCv, detectQuad, warp, dewarp, enhance, matToCanvas, fullQuad } from "./docscan.js";

const MODES = [
  ["bw", "Zwart-wit"],
  ["gray", "Grijs"],
];
const PREFS_KEY = "muzivotheek.scanPrefs";
const DEFAULTS = { mode: "bw", level: 0, speck: true, curve: false };

// Laatste keuzes (filter, schuifje, spikkels, krom blad) gelden voor de volgende foto.
function prefs() {
  let p = {};
  try {
    p = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch (e) {}
  return clean({ ...DEFAULTS, ...p });
}

function clean(p) {
  return {
    mode: MODES.some(([v]) => v === p.mode) ? p.mode : "bw",
    level: Math.max(-5, Math.min(5, Math.round(+p.level || 0))),
    speck: p.speck !== false,
    curve: !!p.curve,
  };
}

function savePrefs(s) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(clean(s)));
  } catch (e) {}
}

// Begin alvast met laden, dan is de scanner klaar als de eerste foto er is.
export function preloadScanner() {
  return loadCv().catch(() => null);
}

const toBlob = (canvas, q = 0.88) => new Promise((r) => canvas.toBlob(r, "image/jpeg", q));
const quality = (s) => (s && s.mode === "bw" ? 0.85 : 0.88);

// Foto openen als canvas (hooguit 2600 px) plus een kleine (900 px) om in te zoeken.
async function openPhoto(source) {
  const bmp = await decodeImage(source, 2600);
  const full = document.createElement("canvas");
  full.width = bmp.width;
  full.height = bmp.height;
  full.getContext("2d").drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  const small = document.createElement("canvas");
  const k = Math.min(1, 900 / Math.max(full.width, full.height));
  small.width = Math.round(full.width * k);
  small.height = Math.round(full.height * k);
  small.getContext("2d").drawImage(full, 0, 0, small.width, small.height);
  return { full, small };
}

// Rechtgetrokken (en eventueel krom-gecorrigeerd) blad, onthouden zolang hoeken
// en kromming gelijk blijven: filters en draaien zijn dan snel.
function makePipeline(cv, full) {
  let key = "";
  let mat = null;
  let curveFailed = false;
  return {
    get curveFailed() {
      return curveFailed;
    },
    render(s, canvas) {
      const k = JSON.stringify([s.quad, !!s.curve]);
      if (!mat || key !== k) {
        if (mat) mat.delete();
        mat = warp(cv, full, s.quad);
        curveFailed = false;
        if (s.curve) {
          try {
            const d = dewarp(cv, mat);
            if (d) {
              mat.delete();
              mat = d;
            } else curveFailed = true;
          } catch (e) {
            console.error(e);
            curveFailed = true;
          }
        }
        key = k;
      }
      const m = enhance(cv, mat, s.mode, { level: s.level, speck: s.speck });
      try {
        return matToCanvas(cv, m, s.rot, canvas);
      } finally {
        m.delete();
      }
    },
    free() {
      try {
        if (mat && !mat.isDeleted()) mat.delete();
      } catch (e) {}
      mat = null;
    },
  };
}

// Inzoomen in het resultaat: knijpen, twee vingers of één vinger schuiven, dubbeltik.
function zoomable(stage, el) {
  let z = 1;
  let tx = 0;
  let ty = 0;
  const pts = new Map();
  let g = null;
  let lastTap = 0;
  const apply = () => (el.style.transform = z === 1 && !tx && !ty ? "" : `translate(${tx}px, ${ty}px) scale(${z})`);
  // Positie van het element zonder zoom (transform-origin linksboven).
  const base = () => {
    const r = el.getBoundingClientRect();
    return { x: r.left - tx, y: r.top - ty, w: r.width / z, h: r.height / z };
  };
  const clamp = (b) => {
    const s = stage.getBoundingClientRect();
    const fit = (t, bp, size, sp, ss) => {
      const w = size * z;
      if (w <= ss) return sp + (ss - w) / 2 - bp; // kleiner dan het scherm: midden
      return Math.min(sp - bp, Math.max(sp + ss - bp - w, t));
    };
    tx = fit(tx, b.x, b.w, s.left, s.width);
    ty = fit(ty, b.y, b.h, s.top, s.height);
  };
  const zoomTo = (nz, cx, cy, b = base()) => {
    nz = Math.max(1, Math.min(6, nz));
    const px = (cx - b.x - tx) / z;
    const py = (cy - b.y - ty) / z;
    z = nz;
    tx = cx - b.x - z * px;
    ty = cy - b.y - z * py;
    if (z === 1) tx = ty = 0;
    else clamp(b);
    apply();
  };
  stage.addEventListener("pointerdown", (e) => {
    if (el.hidden) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    const b = base();
    if (pts.size === 2) {
      const [a, c] = [...pts.values()];
      g = { pinch: true, d0: Math.hypot(a.x - c.x, a.y - c.y), z0: z, m0: { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }, t0: { x: tx, y: ty }, b };
    } else if (pts.size === 1) {
      g = { pinch: false, s: { x: e.clientX, y: e.clientY }, t0: { x: tx, y: ty }, b, moved: false };
    }
  });
  stage.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId) || !g) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pinch && pts.size >= 2) {
      const [a, c] = [...pts.values()];
      const m = { x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 };
      const nz = Math.max(1, Math.min(6, (g.z0 * Math.hypot(a.x - c.x, a.y - c.y)) / g.d0));
      const px = (g.m0.x - g.b.x - g.t0.x) / g.z0;
      const py = (g.m0.y - g.b.y - g.t0.y) / g.z0;
      z = nz;
      tx = m.x - g.b.x - z * px;
      ty = m.y - g.b.y - z * py;
      clamp(g.b);
      apply();
    } else if (!g.pinch) {
      const dx = e.clientX - g.s.x;
      const dy = e.clientY - g.s.y;
      if (Math.hypot(dx, dy) > 6) g.moved = true;
      if (z > 1) {
        tx = g.t0.x + dx;
        ty = g.t0.y + dy;
        clamp(g.b);
        apply();
      }
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (g && !g.pinch && !g.moved && e.type === "pointerup") {
      const now = Date.now();
      if (now - lastTap < 320) {
        zoomTo(z > 1.2 ? 1 : 2.5, e.clientX, e.clientY);
        lastTap = 0;
      } else lastTap = now;
    }
    if (pts.size === 1) {
      const [p] = [...pts.values()];
      g = { pinch: false, s: p, t0: { x: tx, y: ty }, b: base(), moved: true };
    } else if (!pts.size) g = null;
  };
  stage.addEventListener("pointerup", up);
  stage.addEventListener("pointercancel", up);
  return {
    reset() {
      z = 1;
      tx = ty = 0;
      apply();
    },
  };
}

// source = foto, prev = instellingen (bij aanpassen).
// → {blob, original, settings}, {remove: true}, {retake: true}, of null
//   (review: weggegooid; aanpassen: niets veranderd).
export function editScan(source, prev = null, { title: titleText = "Aanpassen", review = false, retake = true } = {}) {
  return new Promise(async (resolve) => {
    let cv = null;
    let full = null;
    let small = null;
    let pipe = null;
    const s = {
      quad: prev && prev.quad ? prev.quad.map((p) => ({ ...p })) : null,
      rot: (prev && prev.rot) || 0,
      ...clean({ ...prefs(), ...(prev || {}) }),
    };
    const startKey = prev && prev.quad ? JSON.stringify(s) : "";
    let auto = null; // automatisch gevonden hoeken
    let step = 2;
    let fromResult = false; // hoeken geopend vanuit het resultaat: terug = terug naar resultaat
    let done = false;

    // ---------- opbouw ----------
    const title = h("div", { class: "se-title" }, titleText);
    const closeBtn = h("button", { type: "button", class: "se-x", "aria-label": review ? "Terug" : "Terug zonder wijzigen", html: icon("back") });
    const delBtn = h("button", { type: "button", class: "se-x", "aria-label": "Pagina verwijderen", html: icon("trash") });
    const busy = h("div", { class: "se-busy" }, h("i"), h("span", {}, "Scanner laden…"));
    const view = h("canvas", { class: "se-img" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "se-svg");
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("class", "se-poly");
    svg.append(poly);
    const handles = [0, 1, 2, 3].map((i) => {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("class", "se-handle");
      c.dataset.i = i;
      svg.append(c);
      return c;
    });
    const frame = h("div", { class: "se-frame" }, view, svg);
    const result = h("canvas", { class: "se-result" });
    const loupe = h("canvas", { class: "se-loupe", width: 240, height: 240, hidden: true });
    const hint = h("div", { class: "se-hint" }, "Knijp of tik twee keer om in te zoomen");
    const stage = h("div", { class: "se-stage" }, frame, result, loupe, hint, busy);

    const autoBtn = h("button", { type: "button", class: "btn se-btn" });
    const cornersDone = h("button", { type: "button", class: "btn primary se-btn" }, "Klaar");
    const bar1 = h("div", { class: "se-bar" }, autoBtn, cornersDone);

    const modeBtns = MODES.map(([v, label]) => h("button", { type: "button", class: "se-mode", dataset: { mode: v } }, label));
    const rotL = h("button", { type: "button", class: "se-rot", "aria-label": "Linksom draaien", html: icon("turnL") });
    const rotR = h("button", { type: "button", class: "se-rot", "aria-label": "Rechtsom draaien", html: icon("turnR") });
    const modesRow = h("div", { class: "se-modes" }, rotL, modeBtns, rotR);
    // Schuifje: links schoner (minder spikkels, lichter), rechts meer details (donkerder).
    const slider = h("input", { type: "range", class: "se-range", min: -5, max: 5, step: 1, "aria-label": "Schoner of meer details" });
    const levelRow = h(
      "div",
      { class: "se-level" },
      h("span", {}, "Schoner"),
      slider,
      h("span", {}, "Meer details")
    );
    const chip = (label) => h("button", { type: "button", class: "se-chip", "aria-pressed": "false", html: `<i></i><span>${label}</span>` });
    const speckBtn = chip("Spikkels weg");
    const curveBtn = chip("Krom blad");
    const curveRow = h("div", { class: "se-extra" }, speckBtn, curveBtn);
    const cornersBtn = h("button", { type: "button", class: "btn se-btn", html: icon("crop") + "<span>Hoeken</span>" });
    const retakeBtn = h("button", { type: "button", class: "btn se-btn", html: icon("camera") + "<span>Opnieuw</span>" });
    if (!retake) retakeBtn.style.display = "none";
    const okBtn = h("button", { type: "button", class: "btn primary se-btn" }, "Klaar");
    const bar2 = h("div", { class: "se-bar" }, cornersBtn, retakeBtn, okBtn);

    const root = h("div", { class: "se" }, h("div", { class: "se-top" }, closeBtn, title, delBtn), stage, modesRow, levelRow, curveRow, bar1, bar2);
    document.body.append(root);
    document.body.classList.add("cam-open");
    const zoom = zoomable(stage, result);

    const setBusy = (text) => {
      busy.hidden = !text;
      if (text) busy.querySelector("span").textContent = text;
    };
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

    function finish(value) {
      if (done) return;
      done = true;
      if (pipe) pipe.free();
      for (const c of [full, small, view, result, loupe]) if (c) c.width = c.height = 0;
      root.remove();
      document.getElementById("toast")?.classList.remove("show");
      if (!document.querySelector(".cam")) document.body.classList.remove("cam-open");
      window.removeEventListener("resize", layout);
      resolve(value);
    }

    // ---------- hoeken ----------
    function layout() {
      if (!small) return;
      const r = stage.getBoundingClientRect();
      const pad = 22;
      const k = Math.min((r.width - pad * 2) / small.width, (r.height - pad * 2) / small.height);
      frame.style.width = Math.round(small.width * k) + "px";
      frame.style.height = Math.round(small.height * k) + "px";
      // Hoekpunten 14 schermpixels groot, lijnen 2,5 px, ongeacht de fotogrootte.
      handles.forEach((c) => c.setAttribute("r", (14 / k).toFixed(2)));
      svg.style.setProperty("--sw", (2.5 / k).toFixed(2));
    }

    function drawQuad() {
      if (!small || !s.quad) return;
      const W = small.width;
      const H = small.height;
      poly.setAttribute("points", s.quad.map((p) => `${p.x * W},${p.y * H}`).join(" "));
      s.quad.forEach((p, i) => {
        handles[i].setAttribute("cx", p.x * W);
        handles[i].setAttribute("cy", p.y * H);
      });
      const isFull = s.quad.every((p, i) => Math.abs(p.x - fullQuad()[i].x) < 0.002 && Math.abs(p.y - fullQuad()[i].y) < 0.002);
      autoBtn.innerHTML = isFull && auto ? icon("crop") + "<span>Automatisch</span>" : icon("expand") + "<span>Hele foto</span>";
      autoBtn.dataset.to = isFull && auto ? "auto" : "full";
    }

    function showLoupe(p, clientX) {
      const ctx = loupe.getContext("2d");
      const zoomSrc = Math.max(full.width, full.height) * 0.07;
      const sx = p.x * full.width - zoomSrc / 2;
      const sy = p.y * full.height - zoomSrc / 2;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, 240, 240);
      ctx.drawImage(full, sx, sy, zoomSrc, zoomSrc, 0, 0, 240, 240);
      ctx.strokeStyle = "#ff3d8b";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(120, 96);
      ctx.lineTo(120, 144);
      ctx.moveTo(96, 120);
      ctx.lineTo(144, 120);
      ctx.stroke();
      const r = stage.getBoundingClientRect();
      loupe.classList.toggle("right", clientX < r.left + r.width / 2);
      loupe.hidden = false;
    }

    let drag = -1;
    svg.addEventListener("pointerdown", (e) => {
      if (step !== 1) return;
      // Dichtstbijzijnde hoek pakken (ruime vingermarge).
      const r = frame.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width;
      const fy = (e.clientY - r.top) / r.height;
      let best = -1;
      let bd = Infinity;
      s.quad.forEach((p, i) => {
        const d = Math.hypot((p.x - fx) * r.width, (p.y - fy) * r.height);
        if (d < bd) {
          bd = d;
          best = i;
        }
      });
      if (bd > 70) return;
      drag = best;
      svg.setPointerCapture(e.pointerId);
      handles[drag].classList.add("on");
      showLoupe(s.quad[drag], e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });
    svg.addEventListener("pointermove", (e) => {
      if (drag < 0) return;
      const r = frame.getBoundingClientRect();
      s.quad[drag] = {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
      drawQuad();
      showLoupe(s.quad[drag], e.clientX);
    });
    const endDrag = () => {
      if (drag >= 0) handles[drag].classList.remove("on");
      drag = -1;
      loupe.hidden = true;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    autoBtn.addEventListener("click", () => {
      s.quad = autoBtn.dataset.to === "auto" && auto ? auto.map((p) => ({ ...p })) : fullQuad();
      drawQuad();
    });

    // ---------- resultaat ----------
    function updateControls() {
      modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === s.mode));
      slider.value = s.level;
      for (const [btn, on] of [
        [speckBtn, s.speck],
        [curveBtn, s.curve],
      ]) {
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
      speckBtn.hidden = s.mode !== "bw"; // grijs heeft geen losse spikkels
    }

    // quiet: zonder wachtscherm en zonder zoom te resetten (schuifje).
    async function renderResult(quiet = false) {
      updateControls();
      if (!quiet) {
        setBusy(s.curve ? "Rechttrekken…" : "Verbeteren…");
        await tick();
      }
      try {
        const w = result.width;
        const hh = result.height;
        pipe.render(s, result);
        if (!quiet || result.width !== w || result.height !== hh) zoom.reset();
        if (!quiet && s.curve && pipe.curveFailed) toast("Geen kromming gevonden (te weinig notenbalken of al recht)", 3000);
      } catch (e) {
        console.error(e);
        toast("Verbeteren lukt niet", 3000);
      }
      if (!quiet) setBusy("");
    }

    // Schuifje: meteen zien, maar niet vaker rekenen dan de telefoon aankan.
    let sliding = false;
    let again = false;
    async function renderSoon() {
      if (sliding) return (again = true);
      sliding = true;
      do {
        again = false;
        await tick();
        await renderResult(true);
      } while (again && !done);
      sliding = false;
    }

    function setStep(n) {
      step = n;
      title.textContent = n === 1 ? "Hoeken" : titleText;
      frame.hidden = n !== 1;
      result.hidden = n !== 2;
      hint.hidden = n !== 2;
      bar1.hidden = n !== 1;
      bar2.hidden = n !== 2;
      modesRow.hidden = n !== 2;
      levelRow.hidden = n !== 2;
      curveRow.hidden = n !== 2;
      delBtn.style.visibility = n === 2 ? "" : "hidden";
      if (n === 1) {
        layout();
        drawQuad();
      } else renderResult();
    }

    cornersBtn.addEventListener("click", () => {
      fromResult = true;
      setStep(1);
    });
    cornersDone.addEventListener("click", () => setStep(2));
    modeBtns.forEach((b) =>
      b.addEventListener("click", () => {
        s.mode = b.dataset.mode;
        savePrefs(s);
        renderResult();
      })
    );
    slider.addEventListener("input", () => {
      s.level = +slider.value;
      renderSoon();
    });
    slider.addEventListener("change", () => savePrefs(s));
    // Het schuifje mag het resultaat niet laten schuiven of zoomen.
    levelRow.addEventListener("pointerdown", (e) => e.stopPropagation());
    speckBtn.addEventListener("click", () => {
      s.speck = !s.speck;
      savePrefs(s);
      renderResult(true);
    });
    curveBtn.addEventListener("click", () => {
      s.curve = !s.curve;
      savePrefs(s);
      renderResult();
    });
    rotL.addEventListener("click", () => {
      s.rot = (s.rot + 270) % 360;
      renderResult();
    });
    rotR.addEventListener("click", () => {
      s.rot = (s.rot + 90) % 360;
      renderResult();
    });
    async function save() {
      if (!review && startKey && JSON.stringify(s) === startKey) return finish(null); // niets veranderd
      setBusy("Opslaan…");
      await tick();
      const blob = await toBlob(result, quality(s));
      if (!blob) {
        setBusy("");
        return toast("Opslaan mislukt", 3000);
      }
      // Verkleinde foto bewaren, om later opnieuw te kunnen bijsnijden.
      const original = !review && source instanceof Blob ? source : await toBlob(full, 0.88);
      finish({ blob, original, settings: { ...s, quad: s.quad.map((p) => ({ ...p })) } });
    }
    okBtn.addEventListener("click", save);
    retakeBtn.addEventListener("click", () => finish({ retake: true }));
    delBtn.addEventListener("click", () => finish({ remove: true }));
    // Terug: bij een nieuwe foto gewoon gebruiken zoals hij is (net als Klaar).
    closeBtn.addEventListener("click", () => (step === 1 && fromResult ? setStep(2) : review ? (step === 2 ? save() : setStep(2)) : finish(null)));
    window.addEventListener("resize", layout);

    // ---------- starten ----------
    for (const el of [frame, result, hint, bar1, bar2, modesRow, levelRow, curveRow]) el.hidden = true;
    setBusy("Foto openen…");
    try {
      ({ full, small } = await openPhoto(source));
      view.width = small.width;
      view.height = small.height;
      view.getContext("2d").drawImage(small, 0, 0);
      svg.setAttribute("viewBox", `0 0 ${small.width} ${small.height}`);
    } catch (e) {
      console.error(e);
      toast("Deze foto kan niet geopend worden", 3500);
      return finish(null);
    }
    setBusy("Scanner laden…");
    try {
      cv = await loadCv();
    } catch (e) {
      console.error(e);
      if (review) {
        // Zonder scanner: de foto zoals hij is (verkleind) versturen.
        toast("Scanner niet geladen (internet?). Foto gaat zonder verbetering.", 4000);
        return finish({ blob: await toBlob(full, 0.9), original: null, settings: null });
      }
      toast("Scanner niet geladen (internet?)", 3500);
      return finish(null);
    }
    if (done) return;
    pipe = makePipeline(cv, full);
    setBusy("Blad zoeken…");
    await tick();
    try {
      auto = detectQuad(cv, small);
    } catch (e) {
      console.error(e);
    }
    if (!s.quad) s.quad = auto ? auto.map((p) => ({ ...p })) : fullQuad();
    setBusy("");
    // Geen blad gevonden: meteen naar de hoeken.
    const ok = review ? !!auto : prev && prev.quad && prev.found !== false;
    fromResult = false;
    setStep(ok ? 2 : 1);
    if (step === 1 && !auto) toast("Blad niet gevonden. Sleep de hoeken naar de hoeken van het blad.", 3500);
  });
}
