// Muzivotheek: hoofdscherm met tabbladen Nummers, Lijsten, Tools, Instellingen.

import { db, persistStorage, storageEstimate } from "./db.js";
import { allSongs, getSong, saveSong, importPdf, deleteSong, sortSongs, matches, folders, mergeSongs, appendFiles } from "./library.js";
import { allSetlists, getSetlist, saveSetlist, newSetlist, deleteSetlist, duplicateSetlist, addToSetlist } from "./setlists.js";
import { settings, setSetting, resetSettings, applyTheme } from "./settings.js";
import { openSong, attachAudio, viewerOpen } from "./viewer.js";
import { loadPdf, makeThumb } from "./pdf.js";
import { exportBackup, importBackup, downloadBlob } from "./backup.js";
import { Metronome, tempoName } from "./metronome.js";
import { Tuner } from "./tuner.js";
import { $, $$, h, fill, toast, dialog, confirmDlg, promptDlg, menu, fmtBytes, fmtDate } from "./ui.js";
import { icon } from "./icons.js";
import { parseYouTube, pickYouTube } from "./youtube.js";
import { isImageFile, isPdfFile } from "./imgpdf.js";
import { recognizeSong, recognizeInfo, queueRecognize, cleanBadRecognition } from "./recognize.js";
import { isGarbageName } from "./names.js";
import { canLinkFolder, canPickFolderOnce, linkFolder, unlinkFolder, folderSources, syncFolder, syncAllFolders, regrantAndSync, pickFolderOnce } from "./folders.js";
import { openSharePoint, openSharePointWithLink, fixBrokenLinks, resumeAfterRedirect, spSettings } from "./sp_ui.js";
import { spConfigured, syncAllSharePoint } from "./sharepoint.js";
import { initUpdates, check as checkUpdate, applyUpdate, BUILD } from "./update.js";

const VERSION = "1.0.0";
const S = () => settings();

const state = {
  tab: "songs",
  q: "",
  filter: "", // "" | "★" | "map:<naam>" | "part:<partij>"
  sel: null, // Set met geselecteerde nummers (selecteermodus), anders null
  openList: null, // id van geopende afspeellijst
  needPermission: [], // gekoppelde mappen die opnieuw toestemming nodig hebben
  spBroken: [], // SharePoint-mappen waarvan de link niet meer werkt
};

// ---------- tabs ----------

