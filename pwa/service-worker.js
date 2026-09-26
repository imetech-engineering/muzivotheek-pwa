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
  "./js/sharepoint.js",
  "./js/sp_ui.js",
  "./config.js",
  "./auth.html",
  "./js/ui.js",
  "./js/update.js",
  "./js/viewer.js",
  "./vendor/pdfjs/pdf.min.mjs",
  "./vendor/pdfjs/pdf.worker.min.mjs",
  "./vendor/fonts/noto-music.woff2",
  "./branding/eendracht.png",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(ASSETS.map((u) => new Request(u, { cache: "reload" }))))
  );
  // Niet meteen overnemen: de app vraagt eerst of je wilt bijwerken.
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
  );
});

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

  if (event.request.method !== "GET" || url.origin !== location.origin) return;

  // Cache eerst (snel en offline); standaardlettertypes van pdf.js worden bij gebruik bewaard.
  event.respondWith(
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
});
