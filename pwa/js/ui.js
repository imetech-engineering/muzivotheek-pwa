// Kleine UI-hulpjes: melding, bevestigen, vraag, keuzemenu.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// replaceChildren zonder "null"/"false" als tekst.
export function fill(el, ...kids) {
  el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
  return el;
}

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Zichtbare schermruimte (zonder toetsenbord) als CSS-variabelen, zodat pop-ups
// boven het toetsenbord blijven en hun knoppen niet verdwijnen.
(function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const set = () => {
    document.documentElement.style.setProperty("--vvh", vv.height + "px");
    document.documentElement.style.setProperty("--vvt", vv.offsetTop + "px");
  };
  vv.addEventListener("resize", set);
  vv.addEventListener("scroll", set);
  set();
})();

// Veld in een pop-up krijgt focus: in beeld schuiven boven het toetsenbord.
document.addEventListener("focusin", (e) => {
  if (!e.target.closest || !e.target.closest(".dlg") || !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
  setTimeout(() => e.target.scrollIntoView({ block: "center", behavior: "smooth" }), 300);
});

let toastTimer = 0;
// action: optioneel {label, run} → knop in de melding (bijv. "Ongedaan").
export function toast(msg, ms = 2200, action = null) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("has-action", !!action);
  if (action) {
    t.append(
      h("button", {
        type: "button",
        class: "toast-act",
        onclick: () => {
          t.classList.remove("show");
          action.run();
        },
      }, action.label)
    );
  }
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// Onderlaag-dialoog. content is een element; buttons [{label, value, kind}].
export function dialog({ title, content, buttons = [{ label: "OK", value: true, kind: "primary" }], sheet = false, cls = "" }) {
  return new Promise((resolve) => {
    const back = h("div", { class: "dlg-back" + (sheet ? " sheet" : "") });
    const box = h("div", { class: "dlg" + (cls ? " " + cls : ""), role: "dialog", "aria-modal": "true" });
    if (title) box.append(h("h2", { class: "dlg-title" }, title));
    if (content) box.append(h("div", { class: "dlg-body" }, content));
    const row = h("div", { class: "dlg-btns" });
    const close = (v) => {
      back.classList.remove("show");
      document.removeEventListener("keydown", onKey, true);
      setTimeout(() => back.remove(), 180);
      resolve(v);
    };
    for (const b of buttons) {
      row.append(h("button", { class: "btn " + (b.kind || ""), type: "button", onclick: () => close(typeof b.value === "function" ? b.value() : b.value) }, b.label));
    }
    if (buttons.length) box.append(row);
    back.append(box);
    back.addEventListener("pointerdown", (e) => {
      if (e.target === back) close(undefined);
    });
    const onKey = (e) => {
      // Alleen de bovenste pop-up reageert (bv. zoeken bovenop "Gegevens").
      const all = document.querySelectorAll(".dlg-back");
      if (all[all.length - 1] !== back) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        close(undefined);
      } else if (e.key === "Enter" && e.target.tagName === "INPUT") {
        const primary = buttons.find((b) => b.kind === "primary");
        if (primary) {
          e.preventDefault();
          close(typeof primary.value === "function" ? primary.value() : primary.value);
        }
      }
    };
    document.addEventListener("keydown", onKey, true);
    document.body.append(back);
    requestAnimationFrame(() => back.classList.add("show"));
    const first = box.querySelector("input, textarea, select");
    if (first) setTimeout(() => first.focus(), 60);
    dialog.close = close;
  });
}

export function confirmDlg(title, text, okLabel = "OK", danger = false) {
  return dialog({
    title,
    content: text ? h("p", {}, text) : null,
    buttons: [
      { label: "Annuleren", value: false },
      { label: okLabel, value: true, kind: danger ? "danger" : "primary" },
    ],
  }).then((v) => !!v);
}

export function promptDlg(title, value = "", { placeholder = "", type = "text", okLabel = "OK", paste = false } = {}) {
  const input = h("input", { class: "field", type, value, placeholder, inputmode: type === "number" ? "numeric" : type === "url" ? "url" : null, autocomplete: "off" });
  // Knop "Plakken": handig voor links, want lang drukken is op sommige telefoons lastig.
  const pasteBtn = paste
    ? h("button", {
        type: "button",
        class: "btn paste-btn",
        onclick: async () => {
          try {
            const t = await navigator.clipboard.readText();
            if (t) {
              input.value = t.trim();
              return;
            }
            toast("Het klembord is leeg. Kopieer eerst de link.", 3000);
          } catch (e) {
            input.focus();
            toast("Houd je vinger in het veld en kies Plakken", 3000);
          }
        },
        html: '<svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg><span>Plakken</span>',
      })
    : null;
  return dialog({
    title,
    content: paste ? h("div", { class: "paste-row" }, input, pasteBtn) : input,
    buttons: [
      { label: "Annuleren", value: null },
      { label: okLabel, value: () => input.value.trim(), kind: "primary" },
    ],
  }).then((v) => (v == null ? null : v));
}

// Keuzemenu als lijst met grote knoppen. items: [{label, value, icon, danger}]
export function menu(title, items) {
  return new Promise((resolve) => {
    let chosen;
    const list = h(
      "div",
      { class: "menu-list" },
      items.map((it) =>
        h(
          "button",
          {
            type: "button",
            class: "menu-item" + (it.danger ? " danger" : "") + (it.active ? " active" : ""),
            onclick: () => {
              chosen = it.value;
              dialog.close && dialog.close(it.value);
            },
          },
          it.icon ? h("span", { class: "mi-ic", html: it.icon }) : null,
          h("span", {}, it.label)
        )
      )
    );
    dialog({ title, content: list, buttons: [], sheet: true }).then((v) => resolve(v ?? chosen));
  });
}

export function fmtBytes(n) {
  if (!n) return "0 MB";
  if (n < 1024 * 1024) return Math.max(1, Math.round(n / 1024)) + " kB";
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0).replace(".", ",") + " MB";
  return (n / 1024 / 1024 / 1024).toFixed(1).replace(".", ",") + " GB";
}

export function fmtTime(s) {
  if (!isFinite(s)) return "0:00";
  s = Math.max(0, Math.floor(s));
  return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
}

export function fmtDate(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}
