// Updates: de app controleert zelf op een nieuwe versie (bij openen, bij
// terugkeren naar de app en elk half uur). Is er een, dan verschijnt onderin
// "Nieuwe versie beschikbaar" met een knop. Tijdens het spelen (lezer open)
// wachten we tot je de lezer sluit: nooit midden in een stuk herladen.

import { h } from "./ui.js";
import { viewerOpen } from "./viewer.js";

export const BUILD = "__BUILD__"; // wordt bij publiceren vervangen door de commit

let reg = null;
let waiting = null;
let reloading = false;
let requested = false; // alleen herladen als jij op Bijwerken tikte

export function initUpdates() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker
    .register("./service-worker.js", { updateViaCache: "none" })
    .then((r) => {
      reg = r;
      if (r.waiting && navigator.serviceWorker.controller) found(r.waiting);
      r.addEventListener("updatefound", () => {
        const nw = r.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          // Alleen melden als er al een versie draaide (niet bij eerste installatie).
          if (nw.state === "installed" && navigator.serviceWorker.controller) found(nw);
        });
      });
    })
    .catch(() => {});

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading || !requested) return;
    reloading = true;
    location.replace(location.href.split("#")[0].split("?")[0]);
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") check();
  });
  setInterval(check, 30 * 60 * 1000);
  document.addEventListener("viewer-closed", () => waiting && showBanner());
}

// Handmatig of periodiek: vraag de server of er een nieuwe versie is.
export async function check() {
  if (!reg || !navigator.onLine) return "offline";
  try {
    await reg.update();
  } catch (e) {
    return "offline";
  }
  // Na update() kan het even duren voor de nieuwe versie geïnstalleerd is.
  if (reg.installing) {
    await new Promise((res) => {
      const nw = reg.installing;
      nw.addEventListener("statechange", () => nw.state !== "installing" && res());
      setTimeout(res, 15000);
    });
  }
  return reg.waiting ? "new" : "current";
}

function found(worker) {
  waiting = worker;
  if (!viewerOpen()) showBanner();
}

export function applyUpdate() {
  requested = true;
  if (!waiting) return location.reload();
  waiting.postMessage({ type: "SKIP_WAITING" });
  // Val terug op herladen als de wissel om wat voor reden ook niet komt.
  setTimeout(() => !reloading && location.reload(), 3000);
}

function showBanner() {
  if (document.getElementById("update-bar")) return;
  const bar = h(
    "div",
    { id: "update-bar", class: "update-bar", role: "status" },
    h("span", {}, "Nieuwe versie beschikbaar"),
    h("button", { type: "button", class: "btn later", onclick: () => bar.remove() }, "Later"),
    h("button", { type: "button", class: "btn primary", onclick: () => { bar.querySelector(".primary").textContent = "Bezig…"; applyUpdate(); } }, "Bijwerken")
  );
  document.body.append(bar);
  requestAnimationFrame(() => bar.classList.add("show"));
}

export const updateReady = () => !!waiting;
