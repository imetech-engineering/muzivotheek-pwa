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

let toastTimer = 0;
export function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
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

export function promptDlg(title, value = "", { placeholder = "", type = "text", okLabel = "OK" } = {}) {
  const input = h("input", { class: "field", type, value, placeholder, inputmode: type === "number" ? "numeric" : null });
  return dialog({
    title,
    content: input,
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
