// Telefoon-kant van "Scannen met telefoon" (scan.html, geopend via de QR-code op de tablet).
// Foto's maken met de gewone camera-app van de telefoon (beste kwaliteit), verkleinen
// en direct naar de tablet sturen. De tablet bewaart ze; deze pagina toont wat de
// tablet heeft (zie phonelink.js).

import { $, h, fill, toast, menu, promptDlg } from "./ui.js";
import { icon } from "./icons.js";
import { isImageFile } from "./imgpdf.js";
import { applyTheme } from "./settings.js";
import { PREFIX, loadPeer, randomId, peerOptions, peerErrorText } from "./phonelink.js";
import { openCamera, cameraSupported } from "./scancam.js";
import { editScan, preloadScanner } from "./scanedit.js";

applyTheme();

const target = decodeURIComponent(location.hash.slice(1)).trim();
const els = {
  status: $("#status"),
  statusText: $("#status span"),
  for: $("#for"),
  shoot: $("#shoot"),
  gallery: $("#gallery"),
  pages: $("#pages"),
  done: $("#done"),
  progress: $("#progress"),
};
els.shoot.innerHTML = icon("camera") + "<span>Foto maken</span>";
els.gallery.innerHTML = icon("image") + "<span>Uit galerij</span>";

const st = {
  peer: null,
  conn: null,
  purpose: "import",
  title: "",
  pages: [], // van de tablet: [{id, thumb}]
  pending: [], // nog onderweg: [{id, name, data, url}]
  tabletClosed: false,
  waitingDone: false,
  fails: 0,
  counter: 0,
  originals: new Map(), // id → {original, settings}: opnieuw bijsnijden
  replacing: new Set(),
};

const connected = () => !!(st.conn && st.conn.open);

function setStatus(text, kind = "") {
  els.statusText.textContent = text;
  els.status.dataset.kind = kind;
}

function render() {
  const on = connected() && !st.tabletClosed;
  els.shoot.disabled = !on;
  els.gallery.disabled = !on;
  const total = st.pages.length + st.pending.length;
  els.done.disabled = !on || !st.pages.length || st.waitingDone;
  els.done.textContent = st.purpose === "append" ? `Klaar, toevoegen aan nummer (${st.pages.length})` : `Klaar, toevoegen op tablet (${st.pages.length})`;
  if (!total) {
    fill(els.pages, on ? h("div", { class: "pc-empty" }, icon("camera"), h("span", {}, "Nog geen foto's")) : null);
    return;
  }
  const tiles = st.pages.map((p, i) =>
    h(
      "div",
      { class: "pc-page" + (st.replacing.has(p.id) ? " sending" : "") },
      h("img", { src: p.thumb || "", alt: `Pagina ${i + 1}`, onclick: () => reedit(p.id) }),
      st.replacing.has(p.id) ? h("span", { class: "pc-sending" }, "Versturen…") : null,
      st.originals.has(p.id) && !st.replacing.has(p.id) ? h("span", { class: "pc-edit", html: icon("crop") }) : null,
      h("span", { class: "pc-no" }, String(i + 1)),
      h("button", { type: "button", class: "pc-del", "aria-label": "Verwijderen", html: icon("trash"), disabled: !on, onclick: () => removePage(p.id) })
    )
  );
  const waiting = st.pending
    .filter((x) => !st.pages.some((p) => p.id === x.id))
    .map((x) => h("div", { class: "pc-page sending" }, h("img", { src: x.url, alt: "" }), h("span", { class: "pc-sending" }, "Versturen…")));
  fill(els.pages, tiles, waiting);
}

function send(msg) {
  try {
    if (connected()) {
      st.conn.send(msg);
      return true;
    }
  } catch (e) {
    console.error(e);
  }
  return false;
}

function removePage(id) {
  if (!send({ t: "remove", id })) return;
  toast("Pagina verwijderd", 4000, { label: "Ongedaan maken", run: () => send({ t: "undo" }) });
}

