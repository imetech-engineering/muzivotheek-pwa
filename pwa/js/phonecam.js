// Tablet-kant van "Scannen met telefoon": QR-code tonen, foto's van de telefoon
// ontvangen en live laten zien, en ze daarna als nummer (of als extra pagina's)
// toevoegen. Zie phonelink.js voor de berichten.

import qrcode from "../vendor/qrcode/qrcode.mjs";
import { h, fill, toast, dialog, confirmDlg } from "./ui.js";
import { icon } from "./icons.js";
import { shrinkImage } from "./imgpdf.js";
import { PREFIX, loadPeer, randomId, scanUrl, peerOptions, peerErrorText, blobToDataUrl } from "./phonelink.js";

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
  const size = n + 8;
  return `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" aria-label="QR-code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

// purpose: "import" (nieuw nummer) of "append" (pagina's achter een nummer).
// onDone(files, {mode, name}) → tekst voor de melding op de telefoon.
export async function scanWithPhone({ purpose = "import", title = "", onDone }) {
  if (!navigator.onLine) return toast("Hiervoor is internet nodig (om de telefoon te vinden)", 3500);

  const pages = []; // {id, name, blob, url, thumb}
  let lastRemoved = null; // {page, index}
  let conn = null;
  let peer = null;
  let closed = false;
  let busy = false;

  const statusText = h("span", {}, "Verbinden…");
  const status = h("div", { class: "pc-status" }, h("i", { class: "pc-dot" }), statusText);
  const qrBox = h("div", { class: "pc-qr" });
  const linkText = h("div", { class: "pc-link" });
  const connectBox = h(
    "div",
    { class: "pc-connect" },
    qrBox,
    h(
      "div",
      { class: "pc-steps" },
      h("p", {}, h("b", {}, "1. "), "Open de camera van je telefoon en richt hem op deze code."),
      h("p", {}, h("b", {}, "2. "), "Tik op de link die verschijnt. Er opent een pagina in Chrome."),
      h("p", {}, h("b", {}, "3. "), "Maak daar foto's. Ze komen meteen hier binnen."),
      linkText
    )
  );
  const grid = h("div", { class: "pc-pages" });
  const addBtn = h("button", { type: "button", class: "btn primary", onclick: () => finish({}) });
  const closeBtn = h("button", { type: "button", class: "btn", onclick: () => close() }, "Sluiten");
  const content = h("div", { class: "pc-wrap" }, status, connectBox, grid, h("div", { class: "pc-btns" }, closeBtn, addBtn));

  const setStatus = (text, kind = "") => {
    statusText.textContent = text;
    status.dataset.kind = kind;
  };

  const send = (msg) => {
    try {
      if (conn && conn.open) conn.send(msg);
    } catch (e) {
      console.error(e);
    }
  };

  const sendState = () => send({ t: "state", pages: pages.map((p) => ({ id: p.id, thumb: p.thumb })) });

  function render() {
    connectBox.hidden = !!(conn && conn.open);
    addBtn.hidden = !pages.length;
    addBtn.disabled = busy;
    addBtn.textContent = purpose === "append" ? `Toevoegen aan nummer (${pages.length})` : `Toevoegen (${pages.length})`;
    if (!pages.length) {
      fill(grid, conn && conn.open ? h("div", { class: "pc-empty" }, icon("camera"), h("span", {}, "Maak een foto met de telefoon")) : null);
      return;
    }
    fill(
      grid,
      pages.map((p, i) =>
        h(
          "div",
          { class: "pc-page" },
          h("img", { src: p.url, alt: `Pagina ${i + 1}` }),
          h("span", { class: "pc-no" }, String(i + 1)),
          h("button", { type: "button", class: "pc-del", "aria-label": "Verwijderen", html: icon("trash"), onclick: () => removePage(p.id) })
        )
      )
    );
  }

  function removePage(id) {
    const i = pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    const [p] = pages.splice(i, 1);
    lastRemoved = { page: p, index: i };
    render();
    sendState();
    toast("Pagina verwijderd", 4000, { label: "Ongedaan maken", run: undoRemove });
  }

  function undoRemove() {
    if (!lastRemoved) return;
    pages.splice(Math.min(lastRemoved.index, pages.length), 0, lastRemoved.page);
    lastRemoved = null;
    render();
    sendState();
  }

  async function addPage(msg) {
    if (pages.some((p) => p.id === msg.id)) return sendState(); // dubbel na opnieuw verbinden
    const blob = new Blob([msg.data], { type: "image/jpeg" });
    let thumb = "";
    try {
      thumb = await blobToDataUrl((await shrinkImage(blob, 240)).blob);
    } catch (e) {}
    pages.push({ id: msg.id, name: msg.name || `scan-${Date.now()}.jpg`, blob, url: URL.createObjectURL(blob), thumb });
    render();
    sendState();
  }

  // Opnieuw bijgesneden op de telefoon: zelfde plek, nieuwe foto.
  async function replacePage(msg) {
    const p = pages.find((x) => x.id === msg.id);
    if (!p) return sendState();
    const blob = new Blob([msg.data], { type: "image/jpeg" });
    try {
      p.thumb = await blobToDataUrl((await shrinkImage(blob, 240)).blob);
    } catch (e) {}
    URL.revokeObjectURL(p.url);
    p.blob = blob;
    p.url = URL.createObjectURL(blob);
    render();
    sendState();
  }

  // Alles toevoegen. opts leeg = de tablet vraagt zelf (één nummer of apart).
  async function finish(opts) {
    if (!pages.length || busy) return;
    busy = true;
    render();
    const files = pages.map((p) => new File([p.blob], p.name, { type: "image/jpeg" }));
    try {
      const text = await onDone(files, opts);
      if (text === null) {
        // Geannuleerd (bijv. naamvraag weggeklikt): foto's blijven staan.
        send({ t: "error", text: "Toevoegen geannuleerd op de tablet" });
        return;
      }
      pages.splice(0).forEach((p) => URL.revokeObjectURL(p.url));
      lastRemoved = null;
      sendState();
      if (purpose === "append") {
        send({ t: "closed", text: text || "Toegevoegd" });
        close(true);
        return;
      }
      send({ t: "added", text: text || "Toegevoegd" });
    } catch (e) {
      console.error(e);
      send({ t: "error", text: "Toevoegen mislukt op de tablet" });
      toast("Toevoegen mislukt", 3000);
    } finally {
      busy = false;
      if (!closed) render();
    }
  }

  function onData(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "page" && msg.data) addPage(msg);
    else if (msg.t === "replace" && msg.data) replacePage(msg);
    else if (msg.t === "remove") removePage(msg.id);
    else if (msg.t === "undo") undoRemove();
    else if (msg.t === "done") finish({ mode: msg.mode || "", name: msg.name ?? null });
  }

  function onConnection(c) {
    if (conn && conn !== c) {
      try {
        conn.close();
      } catch (e) {}
    }
    conn = c;
    c.on("open", () => {
      if (conn !== c) return;
      setStatus("Telefoon verbonden. Maak de foto's op de telefoon.", "ok");
      send({ t: "hello", purpose, title });
      sendState();
      render();
    });
    c.on("data", (m) => conn === c && onData(m));
    c.on("close", () => {
      if (conn !== c || closed) return;
      conn = null;
      setStatus("Telefoon niet meer verbonden. Scan de code opnieuw, of open de pagina op de telefoon weer.", "warn");
      render();
    });
    c.on("error", (e) => console.warn("verbinding", e));
  }

  async function start() {
    let Peer;
    try {
      Peer = await loadPeer();
    } catch (e) {
      setStatus("Kon het onderdeel voor verbinden niet laden. Is er internet?", "err");
      return;
    }
    if (closed) return;
    const id = PREFIX + randomId(14);
    peer = new Peer(id, peerOptions);
    peer.on("open", () => {
      if (closed) return;
      const url = scanUrl(id);
      qrBox.innerHTML = qrSvg(url);
      linkText.textContent = url;
      setStatus("Wachten op telefoon…");
      render();
    });
    peer.on("connection", onConnection);
    let retries = 0;
    peer.on("open", () => (retries = 0));
    peer.on("disconnected", () => {
      // Koppelserver kwijt; een bestaande verbinding met de telefoon blijft gewoon werken.
      if (closed || !peer || peer.destroyed || retries >= 8) return;
      setTimeout(() => !closed && peer.disconnected && !peer.destroyed && peer.reconnect(), 1500 * ++retries);
    });
    peer.on("error", (e) => {
      console.warn("peer", e);
      if (closed) return;
      if (e.type === "unavailable-id") {
        peer.destroy();
        return start();
      }
      if (conn && conn.open) return; // telefoon is al verbonden, niet storen
      setStatus(peerErrorText(e), "err");
    });
  }

  let closeDlg = null;
  async function close(force = false) {
    if (closed) return;
    if (!force && pages.length && !busy) {
      const add = await confirmDlg(
        `${pages.length} ${pages.length === 1 ? "foto" : "foto's"} nog niet toegevoegd`,
        "Wil je ze eerst toevoegen?",
        "Toevoegen"
      );
      if (add) return finish({});
      if (!(await confirmDlg("Weggooien?", "De foto's van de telefoon worden niet bewaard.", "Weggooien", true))) return;
    }
    closed = true;
    send({ t: "closed", text: "Gesloten op de tablet" });
    setTimeout(() => {
      try {
        peer && peer.destroy();
      } catch (e) {}
    }, 300);
    pages.splice(0).forEach((p) => URL.revokeObjectURL(p.url));
    closeDlg && closeDlg(undefined);
  }

  render();
  const p = dialog({ title: purpose === "append" ? `Pagina's scannen: ${title}` : "Scannen met telefoon", content, buttons: [], cls: "pc-dlg" });
  closeDlg = dialog.close;
  // Buiten de pop-up getikt of Esc: niet zomaar alles weggooien.
  p.then(() => {
    if (!closed) {
      // De pop-up is al weg; bij foto's die er nog zijn toch even vragen.
      const keep = pages.length;
      closed = true;
      send({ t: "closed", text: "Gesloten op de tablet" });
      if (keep) {
        const files = pages.map((x) => new File([x.blob], x.name, { type: "image/jpeg" }));
        confirmDlg(`${keep} ${keep === 1 ? "foto" : "foto's"} nog niet toegevoegd`, "Wil je ze toevoegen?", "Toevoegen").then((ok) => {
          if (ok) onDone(files, {});
          pages.splice(0).forEach((x) => URL.revokeObjectURL(x.url));
        });
      }
      setTimeout(() => {
        try {
          peer && peer.destroy();
        } catch (e) {}
      }, 300);
    }
  });
  start();
}