function setTab(tab) {
  if (tab !== "songs" && state.sel) {
    state.sel = null;
    renderSelActions();
  }
  if (state.tab === "tools" && tab !== "tools") stopTools();
  state.tab = tab;
  $$(".bottom-nav button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + tab));
  $("#fab").hidden = !(tab === "songs" || (tab === "lists" && !state.openList));
  renderTab();
  $("#main").scrollTop = 0;
}

function renderTab() {
  if (state.tab === "songs") renderSongs();
  if (state.tab === "lists") renderLists();
  if (state.tab === "tools") renderTools();
  if (state.tab === "settings") renderSettings();
}

// ---------- Nummers ----------

const SORTS = [
  ["title", "Titel"],
  ["composer", "Componist"],
  ["folder", "Map"],
  ["added", "Nieuwste eerst"],
  ["opened", "Laatst geopend"],
  ["played", "Meest gespeeld"],
];

const thumbUrls = new Map();
async function thumbUrl(id) {
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  let b = await db.get("thumbs", id);
  if (!b) {
    // Na terugzetten van een back-up: voorbeeld opnieuw maken.
    const f = await db.get("files", id);
    if (!f) return null;
    const doc = await loadPdf(f).catch(() => null);
    if (!doc) return null;
    b = await makeThumb(doc).catch(() => null);
    doc.destroy();
    if (!b) return null;
    await db.put("thumbs", id, b);
  }
  const u = URL.createObjectURL(b);
  thumbUrls.set(id, u);
  return u;
}

async function renderSongs() {
  const tab = $("#tab-songs");
  const all = await allSongs();
  const fl = await folders();
  if (state.filter && !filterLabel(state.filter, all)) state.filter = "";
  if (state.sel) for (const id of [...state.sel]) if (!all.some((x) => x.id === id)) state.sel.delete(id);
  if (state.sel && !state.sel.size) state.sel = null;

  const search = h("input", {
    class: "search",
    type: "search",
    placeholder: `Zoek in ${all.length} nummers`,
    value: state.q,
    oninput: (e) => {
      state.q = e.target.value;
      clearTimeout(search._t);
      search._t = setTimeout(renderSongsList, 120);
    },
  });

  const sortLabel = SORTS.find((s) => s[0] === S().sort)?.[1] || "Titel";
  const tools = h(
    "div",
    { class: "lib-tools" },
    h("button", { type: "button", class: "chip", onclick: pickSort, html: icon("sort") + `<span>${sortLabel}</span>` }),
    h("button", {
      type: "button",
      class: "chip icon-only",
      "aria-label": S().libView === "grid" ? "Lijstweergave" : "Rasterweergave",
      onclick: () => {
        setSetting("libView", S().libView === "grid" ? "list" : "grid");
        renderSongs();
      },
      html: icon(S().libView === "grid" ? "rows" : "grid"),
    })
  );

  // Eén filterknop in plaats van een rij knoppen per map.
  const hasFilters = fl.length || all.some((x) => x.favorite) || all.some((x) => x.part);
  if (hasFilters) {
    const active = state.filter ? filterLabel(state.filter, all) : null;
    tools.insertBefore(
      h(
        "button",
        { type: "button", class: "chip" + (active ? " on" : ""), onclick: () => pickFilter(all, fl) },
        h("span", { class: "chip-ic", html: icon("filter") }),
        h("span", {}, active || "Filter"),
        active
          ? h("span", {
              class: "chip-x",
              role: "button",
              "aria-label": "Filter weg",
              onclick: (e) => {
                e.stopPropagation();
                state.filter = "";
                renderSongs();
              },
              html: icon("close"),
            })
          : null
      ),
      tools.lastChild
    );
  }

  const listEl = h("div", { id: "song-list" });
  const folderBar = state.needPermission.length
    ? h("button", {
        type: "button",
        class: "sync-bar",
        onclick: async () => {
          const srcs = state.needPermission;
          state.needPermission = [];
          await runFolderSync(() => regrantAndSync(srcs, progressText), "Mappen bijgewerkt");
        },
        html: icon("folder") + `<span>Tik om ${state.needPermission.length > 1 ? "je gekoppelde mappen" : `map "${state.needPermission[0].name}"`} bij te werken</span>`,
      })
    : null;
  const spBar = state.spBroken.length
    ? h("button", {
        type: "button",
        class: "sync-bar",
        onclick: async () => {
          const b = state.spBroken;
          state.spBroken = [];
          await fixBrokenLinks(b);
          renderSongs();
        },
        html: icon("link") + `<span>SharePoint-link van "${state.spBroken[0].name}" werkt niet meer. Tik om de nieuwe link te plakken.</span>`,
      })
    : null;
  const selBar = state.sel
    ? h(
        "div",
        { class: "sel-bar" },
        h("button", { type: "button", class: "icon-btn", "aria-label": "Stoppen met selecteren", onclick: endSelect, html: icon("close") }),
        h("b", {}, `${state.sel.size} geselecteerd`),
        h("button", {
          type: "button",
          class: "btn small",
          onclick: () => {
            const visible = sortSongs(applyFilter(all.filter((x) => matches(x, state.q))), S().sort, S().sortDesc);
            const allOn = visible.every((x) => state.sel.has(x.id));
            visible.forEach((x) => (allOn ? state.sel.delete(x.id) : state.sel.add(x.id)));
            renderSongs();
          },
        }, "Alles")
      )
    : null;
  fill(tab, spBar, folderBar, selBar || h("div", { class: "search-row" }, h("span", { class: "search-ic", html: icon("search") }), search), selBar ? null : tools, listEl);
  renderSelActions();
  renderSongsList();

  async function renderSongsList() {
    let items = applyFilter(all.filter((s) => matches(s, state.q)));
    items = sortSongs(items, S().sort, S().sortDesc);

    if (!all.length) {
      fill(listEl, 
        h(
          "div",
          { class: "empty" },
          h("div", { class: "empty-ic", html: icon("music") }),
          h("h2", {}, "Nog geen bladmuziek"),
          h("p", {}, "Kies PDF's of foto's van je apparaat."),
          h("button", { type: "button", class: "btn primary big", onclick: pickFiles, html: icon("plus") + "<span>Muziek toevoegen</span>" }),
          canLinkFolder() || canPickFolderOnce() || spConfigured()
            ? h("div", {}, h("button", { type: "button", class: "btn big second", onclick: addMenu, html: icon("folder") + `<span>${spConfigured() ? "Of uit SharePoint / een map" : "Of een hele map"}</span>` }))
            : null
        )
      );
      return;
    }
    if (!items.length) {
      fill(listEl, h("p", { class: "muted center pad" }, "Niets gevonden."));
      return;
    }
    const grid = S().libView === "grid";
    listEl.className = grid ? "song-grid" : "song-list";
    let lastGroup = null;
    const frag = [];
    for (const s of items) {
      // Kopjes per letter / map bij sorteren op titel of map.
      let group = null;
      if (!grid && !state.q) {
        if (S().sort === "title") group = (s.title[0] || "#").toUpperCase().replace(/[^A-Z]/, "#");
        if (S().sort === "folder") group = s.folder || "Zonder map";
        if (S().sort === "composer") group = s.composer || "Onbekend";
      }
      if (group && group !== lastGroup) {
        frag.push(h("div", { class: "group" }, group));
        lastGroup = group;
      }
      frag.push(songRow(s, grid));
    }
    fill(listEl, ...frag);
  }
}

function songRow(s, grid) {
  const img = h("img", { class: "thumb", alt: "", loading: "lazy" });
  thumbUrl(s.id).then((u) => u && (img.src = u));
  const sub = [s.composer, s.part, s.key, s.bpm ? s.bpm + " bpm" : null, `${s.pages} p.`].filter(Boolean).join(" · ");
  const more = h("button", {
    type: "button",
    class: "row-more",
    "aria-label": "Meer",
    html: icon("more"),
    onclick: (e) => {
      e.stopPropagation();
      songMenu(s);
    },
  });
  const selected = state.sel && state.sel.has(s.id);
  const el = h(
    "div",
    {
      class: (grid ? "tile" : "row") + (state.sel ? " selecting" : "") + (selected ? " selected" : ""),
      role: "button",
      tabindex: 0,
      "aria-pressed": state.sel ? String(!!selected) : null,
      onclick: () => (state.sel ? toggleSel(s.id) : openSong(s.id)),
    },
    state.sel ? h("span", { class: "sel-box", html: selected ? icon("check") : "" }) : null,
    h("div", { class: "thumb-wrap" }, img),
    h(
      "div",
      { class: "row-main" },
      h("div", { class: "row-title" }, s.favorite ? h("span", { class: "fav", html: icon("star") }) : null, s.title),
      h("div", { class: "row-sub" }, sub),
      s.folder && !grid ? h("div", { class: "row-tag" }, s.folder) : null
    ),
    state.sel ? null : more
  );
  el.addEventListener("keydown", (e) => e.key === "Enter" && (state.sel ? toggleSel(s.id) : openSong(s.id)));
  // Lang indrukken = selecteren (daarna tik je er meer aan).
  longPress(el, () => (state.sel ? toggleSel(s.id) : startSelect(s.id)));
  return el;
}

function longPress(el, fn) {
  let t = 0;
  let sx = 0;
  let sy = 0;
  el.addEventListener("pointerdown", (e) => {
    sx = e.clientX;
    sy = e.clientY;
    t = setTimeout(() => {
      t = 0;
      el._long = true;
      if (navigator.vibrate) navigator.vibrate(15);
      fn();
    }, 550);
  });
  el.addEventListener("pointermove", (e) => {
    if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) {
      clearTimeout(t);
      t = 0;
    }
  });
  const clear = () => {
    clearTimeout(t);
    t = 0;
  };
  el.addEventListener("pointerup", clear);
  el.addEventListener("pointercancel", clear);
  el.addEventListener(
    "click",
    (e) => {
      if (el._long) {
        el._long = false;
        e.stopPropagation();
        e.preventDefault();
      }
    },
    true
  );
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

// ---------- filter ----------

function filterLabel(f, all) {
  if (f === "★") return all.some((x) => x.favorite) ? "Favorieten" : null;
  if (f.startsWith("part:")) return all.some((x) => x.part === f.slice(5)) ? f.slice(5) : null;
  const m = f.startsWith("map:") ? f.slice(4) : f;
  return all.some((x) => x.folder === m) ? m : null;
}

function applyFilter(list) {
  const f = state.filter;
  if (!f) return list;
  if (f === "★") return list.filter((x) => x.favorite);
  if (f.startsWith("part:")) return list.filter((x) => x.part === f.slice(5));
  const m = f.startsWith("map:") ? f.slice(4) : f;
  return list.filter((x) => x.folder === m);
}

async function pickFilter(all, fl) {
  const coll = new Intl.Collator("nl", { numeric: true });
  const parts = [...new Set(all.map((x) => x.part).filter(Boolean))].sort(coll.compare);
  const v = await menu("Filter", [
    { label: "Alles", value: "", icon: icon("music"), active: !state.filter },
    all.some((x) => x.favorite) ? { label: "Favorieten", value: "★", icon: icon("star"), active: state.filter === "★" } : null,
    ...fl.map((f) => ({ label: f, value: "map:" + f, icon: icon("folder"), active: state.filter === "map:" + f || state.filter === f })),
    ...parts.map((p) => ({ label: p, value: "part:" + p, icon: icon("audio"), active: state.filter === "part:" + p })),
  ].filter(Boolean));
  if (v === undefined || v === null) return;
  state.filter = v;
  renderSongs();
}

// ---------- selecteren ----------

function startSelect(id) {
  state.sel = new Set([id]);
  if (navigator.vibrate) navigator.vibrate(15);
  renderSongs();
}

function endSelect() {
  state.sel = null;
  renderSongs();
}

function toggleSel(id) {
  if (!state.sel) return;
  state.sel.has(id) ? state.sel.delete(id) : state.sel.add(id);
  if (!state.sel.size) state.sel = null;
  renderSongs();
}

// Actiebalk onderin tijdens selecteren.
function renderSelActions() {
  let bar = $("#sel-actions");
  if (!state.sel || state.tab !== "songs") {
    if (bar) bar.remove();
    $("#fab").hidden = state.tab !== "songs" && !(state.tab === "lists" && !state.openList);
    return;
  }
  $("#fab").hidden = true;
  if (!bar) {
    bar = h("div", { id: "sel-actions", class: "sel-actions" });
    document.body.append(bar);
  }
  const n = state.sel.size;
  const act = (ic, label, fn, opts = {}) =>
    h("button", { type: "button", class: "sel-act" + (opts.danger ? " danger" : ""), disabled: opts.disabled || null, onclick: fn, html: icon(ic) + `<span>${label}</span>` });
  fill(
    bar,
    act("list", "Lijst", () => addSongsToListDlg([...state.sel])),
    act("folder", "Map", () => setFolderForSel()),
    act("star", "Favoriet", () => favSel()),
    act("copy", "Samen", () => mergeSel(), { disabled: n < 2 }),
    act("trash", "Weg", () => deleteSel(), { danger: true })
  );
}

async function setFolderForSel() {
  const fl = await folders();
  const v = await menu("Naar map", [
    ...fl.map((f) => ({ label: f, value: "m:" + f, icon: icon("folder") })),
    { label: "Nieuwe map…", value: "__new", icon: icon("plus") },
    { label: "Geen map", value: "__none", icon: icon("close") },
  ]);
  if (!v) return;
  let name = v === "__none" ? "" : v.slice(2);
  if (v === "__new") {
    name = await promptDlg("Naam van de map", "", { placeholder: "bijv. Concert, Marsen, Kerst" });
    if (!name) return;
  }
  for (const id of state.sel) {
    const x = await getSong(id);
    if (x) {
      x.folder = name;
      await saveSong(x);
    }
  }
  toast(name ? `Naar map "${name}"` : "Map weggehaald", 1800);
  endSelect();
}

async function favSel() {
  const list = (await Promise.all([...state.sel].map(getSong))).filter(Boolean);
  const on = !list.every((x) => x.favorite);
  for (const x of list) {
    x.favorite = on;
    await saveSong(x);
  }
  toast(on ? "Favoriet" : "Geen favoriet meer", 1500);
  endSelect();
}

async function deleteSel() {
  const n = state.sel.size;
  if (!(await confirmDlg(`${n} ${n === 1 ? "nummer" : "nummers"} verwijderen?`, "Ook de krabbels erop verdwijnen.", "Verwijderen", true))) return;
  for (const id of [...state.sel]) await deleteSong(id);
  toast("Verwijderd", 1500);
  endSelect();
}

// Samenvoegen: volgorde kiezen (in de volgorde van aantikken) en een naam geven.
async function mergeSel() {
  const order = (await Promise.all([...state.sel].map(getSong))).filter(Boolean);
  const name = h("input", { class: "field", value: order[0].title });
  const listEl = h("div", { class: "merge-list" });
  const draw = () =>
    fill(
      listEl,
      order.map((x, i) =>
        h(
          "div",
          { class: "merge-row" },
          h("span", { class: "num" }, i + 1),
          h("span", { class: "merge-t" }, x.title, h("small", {}, ` · ${x.pages} p.`)),
          h("button", { type: "button", class: "icon-btn", "aria-label": "Omhoog", disabled: i === 0 || null, onclick: () => { [order[i - 1], order[i]] = [order[i], order[i - 1]]; draw(); }, html: icon("left").replace("<svg", '<svg style="transform:rotate(90deg)"') })
        )
      )
    );
  draw();
  const ok = await dialog({
    title: "Samenvoegen tot één nummer",
    content: h("div", { class: "form" }, h("label", { class: "form-row" }, h("span", {}, "Naam"), name), h("div", { class: "form-row" }, h("span", {}, "Volgorde"), listEl)),
    buttons: [
      { label: "Annuleren", value: false },
      { label: "Samenvoegen", value: true, kind: "primary" },
    ],
  });
  if (!ok) return;
  const prog = $("#progress");
  prog.hidden = false;
  prog.querySelector("span").textContent = "Samenvoegen…";
  prog.querySelector("i").style.width = "60%";
  try {
    const s = await mergeSongs(order.map((x) => x.id), name.value.trim());
    toast(`"${s.title}": ${s.pages} pagina's`, 2500);
    endSelect();
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    prog.hidden = true;
  }
}

// Extra pagina's (PDF of foto's) achter een bestaand nummer.
function appendPagesDlg(song) {
  const input = h("input", { type: "file", accept: "application/pdf,.pdf,image/*,.jpg,.jpeg,.png", multiple: true, hidden: true });
  input.onchange = async () => {
    const files = [...input.files].sort((a, b) => a.name.localeCompare(b.name, "nl", { numeric: true }));
    input.remove();
    if (!files.length) return;
    const prog = $("#progress");
    prog.hidden = false;
    prog.querySelector("span").textContent = "Pagina's toevoegen…";
    prog.querySelector("i").style.width = "60%";
    try {
      const added = await appendFiles(song.id, files);
      toast(`${added} ${added === 1 ? "pagina" : "pagina's"} toegevoegd aan "${song.title}"`, 2500);
    } catch (e) {
      toast(e.message, 4000);
    } finally {
      prog.hidden = true;
    }
  };
  document.body.append(input);
  input.click();
}

async function pickSort() {
  const v = await menu(
    "Sorteren op",
    [
      ...SORTS.map(([value, label]) => ({ label, value, active: S().sort === value })),
      { label: S().sortDesc ? "Volgorde: omgekeerd ✓" : "Volgorde omdraaien", value: "__desc", icon: icon("sort") },
    ]
  );
  if (!v) return;
  if (v === "__desc") setSetting("sortDesc", !S().sortDesc);
  else {
    setSetting("sort", v);
    setSetting("sortDesc", false);
  }
  renderSongs();
}

async function songMenu(s) {
  const v = await menu(s.title, [
    { label: "Openen", value: "open", icon: icon("music") },
    { label: "Aan lijst toevoegen", value: "list", icon: icon("list") },
    { label: "Pagina's toevoegen (PDF of foto)", value: "append", icon: icon("plus") },
    { label: "Selecteren (meerdere)", value: "select", icon: icon("check") },
    { label: s.favorite ? "Geen favoriet meer" : "Favoriet", value: "fav", icon: icon("star") },
    { label: "Gegevens bewerken", value: "edit", icon: icon("edit") },
    { label: s.audioId || s.youtube ? "Opname / YouTube wijzigen" : "Opname of YouTube toevoegen", value: "edit", icon: icon("audio") },
    navigator.canShare ? { label: "Delen", value: "share", icon: icon("share") } : null,
    { label: "Verwijderen", value: "del", icon: icon("trash"), danger: true },
  ].filter(Boolean));
  if (v === "open") openSong(s.id);
  if (v === "list") addSongsToListDlg([s.id]);
  if (v === "append") appendPagesDlg(s);
  if (v === "select") startSelect(s.id);
  if (v === "fav") {
    s.favorite = !s.favorite;
    await saveSong(s);
  }
  if (v === "edit") editSong(s.id);
  if (v === "share") shareSong(s);
  if (v === "del" && (await confirmDlg("Verwijderen?", `"${s.title}" en de krabbels erop worden verwijderd.`, "Verwijderen", true))) {
    await deleteSong(s.id);
    toast("Verwijderd");
  }
}

async function shareSong(s) {
  const blob = await db.get("files", s.id);
  const file = new File([blob], (s.fileName || s.title + ".pdf").replace(/[\\/]/g, "-"), { type: "application/pdf" });
  try {
    if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file], title: s.title });
  } catch (e) {}
}

