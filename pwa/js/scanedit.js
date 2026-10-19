// Bijsnij- en verbeterscherm na elke foto (telefoon, scan.html), zoals een scan-app:
//   1. Hoeken: automatisch gezocht, met 4 hoekpunten bij te stellen (met vergrootglas).
//   2. Verbeteren: Zwart-wit / Grijs / Kleur / Origineel, draaien.
// editScan(blob, vorige) → {blob, settings} of null (weggegooid).

import { h, toast } from "./ui.js";
import { icon } from "./icons.js";
import { decodeImage } from "./imgpdf.js";
import { loadCv, detectQuad, warp, enhance, matToCanvas, fullQuad } from "./docscan.js";

const MODES = [
  ["bw", "Zwart-wit"],
  ["gray", "Grijs"],
  ["color", "Kleur"],
  ["orig", "Origineel"],
];
const MODE_KEY = "muzivotheek.scanMode";

function savedMode() {
  try {
    const m = localStorage.getItem(MODE_KEY);
    if (MODES.some(([v]) => v === m)) return m;
  } catch (e) {}
  return "bw";
}

// Begin alvast met laden, dan is de scanner klaar als de eerste foto er is.
export function preloadScanner() {
  return loadCv().catch(() => null);
}

export function editScan(source, prev = null) {
  return new Promise(async (resolve) => {
    let cv = null;
    let full = null; // canvas, max 2600 px
    let small = null; // canvas, max 900 px (zoeken en tonen)
    let quad = prev && prev.quad ? prev.quad.map((p) => ({ ...p })) : null;
    let auto = null; // automatisch gevonden hoeken
    let mode = (prev && prev.mode) || savedMode();
    let rot = (prev && prev.rot) || 0;
    let warped = null; // Mat, hoort bij warpedFor
    let warpedFor = "";
    let step = 1;
    let done = false;

    // ---------- opbouw ----------
    const title = h("div", { class: "se-title" }, "Bijsnijden");
    const closeBtn = h("button", { type: "button", class: "se-x", "aria-label": "Foto weggooien", html: icon("trash") });
    const busy = h("div", { class: "se-busy" }, h("i"), h("span", {}, "Scanner laden…"));
    const view = h("canvas", { class: "se-img" });
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "se-svg");
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("class", "se-poly");
    svg.append(poly);
    const handles = [0, 1, 2, 3].map((i) => {
      const g = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      g.setAttribute("class", "se-handle");
      g.dataset.i = i;
      svg.append(g);
      return g;
    });
    const frame = h("div", { class: "se-frame" }, view, svg);
    const result = h("canvas", { class: "se-result" });
    const loupe = h("canvas", { class: "se-loupe", width: 240, height: 240, hidden: true });
    const stage = h("div", { class: "se-stage" }, frame, result, loupe, busy);

    const autoBtn = h("button", { type: "button", class: "btn se-btn" });
    const nextBtn = h("button", { type: "button", class: "btn primary se-btn" }, "Volgende");
    const bar1 = h("div", { class: "se-bar" }, autoBtn, nextBtn);

    const modeBtns = MODES.map(([v, label]) => h("button", { type: "button", class: "se-mode", dataset: { mode: v } }, label));
    const rotL = h("button", { type: "button", class: "se-rot", "aria-label": "Linksom draaien", html: icon("turnL") });
    const rotR = h("button", { type: "button", class: "se-rot", "aria-label": "Rechtsom draaien", html: icon("turnR") });
    const modesRow = h("div", { class: "se-modes" }, rotL, modeBtns, rotR);
    const backBtn = h("button", { type: "button", class: "btn se-btn" }, "Hoeken");
    const sendBtn = h("button", { type: "button", class: "btn primary se-btn" }, "Versturen");
    const bar2 = h("div", { class: "se-bar" }, backBtn, sendBtn);

    const root = h("div", { class: "se" }, h("div", { class: "se-top" }, closeBtn, title, h("span", { class: "se-sp" })), stage, modesRow, bar1, bar2);
    document.body.append(root);
    document.body.classList.add("cam-open");

    const setBusy = (text) => {
      busy.hidden = !text;
      if (text) busy.querySelector("span").textContent = text;
    };
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

    function finish(value) {
      if (done) return;
      done = true;
      try {
        warped && !warped.isDeleted() && warped.delete();
      } catch (e) {}
      for (const c of [full, small, view, result, loupe]) if (c) c.width = c.height = 0;
      root.remove();
      document.getElementById("toast")?.classList.remove("show");
      if (!document.querySelector(".cam")) document.body.classList.remove("cam-open");
      window.removeEventListener("resize", layout);
      resolve(value);
    }

    // ---------- stap 1: hoeken ----------
    function layout() {
      if (!small) return;
      const r = stage.getBoundingClientRect();
      const pad = 22;
      const k = Math.min((r.width - pad * 2) / small.width, (r.height - pad * 2) / small.height);
      frame.style.width = Math.round(small.width * k) + "px";
      frame.style.height = Math.round(small.height * k) + "px";
      // Hoekpunten 14 schermpixels groot, lijnen 2,5 px, ongeacht de fotogrootte.
      handles.forEach((g) => g.setAttribute("r", (14 / k).toFixed(2)));
      svg.style.setProperty("--sw", (2.5 / k).toFixed(2));
    }

    function drawQuad() {
      if (!small || !quad) return;
      const W = small.width;
      const H = small.height;
      poly.setAttribute("points", quad.map((p) => `${p.x * W},${p.y * H}`).join(" "));
      quad.forEach((p, i) => {
        handles[i].setAttribute("cx", p.x * W);
        handles[i].setAttribute("cy", p.y * H);
      });
      const isFull = quad.every((p, i) => Math.abs(p.x - fullQuad()[i].x) < 0.002 && Math.abs(p.y - fullQuad()[i].y) < 0.002);
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
      quad.forEach((p, i) => {
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
      showLoupe(quad[drag], e.clientX);
      e.preventDefault();
    });
    svg.addEventListener("pointermove", (e) => {
      if (drag < 0) return;
      const r = frame.getBoundingClientRect();
      quad[drag] = {
        x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
        y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
      };
      drawQuad();
      showLoupe(quad[drag], e.clientX);
    });
    const endDrag = () => {
      if (drag >= 0) handles[drag].classList.remove("on");
      drag = -1;
      loupe.hidden = true;
    };
    svg.addEventListener("pointerup", endDrag);
    svg.addEventListener("pointercancel", endDrag);

    autoBtn.addEventListener("click", () => {
      quad = autoBtn.dataset.to === "auto" && auto ? auto.map((p) => ({ ...p })) : fullQuad();
      drawQuad();
    });

    // ---------- stap 2: verbeteren ----------
    async function render2() {
      setBusy("Verbeteren…");
      modeBtns.forEach((b) => b.classList.toggle("on", b.dataset.mode === mode));
      await tick();
      try {
        const key = JSON.stringify(quad);
        if (!warped || warpedFor !== key) {
          if (warped) warped.delete();
          warped = warp(cv, full, quad);
          warpedFor = key;
        }
        const m = enhance(cv, warped, mode);
        matToCanvas(cv, m, rot, result);
        m.delete();
      } catch (e) {
        console.error(e);
        toast("Verbeteren lukt niet, probeer Origineel", 3000);
      }
      setBusy("");
    }

    function setStep(n) {
      step = n;
      title.textContent = n === 1 ? "Bijsnijden" : "Verbeteren";
      frame.hidden = n !== 1;
      result.hidden = n !== 2;
      bar1.hidden = n !== 1;
      bar2.hidden = n !== 2;
      modesRow.hidden = n !== 2;
      if (n === 1) {
        layout();
        drawQuad();
      } else render2();
    }

    nextBtn.addEventListener("click", () => setStep(2));
    backBtn.addEventListener("click", () => setStep(1));
    modeBtns.forEach((b) =>
      b.addEventListener("click", () => {
        mode = b.dataset.mode;
        try {
          localStorage.setItem(MODE_KEY, mode);
        } catch (e) {}
        render2();
      })
    );
    rotL.addEventListener("click", () => {
      rot = (rot + 270) % 360;
      render2();
    });
    rotR.addEventListener("click", () => {
      rot = (rot + 90) % 360;
      render2();
    });
    sendBtn.addEventListener("click", async () => {
      setBusy("Opslaan…");
      await tick();
      const blob = await new Promise((r) => result.toBlob(r, "image/jpeg", mode === "bw" ? 0.85 : 0.88));
      if (!blob) {
        setBusy("");
        return toast("Opslaan mislukt", 3000);
      }
      // Verkleinde originele foto bewaren, om later opnieuw te kunnen bijsnijden.
      const original = await new Promise((r) => full.toBlob(r, "image/jpeg", 0.88));
      finish({ blob, original, settings: { quad, mode, rot } });
    });
    closeBtn.addEventListener("click", () => finish(null));
    window.addEventListener("resize", layout);

    // ---------- starten ----------
    setStep(1);
    frame.hidden = true;
    bar1.hidden = true;
    setBusy("Foto openen…");
    try {
      const bmp = await decodeImage(source, 2600);
      full = document.createElement("canvas");
      full.width = bmp.width;
      full.height = bmp.height;
      full.getContext("2d").drawImage(bmp, 0, 0);
      if (bmp.close) bmp.close();
      small = document.createElement("canvas");
      const k = Math.min(1, 900 / Math.max(full.width, full.height));
      small.width = Math.round(full.width * k);
      small.height = Math.round(full.height * k);
      small.getContext("2d").drawImage(full, 0, 0, small.width, small.height);
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
      // Zonder scanner: de foto zoals hij is (verkleind) versturen.
      toast("Scanner niet geladen (internet?). Foto gaat zonder verbetering.", 4000);
      const blob = await new Promise((r) => full.toBlob(r, "image/jpeg", 0.9));
      return finish({ blob, original: null, settings: null });
    }
    if (done) return;
    setBusy("Blad zoeken…");
    await tick();
    try {
      auto = detectQuad(cv, small);
    } catch (e) {
      console.error(e);
    }
    if (!quad) quad = auto ? auto.map((p) => ({ ...p })) : fullQuad();
    if (!auto && !prev) toast("Geen blad gevonden. Sleep de hoeken naar de hoeken van het blad.", 3500);
    setBusy("");
    setStep(1);
  });
}
