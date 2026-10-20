// Offline: alle app-bestanden in de cache. VERSION wordt bij publiceren
// automatisch vervangen door de commit (zie .github/workflows/deploy.yml),
// dus elke push is een nieuwe versie.
const VERSION = "__BUILD__";
const CACHE = "muzivotheek-" + VERSION;
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/backup.js",
  "./js/db.js",
  "./js/icons.js",
  "./js/ink.js",
  "./js/library.js",
  "./js/metronome.js",
  "./js/pdf.js",
  "./js/settings.js",
  "./js/setlists.js",
  "./js/tuner.js",
  "./js/folders.js",
  "./js/youtube.js",
  "./js/names.js",
  "./js/imgpdf.js",
  "./js/recognize.js",
  "./js/sharepoint.js",
  "./js/sp_ui.js",
  "./config.js",
  "./auth.html",
  "./js/ui.js",
  "./js/update.js",
  "./js/viewer.js",
  "./js/phonecam.js",
  "./js/phonelink.js",
  "./js/scan.js",
  "./js/scancam.js",
  "./js/scanedit.js",
  "./js/docscan.js",
  "./scan.html",
  "./vendor/peerjs/peerjs.min.js",
  "./vendor/qrcode/qrcode.mjs",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
  "./vendor/fonts/noto-music.woff2",
  "./vendor/pdf-lib/pdf-lib.min.js",
  "./branding/eendracht.png",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

const isScanUrl = (u) => new URL(u).pathname.endsWith("/scan.html");

// Alleen scanpagina's open (telefoon die de QR-code scande)? Dan meteen overnemen.
async function onlyScanPages() {
  const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return list.length > 0 && list.every((c) => isScanUrl(c.url));
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
      .then(onlyScanPages)
      .then((only) => only && self.skipWaiting())
  );
  // Anders niet meteen overnemen: de app vraagt eerst of je wilt bijwerken
  // (nooit midden in een stuk).
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("muzivotheek-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .then(async () => {
        // Open scanpagina's meteen de nieuwe versie laten zien.
        const list = await self.clients.matchAll({ type: "window" });
        for (const c of list) if (isScanUrl(c.url) && c.navigate) c.navigate(c.url).catch(() => {});
      })
  );
});

// Scanpagina (telefoon): altijd de nieuwste versie, de cache alleen zonder internet.
// Die pagina wordt vaak maar af en toe geopend (QR-code), en heeft toch internet
// nodig om de tablet te vinden.
async function fromScanPage(event) {
  if (event.request.mode === "navigate") return isScanUrl(event.request.url);
  if (!event.clientId) return false;
  const c = await self.clients.get(event.clientId);
  return !!(c && isScanUrl(c.url));
}

async function networkFirst(request) {
  try {
    const res = await fetch(request, { cache: "no-cache" });
    if (res.ok) return res;
  } catch (e) {}
  const hit = await caches.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Delen vanuit andere apps: bestanden tijdelijk bewaren, daarna de app openen.
  if (event.request.method === "POST" && url.pathname.endsWith("/share-target")) {
    event.respondWith(
      (async () => {
        const form = await event.request.formData();
        const cache = await caches.open("muzi-share");
        let i = 0;
        for (const f of form.getAll("files")) {
          if (!(f instanceof File)) continue;
          await cache.put(
            new Request("./shared/" + Date.now() + "-" + i++),
            new Response(f, { headers: { "content-type": f.type || "application/pdf", "x-name": encodeURIComponent(f.name) } })
          );
        }
        // Geen bestand maar een link (bv. SharePoint-link uit WhatsApp)?
        if (!i) {
          const text = [form.get("url"), form.get("text"), form.get("title")].filter(Boolean).join(" ");
          const link = (text.match(/https?:\/\/[^\s<>"']+/) || [])[0];
          if (link) return Response.redirect("./?link=" + encodeURIComponent(link), 303);
        }
        return Response.redirect("./?shared=1", 303);
      })()
    );
    return;
  }

  // Tekstherkenning (tesseract) van jsDelivr: na de eerste keer uit de cache, dus ook offline.
  // Vaste versie in de URL, dus veilig om te bewaren; overleeft app-updates.
  if (event.request.method === "GET" && url.hostname === "cdn.jsdelivr.net" && /tesseract/.test(url.pathname)) {
    event.respondWith(
      caches.open("muzi-ocr-v1").then(async (c) => {
        const hit = await c.match(event.request);
        if (hit) return hit;
        const res = await fetch(event.request);
        if (res.ok) c.put(event.request, res.clone());
        return res;
      })
    );
    return;
  }

  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  // Cache eerst (snel en offline); standaardlettertypes van pdf.js worden bij gebruik bewaard.
  // Uitzondering: alles voor de scanpagina komt eerst van internet.
  event.respondWith(
    fromScanPage(event).then((scan) =>
      scan && !url.pathname.includes("/vendor/opencv/") ? networkFirst(event.request) : cacheFirst(event, url)
    )
  );
});

function cacheFirst(event, url) {
  return (
    caches.match(event.request, { ignoreSearch: url.pathname.endsWith("/") || url.pathname.endsWith("index.html") }).then(
      (hit) =>
        hit ||
        fetch(event.request).then((res) => {
          if (res.ok && url.pathname.includes("/vendor/")) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(event.request, copy));
          }
          return res;
        })
    )
  );
}