const KEYS = ["", "C", "G", "D", "A", "E", "B", "F♯", "F", "B♭", "E♭", "A♭", "D♭", "G♭", "Am", "Em", "Bm", "F♯m", "C♯m", "Dm", "Gm", "Cm", "Fm", "B♭m", "E♭m"];

export async function editSong(id, onSaved) {
  const s = await getSong(id);
  if (!s) return;
  const f = (label, input) => h("label", { class: "form-row" }, h("span", {}, label), input);
  const title = h("input", { class: "field", value: s.title });
  const composer = h("input", { class: "field", value: s.composer || "", placeholder: "bijv. Jacob de Haan" });
  const arranger = h("input", { class: "field", value: s.arranger || "" });
  const part = h("input", { class: "field", value: s.part || "", placeholder: "bijv. 2e Cornet" });
  const recogBtn = h("button", {
    type: "button",
    class: "btn small",
    onclick: async () => {
      recogBtn.disabled = true;
      recogBtn.textContent = "Bezig…";
      try {
        // Alleen invullen in dit formulier; opgeslagen wordt pas met "Opslaan".
        const info = await recognizeInfo(id);
        const cur = (await getSong(id)) || s;
        const a = cur.auto || {};
        const filled = [];
        // Leeg, of eerder automatisch ingevuld (en dus niet door jou getypt): mag vervangen worden.
        const put = (input, val, label, auto) => {
          if (!val) return;
          const v = input.value.trim();
          if (v === val) return;
          if (!v || (auto && v === (label === "componist" ? cur.composer : cur.arranger))) {
            input.value = val;
            filled.push(label);
          }
        };
        put(composer, info.composer, "componist", a.composer);
        put(arranger, info.arranger, "arrangeur", a.arranger);
        if (info.part && !part.value.trim()) {
          part.value = info.part;
          filled.push("partij");
        }
        if (info.title && (!title.value.trim() || isGarbageName(title.value))) {
          title.value = info.title;
          filled.push("titel");
        }
        toast(filled.length ? `Ingevuld: ${filled.join(", ")}. Even controleren.` : "Niets betrouwbaars gevonden. Vul het zelf in.", 3200);
      } catch (e) {
        toast("Herkennen lukte niet", 2500);
      }
      recogBtn.disabled = false;
      recogBtn.textContent = "Herken uit blad";
    },
  }, "Herken uit blad");
  const key = h("select", { class: "field" }, KEYS.map((k) => h("option", { value: k, selected: (s.key || "") === k }, k || "—")));
  const bpm = h("input", { class: "field", type: "number", inputmode: "numeric", min: 0, max: 300, value: s.bpm || "", placeholder: "—" });
  const notes = h("textarea", { class: "field", rows: 2, placeholder: "bijv. 2e keer tacet" }, s.notes || "");
  const fav = h("input", { type: "checkbox", checked: !!s.favorite });

  let audioState = s.audioId ? "keep" : "none";
  let audioFile = null;
  const audioLabel = h("span", { class: "muted" }, s.audioId ? "Gekoppeld" : "Geen");
  if (s.audioId) db.get("audio", s.audioId).then((a) => a && (audioLabel.textContent = a.name));
  const audioIn = h("input", { type: "file", accept: "audio/*", hidden: true, onchange: (e) => {
    audioFile = e.target.files[0];
    if (audioFile) {
      audioState = "new";
      audioLabel.textContent = audioFile.name;
    }
  } });
  const youtube = h("input", { class: "field", value: s.youtube || "", placeholder: "Plak een YouTube-link", inputmode: "url" });
  const ytRow = h(
    "div",
    { class: "form-row" },
    h("span", {}, "YouTube"),
    h("div", { class: "audio-row" }, youtube, h("button", { type: "button", class: "btn small", title: "Zoek op YouTube", "aria-label": "Zoek op YouTube", onclick: async () => { const l = await pickYouTube({ title: title.value, composer: composer.value }); if (l) youtube.value = l; }, html: icon("search") }))
  );
  const audioRow = h(
    "div",
    { class: "form-row" },
    h("span", {}, "Opname (mp3)"),
    h("div", { class: "audio-row" }, audioLabel, audioIn,
      h("button", { type: "button", class: "btn small", onclick: () => audioIn.click() }, "Kies"),
      h("button", { type: "button", class: "btn small", onclick: () => { audioState = "remove"; audioFile = null; audioLabel.textContent = "Geen"; } }, "Weg"))
  );

  const content = h(
    "div",
    { class: "form" },
    f("Titel", title),
    f("Componist", composer),
    f("Arrangeur", arranger),
    f("Partij", part),
    h("div", { class: "recog-row" }, recogBtn),
    h("div", { class: "form-2" }, f("Toonsoort", key), f("Tempo (bpm)", bpm)),
    f("Notitie", notes),
    audioRow,
    ytRow,
    h("label", { class: "check-row" }, fav, h("span", {}, "Favoriet"))
  );
  const ok = await dialog({
    title: "Gegevens",
    content,
    buttons: [
      { label: "Annuleren", value: false },
      { label: "Opslaan", value: true, kind: "primary" },
    ],
  });
  if (!ok) return;
  if (youtube.value.trim() && !parseYouTube(youtube.value)) toast("YouTube-link niet herkend, niet opgeslagen", 3000);
  else s.youtube = youtube.value.trim();
  // Wat je zelf aanpast, laat de herkenning voortaan met rust.
  const fresh = (await getSong(id)) || s;
  const auto = { ...(fresh.auto || {}) };
  if ((title.value.trim() || s.title) !== fresh.title) auto.title = false;
  if (composer.value.trim() !== (fresh.composer || "")) auto.composer = false;
  if (arranger.value.trim() !== (fresh.arranger || "")) auto.arranger = false;
  if (title.value.trim()) auto.titleGarbage = false;
  s.auto = auto;
  s.title = title.value.trim() || s.title;
  s.composer = composer.value.trim();
  s.arranger = arranger.value.trim();
  s.part = part.value.trim();
  s.key = key.value;
  s.bpm = Math.max(0, Math.min(300, parseInt(bpm.value, 10) || 0));
  s.notes = notes.value.trim();
  s.favorite = fav.checked;
  if (audioState === "new" && audioFile) await attachAudio(s, audioFile);
  if (audioState === "remove" && s.audioId) {
    await db.del("audio", s.audioId);
    s.audioId = null;
  }
  await saveSong(s);
  toast("Opgeslagen");
  onSaved && onSaved();
}