// Alles wat nog onderweg is (opnieuw) versturen. De tablet negeert dubbele.
function flush() {
  for (const x of st.pending) if (send({ t: "page", id: x.id, name: x.name, data: x.data })) x.sent = true;
}

// Opnieuw bijsnijden/verbeteren (alleen pagina's die in deze sessie gemaakt zijn).
async function reedit(id) {
  const o = st.originals.get(id);
  if (!o || !o.original) return toast("Deze pagina kan hier niet meer aangepast worden. Verwijder hem en maak een nieuwe foto.", 3500);
  const res = await editScan(o.original, o.settings);
  if (!res) return;
  st.originals.set(id, { original: o.original, settings: res.settings });
  const data = await res.blob.arrayBuffer();
  if (!send({ t: "replace", id, data })) return toast("Geen verbinding met de tablet", 3000);
  st.replacing.add(id);
  render();
}

async function addFiles(files) {
  files = files.filter(isImageFile);
  if (!files.length) return;
  for (const f of files) {
    try {
      // Bijsnijden en verbeteren; weggegooid = overslaan.
      const res = await editScan(f);
      if (!res) continue;
      const blob = res.blob;
      const n = ++st.counter;
      const stamp = new Date().toISOString().slice(0, 19).replace("T", " ").replace(/:/g, ".");
      const item = {
        id: randomId(10),
        // "Scan 2026-10-19 21.40.12-1.jpg": zo herkent de app dat het geen titel is (dan OCR).
        name: `Scan ${stamp}-${n}.jpg`,
        data: await blob.arrayBuffer(),
        url: URL.createObjectURL(blob),
      };
      st.pending.push(item);
      if (res.original) st.originals.set(item.id, { original: res.original, settings: res.settings });
      render();
      flush();
    } catch (e) {
      console.error(e);
      toast(`Foto "${f.name}" lukt niet`, 3000);
    }
  }
}

function pick(capture) {
  const input = h("input", { type: "file", accept: "image/*", capture: capture ? "environment" : null, multiple: capture ? null : true, hidden: true });
  input.onchange = () => {
    const files = [...input.files];
    input.remove();
    addFiles(files);
  };
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 120000);
}

els.shoot.addEventListener("click", () => {
  // Camera in de pagina: Chrome blijft actief. Geen camera-toegang? Dan de camera-app.
  if (!cameraSupported()) return pick(true);
  openCamera((blob) => addFiles([new File([blob], "camera.jpg", { type: blob.type || "image/jpeg" })]), {
    counter: () => (st.pages.length ? `${st.pages.length} op de tablet` : ""),
  });
});
els.gallery.addEventListener("click", () => pick(false));

els.done.addEventListener("click", async () => {
  if (!st.pages.length) return toast("Maak eerst een foto");
  if (st.pending.some((x) => !st.pages.some((p) => p.id === x.id))) return toast("Even wachten, er wordt nog een foto verstuurd", 2500);
  let mode = "";
  let name = null;
  if (st.purpose === "import" && st.pages.length > 1) {
    mode = await menu(`${st.pages.length} foto's`, [
      { label: "Eén nummer (meerdere pagina's)", value: "one", icon: icon("copy") },
      { label: "Elke foto apart", value: "each", icon: icon("grid") },
    ]);
    if (!mode) return;
    if (mode === "one") {
      name = await promptDlg("Naam van het nummer", "", { placeholder: "Leeg = automatisch herkennen" });
      if (name == null) return;
    }
  }
  if (!send({ t: "done", mode, name })) return toast("Geen verbinding met de tablet", 3000);
  st.waitingDone = true;
  progress("Toevoegen op de tablet…");
  render();
});

function progress(text) {
  els.progress.hidden = !text;
  if (text) {
    els.progress.querySelector("span").textContent = text;
    els.progress.querySelector("i").style.width = "60%";
  }
}

