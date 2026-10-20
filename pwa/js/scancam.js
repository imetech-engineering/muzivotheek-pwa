// Camera in de pagina zelf (telefoon, scan.html). Chrome blijft zo op de voorgrond;
// met de losse camera-app kan Android Chrome op de achtergrond afsluiten wegens
// geheugengebrek, en dan is de foto weg.
//
// openCamera(onShot) houdt de camera open; onShot(blob) wordt per foto aangeroepen
// (en mag een Promise teruggeven, bijv. het verwerken). Klaar = sluiten.
// Opties: single = na één foto dicht (opnieuw maken); thumb() = {url} van de
// laatste scan, linksonder; tikken = onThumb() (camera staat dan even uit).

import { h } from "./ui.js";
import { icon } from "./icons.js";

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
      video,
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
        const blob = await grabFrame();
        // Camera even uit tijdens het verwerken: scheelt veel geheugen op de telefoon.
        stop();
        if (blob) await onShot(blob);
        if (single && blob) return close();
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
