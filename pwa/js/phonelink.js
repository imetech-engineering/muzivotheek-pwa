// Telefoon als camera: gedeelde hulpjes voor tablet (phonecam.js) en telefoon (scan.js).
//
// Tablet en telefoon praten rechtstreeks met elkaar (WebRTC). Alleen om elkaar te
// vinden gaat er één keer een berichtje via de gratis PeerJS-koppelserver; de foto's
// zelf gaan direct van telefoon naar tablet (zelfde wifi) of via een relay als dat
// niet lukt. Er wordt nergens iets bewaard.
//
// Berichten (JSON, foto's als ArrayBuffer):
//   tablet → telefoon  {t:"hello", purpose:"import"|"append", title}
//                      {t:"state", pages:[{id, thumb}]}      (tablet is de bron van waarheid)
//                      {t:"added", text} | {t:"error", text} | {t:"closed", text}
//   telefoon → tablet  {t:"page", id, name, data}             (JPEG)
//                      {t:"remove", id} | {t:"undo"} | {t:"done", mode, name}

export const PREFIX = "muzi-";
export const BUILD = "__BUILD__"; // wordt bij publiceren vervangen (zie deploy.yml)

let peerPromise = null;

// PeerJS pas laden als de functie gebruikt wordt (scheelt 85 kB bij het opstarten).
export function loadPeer() {
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerPromise) return peerPromise;
  peerPromise = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = new URL("../vendor/peerjs/peerjs.min.js", import.meta.url).href;
    s.onload = () => (window.Peer ? resolve(window.Peer) : reject(new Error("PeerJS niet geladen")));
    s.onerror = () => {
      peerPromise = null;
      reject(new Error("PeerJS niet geladen"));
    };
    document.head.append(s);
  });
  return peerPromise;
}

export function randomId(n = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

// Adres dat de telefoon opent (via de QR-code).
// ?v= = versie van de tablet: een oudere scanpagina ziet zo dat ze moet verversen.
export function scanUrl(id) {
  return new URL(`../scan.html?v=${encodeURIComponent(BUILD)}#${id}`, import.meta.url).href;
}

// Standaard de gratis PeerJS-koppelserver. Eigen server of testserver: zet
// window.MUZI_PEER = {host, port, path, secure} vóór het laden.
export const peerOptions = { debug: 1, ...(window.MUZI_PEER || {}) };

// Foutmelding van PeerJS in gewone taal.
export function peerErrorText(err) {
  const type = err && err.type;
  if (type === "peer-unavailable") return "De tablet is niet meer bereikbaar. Open op de tablet opnieuw Scannen met telefoon.";
  if (type === "browser-incompatible") return "Deze browser kan dit niet. Gebruik Chrome.";
  if (type === "network" || type === "server-error" || type === "socket-error" || type === "socket-closed")
    return "Geen verbinding met de koppelserver. Is er internet?";
  return "Verbinden lukt niet" + (type ? ` (${type})` : "");
}

// Kleine voorbeeldplaatjes als data-URL (om mee te sturen naar de telefoon).
export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