document.addEventListener("edit-song", (e) => editSong(e.detail.id, e.detail.onSaved));

// ---------- importeren ----------

// Plus-knop: kiezen hoe je nummers toevoegt.
async function addMenu() {
  const items = [{ label: "PDF of foto kiezen", value: "files", icon: icon("upload") }];
  if (spConfigured()) items.push({ label: "Uit SharePoint", value: "sp", icon: icon("link") });
  if (canLinkFolder()) items.push({ label: "Map koppelen (blijft bijgewerkt)", value: "link", icon: icon("folder") });
  else if (canPickFolderOnce()) items.push({ label: "Hele map toevoegen", value: "once", icon: icon("folder") });
  if (items.length === 1) return pickFiles();
  const v = await menu("Muziek toevoegen", items);
  if (v === "files") pickFiles();
  if (v === "sp") openSharePoint();
  if (v === "once") importFiles(await pickFolderOnce());
  if (v === "link") {
    try {
      const src = await linkFolder();
      await runFolderSync(() => syncFolder(src, progressText), `Map "${src.name}" gekoppeld`);
    } catch (e) {
      if (e.name !== "AbortError") toast("Map koppelen mislukt");
    }
  }
}

function progressText(t) {
  const prog = $("#progress");
  prog.hidden = false;
  prog.querySelector("span").textContent = t;
  prog.querySelector("i").style.width = "60%";
}

async function runFolderSync(fn, doneLabel = "") {
  try {
    const r = await fn();
    const bits = [];
    if (r.added) bits.push(`${r.added} nieuw`);
    if (r.updated) bits.push(`${r.updated} bijgewerkt`);
    if (doneLabel || bits.length) toast([doneLabel, bits.join(", ")].filter(Boolean).join(": ") || "Alles is al bij", 3000);
    persistStorage();
    return r;
  } finally {
    $("#progress").hidden = true;
    document.dispatchEvent(new CustomEvent("library"));
  }
}

function pickFiles() {
  const input = h("input", { type: "file", accept: "application/pdf,.pdf,image/*,.jpg,.jpeg,.png", multiple: true, hidden: true });
  input.onchange = () => importFiles([...input.files]);
  document.body.append(input);
  input.click();
  setTimeout(() => input.remove(), 60000);
}

// files: File[] of [{file, folder}] (map importeren).
async function importFiles(files) {
  let items = files.map((f) => (f instanceof Blob ? { file: f, folder: null } : f));
  items = items.filter(({ file: f }) => isPdfFile(f) || isImageFile(f));
  if (!items.length) return toast("Kies een PDF of foto");
  let defFolder = "";
  if (items.length > 1 && state.filter.startsWith("map:")) defFolder = state.filter.slice(4);
  // Meerdere foto's: één nummer met meerdere pagina's, of elke foto apart?
  const photos = items.filter(({ file: f }) => isImageFile(f) && !isPdfFile(f));
  if (photos.length > 1) {
    const how = await menu(`${photos.length} foto's`, [
      { label: "Eén nummer (meerdere pagina's)", value: "one", icon: icon("copy") },
      { label: "Elke foto apart", value: "each", icon: icon("grid") },
    ]);
    if (!how) return;
    if (how === "one") {
      // Op naam sorteren, zodat pagina 1, 2, 3 in de goede volgorde staan.
      const sorted = photos.map((p) => p.file).sort((a, b) => a.name.localeCompare(b.name, "nl", { numeric: true }));
      const name = await promptDlg("Naam van het nummer", "", { placeholder: "Leeg = automatisch herkennen" });
      if (name == null) return;
      items = items.filter((it) => !photos.includes(it));
      items.unshift({ file: sorted, folder: photos[0].folder, name: name ? name + ".jpg" : sorted[0].name });
    }
  }
  // Zelfde soort voorloopnummers bij meerdere bestanden ("01 ...", "02 ...")? Dan zijn het volgnummers.
  const numbered = items.filter((it) => /^\s*\d{1,3}\s/.test((it.name || it.file.name || "").toString())).length >= 2;
  files = items;
  let ok = 0;
  let dup = 0;
  let fail = 0;
  const prog = $("#progress");
  prog.hidden = false;
  for (let i = 0; i < files.length; i++) {
    prog.querySelector("span").textContent = `Toevoegen ${i + 1} van ${files.length}…`;
    prog.querySelector("i").style.width = ((i + 0.5) / files.length) * 100 + "%";
    try {
      const r = await importPdf(files[i].file, { folder: files[i].folder ?? defFolder, name: files[i].name, numbered });
      r.duplicate ? dup++ : ok++;
    } catch (e) {
      console.error(e);
      fail++;
    }
  }
  prog.hidden = true;
  persistStorage();
  const bits = [];
  if (ok) bits.push(`${ok} toegevoegd`);
  if (dup) bits.push(`${dup} had je al`);
  if (fail) bits.push(`${fail} niet gelukt`);
  toast(bits.join(", "), 3000);
  if (state.tab !== "songs") setTab("songs");
  else renderSongs();
}

