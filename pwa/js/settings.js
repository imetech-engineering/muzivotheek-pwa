// Instellingen: per apparaat, in localStorage.

const KEY = "muzivotheek.settings";

export const DEFAULTS = {
  theme: "auto", // auto | light | dark
  sort: "title", // title | composer | added | opened | played
  sortDesc: false,
  libView: "list", // list | grid
  viewMode: "single", // single | double | auto (liggend = twee) | scroll
  autoCrop: true, // witte marges wegsnijden
  nightSheet: false, // bladmuziek inverteren (wit op zwart)
  fullscreen: true,
  keepAwake: true,
  tapZones: true,
  swipe: true,
  tapLeftPrev: true,
  pedalSwap: false,
  halfTurn: false, // eerst een halve pagina omslaan
  halfOrder: "curTop", // curTop: boven = rest van deze pagina, onder = begin volgende | nextTop: andersom
  stampSize: 2, // index in STAMP_SIZES
  showNotes: true,
  pageBadge: true, // paginanummer "3 / 8" in beeld
  pageBadgeSize: 1,
  pageBadgePos: { x: 0.93, y: 0.86 },
  penColor: "#e11d48",
  penWidth: 3,
  scrollSpeed: 30, // pixels per seconde bij auto-scroll
  metroSound: true,
  metroFlash: true,
  metroAccent: true,
  metroBeats: 4,
  tunerRef: 440,
  tunerTranspose: 0, // 0 = C, 2 = Bes, -3 = Es (9), 7 = F
};

let cache = null;

export function settings() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch (e) {}
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

export function setSetting(key, value) {
  settings()[key] = value;
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {}
  document.dispatchEvent(new CustomEvent("settings", { detail: { key, value } }));
}

export function resetSettings() {
  cache = { ...DEFAULTS };
  try {
    localStorage.removeItem(KEY);
  } catch (e) {}
  document.dispatchEvent(new CustomEvent("settings", { detail: {} }));
}

export function applyTheme() {
  const t = settings().theme;
  const dark = t === "dark" || (t === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? "#16171c" : "#465e9e";
}
