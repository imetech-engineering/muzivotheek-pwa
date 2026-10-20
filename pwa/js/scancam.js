// Camera in de pagina zelf (telefoon, scan.html). Chrome blijft zo op de voorgrond;
// met de losse camera-app kan Android Chrome op de achtergrond afsluiten wegens
// geheugengebrek, en dan is de foto weg.
//
// openCamera(onShot) houdt de camera open; onShot(blob, hint) wordt per foto aangeroepen
// (hint = {quad, aspect}: het live kader op het moment van de foto, of null)
// (en mag een Promise teruggeven, bijv. het verwerken). Klaar = sluiten.
// Opties: single = na één foto dicht (opnieuw maken); thumb() = {url} van de
// laatste scan, linksonder; tikken = onThumb() (camera staat dan even uit).

import { h } from "./ui.js";
import { icon } from "./icons.js";
import { loadCv, detectQuad } from "./docscan.js";

export const cameraSupported = () => !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

const ICON_FLASH = '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';

export function openCamera(onShot, { counter = () => "", single = false, thumb = null, onThumb = null } = {}) {
  return new Promise(async (resolve) => {
    let stream = null;
    let track = null;
    let capture = null;
    let torch = false;
    let busy = false;

    const video = h("video", { class: "cam-video", playsinline: true, muted: true, autoplay: true });
    // Live kader: het gevonden blad in het camerabeeld.
    const overlay = h("canvas", { class: "cam-quad", "aria-hidden": "true" });
    const view = h("div", { class: "cam-view" }, video, overlay);
    const msg = h("div", { class: "cam-msg" }, "Camera starten…");
    const count = h("div", { class: "cam-count" });
    const flashBtn = h("button", { type: "button", class: "cam-side", "aria-label": "Lamp", html: ICON_FLASH, hidden: true });
    const closeBtn = h("button", { type: "button", class: "cam-side", "aria-label": "Klaar", html: icon("close") });
    const shutter = h("button", { type: "button", class: "cam-shutter", "aria-label": "Foto maken", disabled: true });
    const thumbImg = h("img", { alt: "" });
    const thumbBtn = h("button", { type: "button", class: "cam-thumb", "aria-label": "Laatste scan bekijken", hidden: true }, thumbImg);
    const flash = h("div", { class: "cam-flash" });
    const root = h(
      "div",
      { class: "cam" },
      view,
      flash,
      msg,
      
      h("div", { class: "cam-bar" }, closeBtn, shutter, flashBtn),
      thumbBtn,
      count
    );
    document.body.append(root);
    document.body.classList.add("cam-open");

    const updateCount = () => {
      count.textContent = counter() || "";
      const t = thumb && thumb();
      thumbBtn.hidden = !t;
      if (t && thumbImg.src !== t.url) thumbImg.src = t.url;
    };
    updateCount();

    function stop() {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }

    function close() {
      stop();
      clearTimeout(liveTimer);
      root.remove();
      document.body.classList.remove("cam-open");
      document.removeEventListener("visibilitychange", onVis);
      resolve();
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 4096 }, height: { ideal: 3072 } },
        });
      } catch (e) {
        msg.textContent = e && e.name === "NotAllowedError" ? "Geen toegang tot de camera. Sta de camera toe in Chrome (slotje in de adresbalk)." : "Camera starten lukt niet.";
        msg.hidden = false;
        return;
      }
      track = stream.getVideoTracks()[0];
      video.srcObject = stream;
      try {
        await video.play();
      } catch (e) {}
      try {
        if ("ImageCapture" in window) capture = new ImageCapture(track);
      } catch (e) {}
      try {
        const caps = track.getCapabilities ? track.getCapabilities() : {};
        flashBtn.hidden = !caps.torch;
        if (torch && caps.torch) await track.applyConstraints({ advanced: [{ torch: true }] });
      } catch (e) {}
      msg.hidden = true;
      shutter.disabled = false;
    }

    async function grabFrame() {
      // Volle foto (scherpst, met autofocus); anders het videobeeld.
      if (capture) {
        try {
          const blob = await capture.takePhoto();
          if (blob && blob.size) return blob;
        } catch (e) {
          console.warn("takePhoto", e);
        }
      }
      const c = document.createElement("canvas");
      c.width = video.videoWidth;
      c.height = video.videoHeight;
      c.getContext("2d").drawImage(video, 0, 0);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.95));
      c.width = c.height = 0;
      return blob;
    }

    shutter.addEventListener("click", async () => {
      if (busy || !stream) return;
      busy = true;
      shutter.disabled = true;
      flash.classList.remove("go");
      void flash.offsetWidth;
      flash.classList.add("go");
      try {
        // Kader zoals het nu in beeld is: valt terug als de foto zelf geen blad oplevert.
        const hint = quad && video.videoWidth ? { quad: quad.map((p) => ({ ...p })), aspect: video.videoWidth / video.videoHeight } : null;
        const blob = await grabFrame();
        // Camera even uit tijdens het verwerken: scheelt veel geheugen op de telefoon.
        stop();
        const r = blob ? await onShot(blob, hint) : null;
        if (single && blob && r !== "again") return close();
      } catch (e) {
        console.error(e);
      } finally {
        busy = false;
        updateCount();
        if (root.isConnected && !stream && document.visibilityState === "visible") {
          msg.textContent = "Camera starten…";
          msg.hidden = false;
          await start();
        }
      }
    });

    flashBtn.addEventListener("click", async () => {
      torch = !torch;
      flashBtn.classList.toggle("on", torch);
      try {
        await track.applyConstraints({ advanced: [{ torch }] });
      } catch (e) {}
    });

    closeBtn.addEventListener("click", close);

    // ---------- live kader ----------
    let cv = null;
    loadCv()
      .then((c) => (cv = c))
      .catch(() => {});
    const probe = document.createElement("canvas");
    let quad = null;
    let misses = 0;
    let liveTimer = 0;

    function drawOverlay() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const ew = overlay.clientWidth;
      const eh = overlay.clientHeight;
      if (overlay.width !== Math.round(ew * dpr) || overlay.height !== Math.round(eh * dpr)) {
        overlay.width = Math.round(ew * dpr);
        overlay.height = Math.round(eh * dpr);
      }
      const ctx = overlay.getContext("2d");
      ctx.clearRect(0, 0, overlay.width, overlay.height);
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!quad || !vw || !vh) return;
      // Video staat "contain" in zijn vak: zelfde omrekening.
      const k = Math.min(ew / vw, eh / vh);
      const ox = (ew - vw * k) / 2;
      const oy = (eh - vh * k) / 2;
      const pts = quad.map((p) => [(ox + p.x * vw * k) * dpr, (oy + p.y * vh * k) * dpr]);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fillStyle = "rgba(255, 61, 139, 0.18)";
      ctx.fill();
      ctx.lineWidth = 3 * dpr;
      ctx.strokeStyle = "#ff3d8b";
      ctx.lineJoin = "round";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }

    function liveTick() {
      if (!root.isConnected) return;
      if (cv && stream && !busy && video.videoWidth && document.visibilityState === "visible") {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const k = Math.min(1, 360 / Math.max(vw, vh));
        probe.width = Math.round(vw * k);
        probe.height = Math.round(vh * k);
        probe.getContext("2d", { willReadFrequently: true }).drawImage(video, 0, 0, probe.width, probe.height);
        let q = null;
        try {
          q = detectQuad(cv, probe);
        } catch (e) {}
        if (q) {
          misses = 0;
          // Rustig meebewegen i.p.v. springen.
          quad = quad ? quad.map((p, i) => ({ x: p.x + (q[i].x - p.x) * 0.6, y: p.y + (q[i].y - p.y) * 0.6 })) : q;
        } else if (++misses > 2) quad = null;
      } else if (!stream) quad = null;
      drawOverlay();
      liveTimer = setTimeout(liveTick, 250);
    }
    liveTick();

    thumbBtn.addEventListener("click", async () => {
      if (busy || !onThumb) return;
      busy = true;
      stop();
      shutter.disabled = true;
      root.hidden = true;
      try {
        await onThumb();
      } catch (e) {
        console.error(e);
      } finally {
        busy = false;
        root.hidden = false;
        updateCount();
        if (root.isConnected && !stream && document.visibilityState === "visible") {
          msg.textContent = "Camera starten…";
          msg.hidden = false;
          await start();
        }
      }
    });

    // Scherm uit en weer aan: camera opnieuw starten.
    const onVis = () => {
      if (document.visibilityState === "hidden") {
        stop();
        shutter.disabled = true;
      } else if (!stream && root.isConnected) start();
    };
    document.addEventListener("visibilitychange", onVis);

    openCamera.refresh = updateCount;
    start();
  });
}