// Drag & drop (computer).
document.addEventListener("dragover", (e) => {
  if (viewerOpen()) return;
  e.preventDefault();
  document.body.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dropping");
});
document.addEventListener("drop", (e) => {
  if (viewerOpen()) return;
  e.preventDefault();
  document.body.classList.remove("dropping");
  importFiles([...(e.dataTransfer?.files || [])]);
});

// Gedeeld vanuit een andere app (bijv. WhatsApp → Delen → Muzivotheek).
async function importShared() {
  const params = new URLSearchParams(location.search);
  if (!params.has("shared")) return;
  history.replaceState(null, "", location.pathname);
  try {
    const cache = await caches.open("muzi-share");
    const reqs = await cache.keys();
    const files = [];
    for (const r of reqs) {
      const res = await cache.match(r);
      const name = decodeURIComponent(res.headers.get("x-name") || "gedeeld.pdf");
      const b = await res.blob();
      files.push(new File([b], name, { type: b.type || (/\.pdf$/i.test(name) ? "application/pdf" : "image/jpeg") }));
      await cache.delete(r);
    }
    if (files.length) await importFiles(files);
  } catch (e) {
    console.error(e);
  }
}

// Bestanden openen met Muzivotheek (computer, "Openen met").
if ("launchQueue" in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files || !params.files.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    importFiles(files);
  });
}

// ---------- Afspeellijsten ----------

async function renderLists() {
  const tab = $("#tab-lists");
  if (state.openList) return renderListDetail(tab, state.openList);
  const lists = await allSetlists();
  $("#fab").hidden = false;
  if (!lists.length) {
    fill(tab, 
      h(
        "div",
        { class: "empty" },
        h("div", { class: "empty-ic", html: icon("list") }),
        h("h2", {}, "Nog geen afspeellijsten"),
        h("p", {}, "Zet nummers op volgorde voor een concert of repetitie."),
        h("button", { type: "button", class: "btn primary big", onclick: createList, html: icon("plus") + "<span>Nieuwe lijst</span>" })
      )
    );
    return;
  }
  fill(tab, 
    h("h1", { class: "page-title" }, "Afspeellijsten"),
    h(
      "div",
      { class: "song-list" },
      lists.map((l) => {
        const el = h(
          "div",
          { class: "row", role: "button", tabindex: 0, onclick: () => { state.openList = l.id; renderLists(); $("#fab").hidden = true; } },
          h("div", { class: "list-ic", html: icon("list") }),
          h(
            "div",
            { class: "row-main" },
            h("div", { class: "row-title" }, l.name),
            h("div", { class: "row-sub" }, [`${l.songIds.length} ${l.songIds.length === 1 ? "nummer" : "nummers"}`, l.date ? fmtDate(new Date(l.date).getTime()) : null].filter(Boolean).join(" · "))
          ),
          h("button", {
            type: "button",
            class: "row-play",
            "aria-label": "Start",
            html: icon("play"),
            onclick: (e) => {
              e.stopPropagation();
              playList(l);
            },
          })
        );
        longPress(el, () => listMenu(l));
        return el;
      })
    )
  );
}

async function createList() {
  const name = await promptDlg("Nieuwe afspeellijst", "", { placeholder: "bijv. Concert 12 oktober", okLabel: "Maken" });
  if (!name) return;
  const l = await newSetlist(name);
  state.openList = l.id;
  setTab("lists");
  const ids = await pickSongs(l.name);
  if (ids && ids.length) await addToSetlist(l.id, ids);
  renderLists();
}

function playList(l, index = 0) {
  if (!l.songIds.length) return toast("Lijst is leeg");
  openSong(l.songIds[index], { setlistId: l.id, index });
}

async function listMenu(l) {
  const v = await menu(l.name, [
    { label: "Start", value: "play", icon: icon("play") },
    { label: "Naam wijzigen", value: "rename", icon: icon("edit") },
    { label: "Kopie maken", value: "copy", icon: icon("copy") },
    { label: "Verwijderen", value: "del", icon: icon("trash"), danger: true },
  ]);
  if (v === "play") playList(l);
  if (v === "rename") {
    const n = await promptDlg("Naam", l.name);
    if (n) {
      l.name = n;
      await saveSetlist(l);
    }
  }
  if (v === "copy") {
    await duplicateSetlist(l.id);
    toast("Kopie gemaakt");
  }
  if (v === "del" && (await confirmDlg("Lijst verwijderen?", `"${l.name}" wordt verwijderd. De nummers blijven bewaard.`, "Verwijderen", true))) {
    await deleteSetlist(l.id);
    state.openList = null;
  }
  renderLists();
}

async function renderListDetail(tab, id) {
  const l = await getSetlist(id);
  if (!l) {
    state.openList = null;
    return renderLists();
  }
  $("#fab").hidden = true;
  const songs = await Promise.all(l.songIds.map((sid) => getSong(sid)));
  const total = songs.reduce((n, s) => n + (s ? s.pages : 0), 0);

  const head = h(
    "div",
    { class: "detail-head" },
    h("button", { type: "button", class: "icon-btn", "aria-label": "Terug", onclick: () => { state.openList = null; renderLists(); }, html: icon("back") }),
    h("div", { class: "detail-title" }, h("h1", {}, l.name), h("div", { class: "row-sub" }, `${l.songIds.length} nummers · ${total} pagina's`)),
    h("button", { type: "button", class: "icon-btn", "aria-label": "Meer", onclick: () => listMenu(l), html: icon("more") })
  );

  const listEl = h("div", { class: "song-list setlist" });
  songs.forEach((s, i) => {
    const row = h(
      "div",
      { class: "row", dataset: { i } },
      h("span", { class: "drag", "aria-label": "Verslepen", html: icon("drag") }),
      h("span", { class: "num" }, i + 1),
      h(
        "div",
        { class: "row-main", role: "button", tabindex: 0, onclick: () => s && playList(l, i) },
        h("div", { class: "row-title" }, s ? s.title : "(verwijderd)"),
        h("div", { class: "row-sub" }, s ? [s.composer, s.key, s.bpm ? s.bpm + " bpm" : null].filter(Boolean).join(" · ") : "")
      ),
      h("button", {
        type: "button",
        class: "row-more",
        "aria-label": "Uit lijst halen",
        html: icon("close"),
        onclick: async () => {
          l.songIds.splice(i, 1);
          await saveSetlist(l);
          renderLists();
          toast("Uit lijst gehaald");
        },
      })
    );
    listEl.append(row);
  });
  enableDrag(listEl, async (from, to) => {
    const [m] = l.songIds.splice(from, 1);
    l.songIds.splice(to, 0, m);
    await saveSetlist(l);
    renderLists();
  });

  fill(tab, 
    head,
    h(
      "div",
      { class: "detail-actions" },
      h("button", { type: "button", class: "btn primary big", onclick: () => playList(l), html: icon("play") + "<span>Start</span>" }),
      h("button", {
        type: "button",
        class: "btn big",
        onclick: async () => {
          const ids = await pickSongs(l.name, l.songIds);
          if (ids && ids.length) {
            await addToSetlist(l.id, ids);
            renderLists();
          }
        },
        html: icon("plus") + "<span>Nummers</span>",
      })
    ),
    l.songIds.length ? listEl : h("p", { class: "muted center pad" }, "Voeg nummers toe met de knop hierboven."),
    l.songIds.length > 1 ? h("p", { class: "hint" }, "Sleep aan ⠿ om de volgorde te wijzigen.") : null
  );
}