function endWait() {
  st.waitingDone = false;
  progress("");
}

function onData(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.t === "hello") {
    st.purpose = msg.purpose === "append" ? "append" : "import";
    st.title = msg.title || "";
    els.for.hidden = st.purpose !== "append";
    els.for.textContent = st.purpose === "append" ? `Pagina's toevoegen aan "${st.title}"` : "";
  } else if (msg.t === "state") {
    st.pages = Array.isArray(msg.pages) ? msg.pages : [];
    st.replacing.clear();
    // Wat de tablet heeft, hoeft niet meer verstuurd te worden.
    st.pending = st.pending.filter((x) => {
      const got = st.pages.some((p) => p.id === x.id);
      if (got) URL.revokeObjectURL(x.url);
      return !got;
    });
  } else if (msg.t === "added") {
    endWait();
    toast(`Op de tablet: ${msg.text}`, 3500);
    setStatus("Klaar voor het volgende nummer.", "ok");
  } else if (msg.t === "error") {
    endWait();
    toast(msg.text || "Er ging iets mis op de tablet", 3500);
  } else if (msg.t === "closed") {
    endWait();
    st.tabletClosed = true;
    setStatus(`${msg.text || "Gesloten op de tablet"}. Je kunt deze pagina sluiten.`, msg.text && /toegevoegd/i.test(msg.text) ? "ok" : "warn");
    try {
      st.conn && st.conn.close();
    } catch (e) {}
  }
  render();
}

function connect() {
  if (st.tabletClosed || !st.peer || st.peer.destroyed) return;
  if (st.peer.disconnected) st.peer.reconnect();
  const c = st.peer.connect(target, { reliable: true, serialization: "binary" });
  st.conn = c;
  c.on("open", () => {
    if (st.conn !== c) return;
    st.fails = 0;
    setStatus("Verbonden met de tablet.", "ok");
    flush();
    render();
  });
  c.on("data", (m) => st.conn === c && onData(m));
  c.on("close", () => {
    if (st.conn !== c) return;
    st.conn = null;
    render();
    if (st.tabletClosed) return;
    setStatus("Verbinding kwijt, opnieuw verbinden…", "warn");
    setTimeout(connect, 2000);
  });
  c.on("error", (e) => console.warn("verbinding", e));
}

async function start() {
  if (!target.startsWith(PREFIX)) {
    setStatus("Open deze pagina via de QR-code op de tablet (Muziek toevoegen → Scannen met telefoon).", "err");
    return;
  }
  let Peer;
  try {
    Peer = await loadPeer();
  } catch (e) {
    setStatus("Laden mislukt. Is er internet?", "err");
    return;
  }
  st.peer = new Peer(peerOptions);
  st.peer.on("open", () => {
    if (!st.conn) connect();
  });
  st.peer.on("error", (e) => {
    console.warn("peer", e);
    if (st.tabletClosed) return;
    if (e.type === "peer-unavailable") {
      // Tablet even weg (scherm uit?). Een paar keer opnieuw proberen.
      if (++st.fails <= 5) {
        setStatus("Tablet nog niet gevonden, opnieuw proberen…", "warn");
        setTimeout(connect, 3000);
        return;
      }
    }
    setStatus(peerErrorText(e), "err");
    render();
  });
  let retries = 0;
  st.peer.on("disconnected", () => {
    if (st.tabletClosed || !st.peer || st.peer.destroyed || retries >= 8) return;
    setTimeout(() => st.peer.disconnected && !st.peer.destroyed && st.peer.reconnect(), 1500 * ++retries);
  });
}

// Terug van de camera-app of het scherm weer aan: verbinding nog goed?
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || st.tabletClosed || connected() || !st.peer) return;
  st.fails = 0;
  connect();
});

window.addEventListener("hashchange", () => location.reload());

render();
start();
preloadScanner();