// Slepen om te herordenen (werkt met vinger en muis).
function enableDrag(container, onMove) {
  container.addEventListener("pointerdown", (e) => {
    const handle = e.target.closest(".drag");
    if (!handle) return;
    e.preventDefault();
    const row = handle.closest(".row");
    const rows = [...container.children];
    const from = rows.indexOf(row);
    const rect = row.getBoundingClientRect();
    const startY = e.clientY;
    const hgt = rect.height;
    let to = from;
    row.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dy = ev.clientY - startY;
      row.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(rows.length - 1, from + Math.round(dy / hgt)));
      rows.forEach((r, i) => {
        if (r === row) return;
        let shift = 0;
        if (from < to && i > from && i <= to) shift = -hgt;
        if (from > to && i < from && i >= to) shift = hgt;
        r.style.transform = shift ? `translateY(${shift}px)` : "";
      });
      // Automatisch meescrollen bij de rand.
      const main = $("#main");
      const mr = main.getBoundingClientRect();
      if (ev.clientY < mr.top + 60) main.scrollTop -= 8;
      if (ev.clientY > mr.bottom - 60) main.scrollTop += 8;
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      rows.forEach((r) => (r.style.transform = ""));
      row.classList.remove("dragging");
      if (to !== from) onMove(from, to);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
}

// Kies nummers (meerdere). Geeft ids terug in de volgorde van aanvinken.
async function pickSongs(title, already = []) {
  const all = sortSongs(await allSongs(), "title");
  if (!all.length) {
    toast("Voeg eerst muziek toe");
    return [];
  }
  const chosen = [];
  const count = h("span", {}, "");
  const listEl = h("div", { class: "pick-list" });
  const search = h("input", { class: "field", type: "search", placeholder: "Zoeken", oninput: () => draw() });
  const draw = () => {
    fill(listEl, 
      ...all
        .filter((s) => matches(s, search.value))
        .map((s) => {
          const n = chosen.indexOf(s.id);
          return h(
            "button",
            {
              type: "button",
              class: "pick" + (n >= 0 ? " on" : ""),
              onclick: () => {
                const k = chosen.indexOf(s.id);
                k >= 0 ? chosen.splice(k, 1) : chosen.push(s.id);
                draw();
              },
            },
            h("span", { class: "pick-box" }, n >= 0 ? String(n + 1) : ""),
            h("span", { class: "pick-t" }, s.title, already.includes(s.id) ? h("small", {}, " · staat er al in") : null)
          );
        })
    );
    count.textContent = chosen.length ? ` (${chosen.length})` : "";
  };
  draw();
  const addBtnLabel = h("span", {}, "Toevoegen", count);
  const ok = await dialog({
    title: "Nummers kiezen",
    content: h("div", { class: "picker" }, search, listEl),
    buttons: [
      { label: "Annuleren", value: false },
      { label: addBtnLabel, value: true, kind: "primary" },
    ],
  });
  return ok ? chosen : [];
}

async function addSongsToListDlg(ids) {
  const lists = await allSetlists();
  const v = await menu("Aan lijst toevoegen", [
    ...lists.map((l) => ({ label: `${l.name} (${l.songIds.length})`, value: l.id, icon: icon("list") })),
    { label: "Nieuwe lijst…", value: "__new", icon: icon("plus") },
  ]);
  if (!v) return;
  let id = v;
  if (v === "__new") {
    const name = await promptDlg("Nieuwe afspeellijst", "", { placeholder: "bijv. Concert 12 oktober", okLabel: "Maken" });
    if (!name) return;
    id = (await newSetlist(name)).id;
  }
  await addToSetlist(id, ids);
  toast("Toegevoegd aan lijst");
}

// ---------- Tools: metronoom + stemapparaat ----------

const metro = new Metronome();
const tuner = new Tuner();
let tunerOn = false;

function stopTools() {
  metro.stop();
  if (tunerOn) tuner.stop();
  tunerOn = false;
}

function renderTools() {
  const tab = $("#tab-tools");
  metro.beats = S().metroBeats;
  const bpm = h("div", { class: "big-bpm" }, metro.bpm);
  const name = h("div", { class: "metro-name" }, tempoName(metro.bpm));
  const dots = h("div", { class: "beat-dots" });
  const drawDots = () => fill(dots, ...Array.from({ length: metro.beats }, (_, i) => h("i", { dataset: { i } })));
  drawDots();
  const set = (v) => {
    metro.setBpm(v);
    bpm.textContent = metro.bpm;
    name.textContent = tempoName(metro.bpm);
    slider.value = metro.bpm;
  };
  metro.onBeat = (beat) => {
    $$("i", dots).forEach((d, i) => d.classList.toggle("on", i === beat));
  };
  const slider = h("input", { type: "range", min: 30, max: 240, value: metro.bpm, class: "block", oninput: (e) => set(+e.target.value) });
  const play = h("button", {
    type: "button",
    class: "btn primary big",
    html: icon(metro.running ? "pause" : "play") + `<span>${metro.running ? "Stop" : "Start"}</span>`,
    onclick: () => {
      metro.toggle();
      play.innerHTML = icon(metro.running ? "pause" : "play") + `<span>${metro.running ? "Stop" : "Start"}</span>`;
      if (!metro.running) $$("i", dots).forEach((d) => d.classList.remove("on"));
    },
  });
  const beats = h(
    "select",
    { class: "field small", onchange: (e) => { metro.beats = +e.target.value; setSetting("metroBeats", metro.beats); drawDots(); } },
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 12].map((n) => h("option", { value: n, selected: n === metro.beats }, n + "/4"))
  );

  // Stemapparaat
  const note = h("div", { class: "tn-note" }, "–");
  const cents = h("div", { class: "tn-cents" }, "");
  const needle = h("div", { class: "tn-needle" });
  const meter = h("div", { class: "tn-meter" }, h("div", { class: "tn-scale" }, h("span", {}, "♭"), h("b", {}), h("span", {}, "♯")), needle);
  const freq = h("div", { class: "muted small" }, "");
  const tBtn = h("button", {
    type: "button",
    class: "btn primary big",
    html: icon("mic") + `<span>${tunerOn ? "Stop" : "Start"}</span>`,
    onclick: async () => {
      if (tunerOn) {
        tuner.stop();
        tunerOn = false;
      } else {
        try {
          tuner.ref = S().tunerRef;
          tuner.transpose = S().tunerTranspose;
          await tuner.start();
          tunerOn = true;
        } catch (e) {
          toast("Geen toegang tot de microfoon");
        }
      }
      tBtn.innerHTML = icon("mic") + `<span>${tunerOn ? "Stop" : "Start"}</span>`;
    },
  });
  let smooth = 0;
  tuner.onPitch = (p) => {
    if (!p) {
      meter.classList.remove("ok");
      return;
    }
    smooth = smooth * 0.6 + p.cents * 0.4;
    note.innerHTML = `${p.note}<sub>${p.octave}</sub>`;
    cents.textContent = (p.cents > 0 ? "+" : "") + p.cents;
    needle.style.transform = `translateX(-50%) rotate(${Math.max(-50, Math.min(50, smooth)) * 0.9}deg)`;
    meter.classList.toggle("ok", Math.abs(p.cents) <= 5);
    freq.textContent = p.freq.toFixed(1).replace(".", ",") + " Hz";
  };
  const trans = h(
    "select",
    { class: "field small", onchange: (e) => { setSetting("tunerTranspose", +e.target.value); tuner.transpose = +e.target.value; } },
    [
      [0, "C (concert)"],
      [2, "B♭ (trompet, bugel, klarinet, tenorsax)"],
      [9, "E♭ (althoorn, altsax, es-klarinet)"],
      [7, "F (hoorn)"],
    ].map(([v, l]) => h("option", { value: v, selected: S().tunerTranspose === v }, l))
  );

  fill(tab, 
    h("h1", { class: "page-title" }, "Tools"),
    h(
      "section",
      { class: "card tool" },
      h("h2", { html: icon("metronome") + " Metronoom" }),
      h("div", { class: "metro-row" }, h("button", { type: "button", class: "round big", onclick: () => set(metro.bpm - 1) }, "−"), h("div", { class: "metro-mid" }, bpm, name), h("button", { type: "button", class: "round big", onclick: () => set(metro.bpm + 1) }, "+")),
      slider,
      dots,
      h("div", { class: "metro-row" }, h("button", { type: "button", class: "btn", onclick: () => { const b = metro.tap(); if (b) set(b); } }, "Tik tempo"), beats, play)
    ),
    h(
      "section",
      { class: "card tool" },
      h("h2", { html: icon("mic") + " Stemapparaat" }),
      h("div", { class: "tuner" }, note, cents, meter, freq),
      h("div", { class: "metro-row" }, trans, tBtn)
    )
  );
}

// ---------- Instellingen ----------

async function renderSettings() {
  const tab = $("#tab-settings");
  const toggle = (key, label, sub) =>
    h(
      "label",
      { class: "set-row" },
      h("div", {}, h("div", { class: "set-l" }, label), sub ? h("div", { class: "set-s" }, sub) : null),
      h("input", { type: "checkbox", class: "switch", checked: !!S()[key], onchange: (e) => setSetting(key, e.target.checked) })
    );
  const select = (key, label, opts, conv = (v) => v) =>
    h(
      "label",
      { class: "set-row" },
      h("div", { class: "set-l" }, label),
      h("select", { class: "field small", onchange: (e) => setSetting(key, conv(e.target.value)) }, opts.map(([v, l]) => h("option", { value: v, selected: String(S()[key]) === String(v) }, l)))
    );
  const group = (title, ...rows) => h("section", { class: "card set" }, h("h2", {}, title), ...rows);

  const est = await storageEstimate();
  const sources = await folderSources();
  const spGroup = await spSettings(renderSettings, (title, ...rows) => group(title, ...rows));
  const songs = await allSongs();
  const lists = await allSetlists();
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted().catch(() => false) : false;

  const restoreIn = h("input", { type: "file", accept: ".zip,application/zip", hidden: true, onchange: (e) => restore(e.target.files[0]) });

  fill(tab, 
    h("h1", { class: "page-title" }, "Instellingen"),
    install.prompt || install.ios
      ? h(
          "section",
          { class: "card install" },
          h("div", {}, h("b", {}, "Op beginscherm zetten"), h("div", { class: "set-s" }, install.ios ? "Tik op Delen ⬆ en dan 'Zet op beginscherm'." : "Werkt dan als een gewone app, ook zonder internet.")),
          install.prompt ? h("button", { type: "button", class: "btn primary", onclick: doInstall }, "Installeren") : null
        )
      : null,
    group(
      "Weergave",
      select("theme", "Thema", [["auto", "Automatisch"], ["light", "Licht"], ["dark", "Donker"]]),
      select("viewMode", "Weergave", [["single", "1 pagina"], ["double", "2 pagina's"], ["auto", "Automatisch"], ["scroll", "Scrollen"]]),
      toggle("scrollFill", "Scrollen: schermbreed", "Pagina vult de hele breedte"),
      toggle("halfTurn", "Halve pagina omslaan"),
      select("halfOrder", "Halve pagina boven", [["curTop", "Deze pagina"], ["nextTop", "Volgende"]]),
      toggle("autoCrop", "Witte randen weg"),
      toggle("nightSheet", "Nachtstand", "Wit op zwart"),
      toggle("pageBadge", "Paginanummer", "Slepen of tikken voor groter"),
      toggle("fullscreen", "Volledig scherm"),
      toggle("keepAwake", "Scherm blijft aan")
    ),
    group(
      "Omslaan",
      toggle("tapZones", "Tikken aan de zijkant"),
      toggle("tapLeftPrev", "Links = terug"),
      toggle("swipe", "Vegen"),
      toggle("pedalSwap", "Pedaal omdraaien")
    ),
    group(
      "Herkennen",
      toggle("autoRecognize", "Titel en componist herkennen", "Uit de PDF, anders met tekstherkenning"),
      h(
        "div",
        { class: "btn-row" },
        h("button", {
          type: "button",
          class: "btn",
          onclick: async () => {
            const all = await allSongs();
            const todo = all.filter((x) => !x.composer || (x.auto && x.auto.titleGarbage));
            if (!todo.length) return toast("Alle nummers hebben al een componist", 2500);
            todo.forEach((x) => queueRecognize(x.id, { force: true }));
            toast(`${todo.length} nummers worden op de achtergrond herkend`, 3000);
          },
        }, "Herken voor alle nummers")
      )
    ),
    group(
      "Krabbels",
      toggle("showNotes", "Krabbels tonen"),
      select("penWidth", "Pendikte", [[2, "Dun"], [3, "Normaal"], [6, "Dik"]], Number)
    ),
    group(
      "Metronoom & stemmen",
      toggle("metroSound", "Klik-geluid"),
      toggle("metroFlash", "Flits op de tel"),
      toggle("metroAccent", "Eerste tel harder"),
      select("tunerRef", "Stemtoon A", [[438, "438 Hz"], [440, "440 Hz"], [441, "441 Hz"], [442, "442 Hz"], [443, "443 Hz"]], Number)
    ),
    spGroup,
    sources.length || canLinkFolder()
      ? group(
          "Gekoppelde mappen",
          ...sources.map((src) =>
            h(
              "div",
              { class: "set-row" },
              h("div", {}, h("div", { class: "set-l" }, src.name), h("div", { class: "set-s" }, src.lastSync ? "Bijgewerkt " + new Date(src.lastSync).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Nog niet bijgewerkt")),
              h(
                "div",
                { class: "row-btns" },
                h("button", {
                  type: "button",
                  class: "btn small",
                  onclick: () => runFolderSync(() => regrantAndSync([src], progressText), "Bijgewerkt").then(renderSettings),
                }, "Bijwerken"),
                h("button", {
                  type: "button",
                  class: "btn small danger-o",
                  onclick: async () => {
                    if (await confirmDlg("Map ontkoppelen?", "Nummers die al zijn toegevoegd blijven staan.", "Ontkoppelen")) {
                      await unlinkFolder(src.id);
                      renderSettings();
                    }
                  },
                }, "Ontkoppel")
              )
            )
          ),
          h("p", { class: "set-s pad-x" }, "Nieuwe bestanden komen er vanzelf bij."),
          canLinkFolder()
            ? h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn", onclick: async () => { try { const src = await linkFolder(); await runFolderSync(() => syncFolder(src, progressText), `Map "${src.name}" gekoppeld`); renderSettings(); } catch (e) { if (e.name !== "AbortError") toast("Map koppelen mislukt"); } }, html: icon("folder") + "<span>Map koppelen</span>" }))
            : null
        )
      : null,
    group(
      "Opslag & back-up",
      h("div", { class: "set-row" }, h("div", {}, h("div", { class: "set-l" }, `${songs.length} ${songs.length === 1 ? "nummer" : "nummers"}, ${lists.length} ${lists.length === 1 ? "lijst" : "lijsten"}`), h("div", { class: "set-s" }, est ? `${fmtBytes(est.usage)} gebruikt` + (persisted ? " · vastgezet ✓" : "") : ""))),
      h("p", { class: "set-s pad-x" }, "Alles staat alleen op dit apparaat. Maak af en toe een back-up."),
      h(
        "div",
        { class: "btn-row" },
        h("button", { type: "button", class: "btn", onclick: backup, html: icon("download") + "<span>Back-up maken</span>" }),
        h("button", { type: "button", class: "btn", onclick: () => restoreIn.click(), html: icon("upload") + "<span>Terugzetten</span>" }),
        restoreIn
      )
    ),
    group(
      "Overig",
      h(
        "div",
        { class: "btn-row" },
        h("button", { type: "button", class: "btn", onclick: async () => { if (await confirmDlg("Instellingen herstellen?", "Alle instellingen gaan terug naar standaard. Je muziek blijft.", "Herstellen")) { resetSettings(); applyTheme(); renderSettings(); } } }, "Standaard instellingen"),
        h("button", { type: "button", class: "btn danger-o", onclick: wipeAll }, "Alles wissen")
      )
    ),
    h(
      "div",
      { class: "about" },
      h("img", { src: "branding/eendracht.png", alt: "Eendracht Aalten", class: "about-logo" }),
      h("div", {}, h("b", {}, "MuzIVOtheek"), " · versie " + VERSION + (BUILD.startsWith("__") ? "" : " (" + BUILD + ")")),
      h("button", { type: "button", class: "btn small", onclick: manualUpdateCheck }, "Controleren op updates"),
      h("div", { class: "set-s" }, "Werkt offline. Je muziek verlaat dit apparaat niet.")
    )
  );
}

async function manualUpdateCheck(e) {
  const b = e.currentTarget;
  b.textContent = "Bezig met controleren…";
  const r = await checkUpdate();
  if (r === "new") {
    if (await confirmDlg("Nieuwe versie beschikbaar", "Nu bijwerken? Je muziek en lijsten blijven gewoon bewaard.", "Bijwerken")) applyUpdate();
    b.textContent = "Controleren op updates";
  } else {
    b.textContent = r === "offline" ? "Geen internet, probeer later" : "Je hebt de nieuwste versie ✓";
  }
}

async function backup() {
  const prog = $("#progress");
  prog.hidden = false;
  try {
    const blob = await exportBackup((i, n) => {
      prog.querySelector("span").textContent = `Back-up maken ${i} van ${n}…`;
      prog.querySelector("i").style.width = (i / n) * 100 + "%";
    });
    const d = new Date();
    const name = `muzivotheek-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.zip`;
    const file = new File([blob], name, { type: "application/zip" });
    prog.hidden = true;
    // Op telefoon/tablet: via Delen naar Drive/OneDrive/mail. Anders downloaden.
    if (navigator.canShare && navigator.canShare({ files: [file] }) && matchMedia("(pointer: coarse)").matches) {
      const how = await menu("Back-up (" + fmtBytes(blob.size) + ")", [
        { label: "Delen (Drive, OneDrive, mail…)", value: "share", icon: icon("share") },
        { label: "Opslaan in Downloads", value: "dl", icon: icon("download") },
      ]);
      if (how === "share") {
        try {
          await navigator.share({ files: [file], title: name });
        } catch (e) {}
        return;
      }
      if (how !== "dl") return;
    }
    downloadBlob(blob, name);
    toast("Back-up opgeslagen");
  } catch (e) {
    prog.hidden = true;
    console.error(e);
    toast("Back-up mislukt: " + e.message, 4000);
  }
}

async function restore(file) {
  if (!file) return;
  const how = await menu("Back-up terugzetten", [
    { label: "Toevoegen aan wat er al is", value: "merge", icon: icon("plus") },
    { label: "Alles vervangen", value: "replace", icon: icon("repeat"), danger: true },
  ]);
  if (!how) return;
  if (how === "replace" && !(await confirmDlg("Alles vervangen?", "Alles wat nu in de app staat wordt vervangen door de back-up.", "Vervangen", true))) return;
  const prog = $("#progress");
  prog.hidden = false;
  prog.querySelector("span").textContent = "Terugzetten…";
  prog.querySelector("i").style.width = "50%";
  try {
    const n = await importBackup(file, how);
    thumbUrls.clear();
    applyTheme();
    toast(`${n} nummers teruggezet`, 3000);
    document.dispatchEvent(new CustomEvent("library"));
    renderSettings();
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    prog.hidden = true;
  }
}

async function wipeAll() {
  if (!(await confirmDlg("Alles wissen?", "Alle nummers, krabbels en lijsten worden van dit apparaat verwijderd. Dit kan niet ongedaan worden.", "Alles wissen", true))) return;
  for (const s of ["songs", "files", "thumbs", "notes", "audio", "setlists", "sources"]) await db.clear(s);
  location.reload();
}

// ---------- installeren ----------

const install = { prompt: null, ios: false };
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  install.prompt = e;
  if (state.tab === "settings") renderSettings();
});
window.addEventListener("appinstalled", () => {
  install.prompt = null;
  toast("Geïnstalleerd");
});
const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
install.ios = !standalone && /iphone|ipad|ipod/i.test(navigator.userAgent) || (!standalone && navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

async function doInstall() {
  if (!install.prompt) return;
  install.prompt.prompt();
  await install.prompt.userChoice.catch(() => {});
  install.prompt = null;
  renderSettings();
}

// ---------- start ----------

function init() {
  applyTheme();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  document.addEventListener("settings", (e) => {
    if (e.detail.key === "theme" || !e.detail.key) applyTheme();
  });
  $$(".bottom-nav button").forEach((b) => b.addEventListener("click", () => {
    if (b.dataset.tab === "lists" && state.tab === "lists") state.openList = null;
    setTab(b.dataset.tab);
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.sel && !document.querySelector(".dlg-back") && !viewerOpen()) endSelect();
  });
  $("#fab").addEventListener("click", () => (state.tab === "lists" ? createList() : addMenu()));
  document.addEventListener("thumb-changed", (e) => {
    const u = thumbUrls.get(e.detail);
    if (u) URL.revokeObjectURL(u);
    thumbUrls.delete(e.detail);
  });
  document.addEventListener("library", () => {
    if (viewerOpen()) return;
    if (state.tab === "songs") renderSongs();
    if (state.tab === "lists") renderLists();
  });
  document.addEventListener("recognized", (e) => {
    const d = e.detail;
    if (d.composer && d.changed.includes("componist")) toast(`${d.title}: ${d.composer}`, 2200);
    if (!viewerOpen() && state.tab === "songs") renderSongs();
  });
  document.addEventListener("setlists", () => state.tab === "lists" && !viewerOpen() && renderLists());
  setTab("songs");
  importShared();
  // Link gedeeld vanuit WhatsApp/mail (Delen → MuzIVOtheek).
  const sharedLink = new URLSearchParams(location.search).get("link");
  if (sharedLink) {
    history.replaceState(null, "", location.pathname);
    setTimeout(() => openSharePointWithLink(sharedLink), 300);
  }
  allSongs().then(async (s) => {
    if (s.length) persistStorage();
    // Eenmalig: eerder foutief herkende (lange/rare) namen weer leegmaken.
    try {
      if (!localStorage.getItem("muzivotheek.cleanRecog1")) {
        localStorage.setItem("muzivotheek.cleanRecog1", "1");
        if ((await cleanBadRecognition()) > 0) document.dispatchEvent(new CustomEvent("library"));
      }
    } catch (e) {}
    // Foto's/scans zonder herkende titel (bv. eerder zonder internet): nog eens proberen.
    if (navigator.onLine) s.filter((x) => x.auto && x.auto.titleGarbage).slice(0, 20).forEach((x) => queueRecognize(x.id));
  });
  // Terug van inloggen bij Microsoft? Dan daar verder. Daarna SharePoint-mappen stil bijwerken.
  resumeAfterRedirect()
    .then(() => syncAllSharePoint())
    .then((r) => {
      state.spBroken = r.broken || [];
      if (state.spBroken.length && state.tab === "songs" && !viewerOpen()) renderSongs();
      if (r.added || r.updated) {
        toast("SharePoint: " + [r.added ? `${r.added} nieuw` : "", r.updated ? `${r.updated} bijgewerkt` : ""].filter(Boolean).join(", "), 3000);
        document.dispatchEvent(new CustomEvent("library"));
      }
    })
    .catch(() => {});
  // Gekoppelde mappen stil bijwerken bij het starten.
  syncAllFolders().then((r) => {
    state.needPermission = r.needPermission;
    if (r.added || r.updated) {
      toast([r.added ? `${r.added} ${r.added === 1 ? "nieuw nummer" : "nieuwe nummers"}` : "", r.updated ? `${r.updated} bijgewerkt` : ""].filter(Boolean).join(", "), 3000);
      document.dispatchEvent(new CustomEvent("library"));
    } else if (r.needPermission.length && state.tab === "songs") renderSongs();
  }).catch(() => {});

  initUpdates();
}

init();
