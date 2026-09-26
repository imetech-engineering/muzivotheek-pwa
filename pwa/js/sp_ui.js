// Schermen voor SharePoint: link plakken, bladeren, zoeken, aanvinken, volgen.

import {
  spConfigured, graphConfigured, account, login, logout, token, looksLikeLink, addSource, spSources, saveSource, removeSource,
  listChildren, listAll, isPdf, isImported, importItems, syncSource, msal, relinkSource,
} from "./sharepoint.js";
import { $, h, fill, toast, dialog, confirmDlg, promptDlg, menu } from "./ui.js";
import { icon } from "./icons.js";

const PENDING = "muzi.sp.pendingLink";

function progress(text, frac = 0.5) {
  const prog = $("#progress");
  prog.hidden = false;
  prog.querySelector("span").textContent = text;
  prog.querySelector("i").style.width = Math.round(frac * 100) + "%";
}
const done = () => ($("#progress").hidden = true);

function report(r, prefix = "") {
  const bits = [];
  if (r.added) bits.push(`${r.added} ${r.added === 1 ? "nummer" : "nummers"} toegevoegd`);
  if (r.updated) bits.push(`${r.updated} bijgewerkt`);
  toast(prefix + (bits.join(", ") || "Alles is al bij"), 3000);
  document.dispatchEvent(new CustomEvent("library"));
}

function notConfigured() {
  return dialog({
    title: "SharePoint nog niet klaar",
    content: h("p", {}, "De koppeling met Microsoft moet eerst eenmalig worden ingesteld door de beheerder van de app."),
  });
}

// Ingang vanuit de + knop.
export async function openSharePoint() {
  if (!spConfigured()) return notConfigured();
  if (!navigator.onLine) return toast("Geen internet", 2500);
  const sources = await spSources();
  let src = null;
  if (sources.length) {
    const v = await menu("SharePoint", [
      ...sources.map((s) => ({ label: s.broken ? `${s.name} (link werkt niet meer)` : s.name, value: s.id, icon: icon("folder"), danger: !!s.broken })),
      { label: "Nieuwe link plakken…", value: "__new", icon: icon("link") },
    ]);
    if (!v) return;
    src = sources.find((s) => s.id === v) || null;
    if (src && src.broken) src = await askLink("", src);
    else if (!src) src = await askLink();
    if (src) browse(src);
    return;
  }
  if (!src) src = await askLink();
  if (src) browse(src);
}

// Link vragen. replace = bestaande map waarvoor dit de nieuwe link is.
async function askLink(prefill = "", replace = null) {
  const title = replace ? `Nieuwe link voor "${replace.name}"` : "Plak de SharePoint-link van de map";
  let link = await promptDlg(title, prefill, { placeholder: "https://…sharepoint.com/…", okLabel: "Verbinden" });
  if (!link) return null;
  link = extractLink(link);
  if (!link) {
    toast("Dat lijkt geen SharePoint- of OneDrive-link", 3000);
    return null;
  }
  // Nieuwe link terwijl er al mappen zijn? Vaak is het de nieuwe link van een bestaande map.
  if (!replace) {
    const sources = await spSources();
    if (sources.length) {
      const v = await menu("Wat is deze link?", [
        ...sources.map((s) => ({ label: `Nieuwe link voor "${s.name}"`, value: s.id, icon: icon("repeat") })),
        { label: "Een extra map", value: "__extra", icon: icon("plus") },
      ]);
      if (!v) return null;
      replace = sources.find((s) => s.id === v) || null;
    }
  }
  // Als inloggen via doorverwijzen gaat, na terugkomst verder met deze link.
  localStorage.setItem(PENDING, link);
  try {
    progress("Verbinden met SharePoint…");
    const src = replace ? await relinkSource(replace, link) : await addSource(link);
    if (replace) toast("Link bijgewerkt", 2000);
    localStorage.removeItem(PENDING);
    return src;
  } catch (e) {
    localStorage.removeItem(PENDING);
    toast(e.message, 4000);
    return null;
  } finally {
    done();
  }
}

// Haal de eerste SharePoint/OneDrive-link uit geplakte tekst (bv. een heel WhatsApp-bericht).
function extractLink(text) {
  const urls = String(text).match(/https?:\/\/[^\s<>"']+/g) || [];
  return urls.find((u) => looksLikeLink(u)) || null;
}

// Gedeeld vanuit WhatsApp/mail: link staat al klaar, één tik op Verbinden.
export async function openSharePointWithLink(link) {
  if (!spConfigured()) return notConfigured();
  const src = await askLink(link);
  if (src) browse(src);
}

// Knop in de bibliotheek als een link niet meer werkt.
export async function fixBrokenLinks(broken) {
  let src = broken[0];
  if (broken.length > 1) {
    const id = await menu("Welke map?", broken.map((s) => ({ label: s.name, value: s.id, icon: icon("folder") })));
    src = broken.find((s) => s.id === id);
  }
  if (!src) return;
  const fixed = await askLink("", src);
  if (fixed) browse(fixed);
}

// Na terugkomst van een inlog-doorverwijzing: afmaken waar we gebleven waren.
export async function resumeAfterRedirect() {
  if (!graphConfigured()) return;
  const flagged = localStorage.getItem("muzi.sp.resume");
  const hasCode = /[#&?](code|error)=/.test(location.hash + location.search);
  if (!flagged && !hasCode) return;
  localStorage.removeItem("muzi.sp.resume");
  try {
    await msal();
  } catch (e) {
    return;
  }
  const link = localStorage.getItem(PENDING);
  if (link && (await account())) {
    localStorage.removeItem(PENDING);
    try {
      progress("Verbinden met SharePoint…");
      const src = await addSource(link);
      done();
      browse(src);
    } catch (e) {
      done();
      toast(e.message, 4000);
    }
  }
}

// ---------- bladeren ----------

async function browse(src) {
  let tok = null;
  if (src.via !== "proxy") {
    try {
      tok = await token(true);
    } catch (e) {
      return toast(e.message || "Inloggen mislukt", 3000);
    }
    if (!tok) return;
  }

  const stack = [{ id: src.itemId, name: src.name }];
  const selected = new Map(); // id -> item (met .path)
  let items = [];
  let index = null; // alle PDF's (voor zoeken), pas bij eerste zoekopdracht
  let q = "";
  let drawId = 0;

  const crumbs = h("div", { class: "sp-crumbs" });
  const search = h("input", { class: "field", type: "search", placeholder: "Zoek in deze map en submappen", oninput: () => { q = search.value.trim(); clearTimeout(search._t); search._t = setTimeout(draw, 200); } });
  const list = h("div", { class: "pick-list sp-list" });
  const countLbl = h("span", {});
  const follow = h("input", { type: "checkbox", checked: !!src.follow, onchange: async () => { src.follow = follow.checked; await saveSource(src); toast(src.follow ? "Nieuwe nummers komen er vanzelf bij" : "Niet meer volgen", 2000); } });

  const path = () => stack.slice(1).map((s) => s.name);

  async function load() {
    fill(list, h("p", { class: "muted center pad" }, "Laden…"));
    try {
      items = await listChildren(src, stack[stack.length - 1].id, tok);
      items.sort((a, b) => (!!b.folder - !!a.folder) || a.name.localeCompare(b.name, "nl", { numeric: true }));
    } catch (e) {
      const dead = e.status === 403 || e.status === 404;
      if (dead) {
        src.broken = true;
        saveSource(src);
      }
      fill(
        list,
        h("p", { class: "muted center pad" }, dead ? "Deze link werkt niet meer (verlopen of vervangen)." : e.message),
        dead ? h("button", { type: "button", class: "btn primary block", onclick: async () => { dialog.close && dialog.close(false); const f = await askLink("", src); if (f) browse(f); } }, "Nieuwe link plakken") : null
      );
      return;
    }
    draw();
  }

  async function ensureIndex() {
    if (index) return;
    fill(list, h("p", { class: "muted center pad" }, "Zoeken in alle submappen…"));
    index = await listAll(src, src.itemId, tok, [], (p) => fill(list, h("p", { class: "muted center pad" }, "Zoeken in " + p + "…")));
  }

  function toggle(it, p) {
    selected.has(it.id) ? selected.delete(it.id) : selected.set(it.id, { ...it, path: it.path || p });
    draw();
  }

  async function row(it, p) {
    if (it.folder) {
      return h(
        "button",
        { type: "button", class: "pick sp-folder", onclick: () => { stack.push({ id: it.id, name: it.name }); q = ""; search.value = ""; load(); } },
        h("span", { class: "sp-ic", html: icon("folder") }),
        h("span", { class: "pick-t" }, it.name),
        h("span", { class: "sp-go", html: icon("right") })
      );
    }
    const have = await isImported(src, it);
    return h(
      "button",
      { type: "button", class: "pick" + (selected.has(it.id) ? " on" : ""), onclick: () => toggle(it, p) },
      h("span", { class: "pick-box" }, selected.has(it.id) ? "✓" : ""),
      h("span", { class: "pick-t" }, it.name.replace(/\.pdf$/i, ""), have ? h("small", {}, " · staat er al in") : null, it.path && it.path.length ? h("small", { class: "sp-path" }, it.path.join(" / ")) : null)
    );
  }

  async function draw() {
    const my = ++drawId; // snel typen: alleen de laatste zoekopdracht tonen
    fill(
      crumbs,
      stack.map((s, i) =>
        h("button", { type: "button", class: "sp-crumb" + (i === stack.length - 1 ? " cur" : ""), onclick: () => { if (i < stack.length - 1) { stack.length = i + 1; load(); } } }, i === 0 ? s.name : "› " + s.name)
      )
    );
    let rows;
    if (q) {
      try {
        await ensureIndex();
      } catch (e) {
        return fill(list, h("p", { class: "muted center pad" }, e.message));
      }
      const words = q.toLowerCase().split(/\s+/);
      const hits = index.filter((it) => words.every((w) => (it.name + " " + it.path.join(" ")).toLowerCase().includes(w)));
      rows = await Promise.all(hits.slice(0, 200).map((it) => row(it)));
      if (!hits.length) rows = [h("p", { class: "muted center pad" }, "Niets gevonden.")];
    } else {
      const shown = items.filter((it) => it.folder || isPdf(it));
      rows = await Promise.all(shown.map((it) => row(it, path())));
      if (!shown.length) rows = [h("p", { class: "muted center pad" }, "Geen PDF's in deze map.")];
    }
    if (my !== drawId) return;
    fill(list, ...rows);
    countLbl.textContent = selected.size ? ` (${selected.size})` : "";
  }

  const selectAll = async () => {
    // Alles in deze map, inclusief submappen.
    fill(list, h("p", { class: "muted center pad" }, "Alles in deze map verzamelen…"));
    try {
      const cur = stack[stack.length - 1];
      const all = await listAll(src, cur.id, tok, path());
      all.forEach((it) => selected.set(it.id, it));
      toast(`${all.length} nummers geselecteerd`, 2000);
    } catch (e) {
      toast(e.message, 3000);
    }
    draw();
  };

  const content = h(
    "div",
    { class: "sp-browser" },
    crumbs,
    search,
    h("div", { class: "sp-tools" }, h("button", { type: "button", class: "btn small", onclick: selectAll }, "Alles in deze map"), h("button", { type: "button", class: "btn small", onclick: () => { selected.clear(); draw(); } }, "Niets")),
    list,
    h("label", { class: "check-row sp-follow" }, follow, h("span", {}, `Map "${src.name}" volgen: nieuwe nummers vanzelf toevoegen`))
  );
  load();
  const ok = await dialog({
    title: "SharePoint",
    content,
    cls: "wide",
    buttons: [
      { label: "Sluiten", value: false },
      { label: h("span", {}, "Toevoegen", countLbl), value: true, kind: "primary" },
    ],
  });
  if (!ok || !selected.size) return;
  try {
    const r = await importItems(src, [...selected.values()], (t, f) => progress(t, f));
    report(r);
  } catch (e) {
    toast(e.message, 4000);
  } finally {
    done();
  }
}

// ---------- instellingen ----------

export async function spSettings(rerender, group) {
  if (!spConfigured()) return null;
  const acc = await account();
  const sources = await spSources();
  const rows = [];
  // Inloggen is alleen nodig voor links die niet voor "iedereen" zijn.
  const showLogin = graphConfigured() && (acc || sources.some((s) => s.via !== "proxy"));
  if (showLogin) rows.push(
    h(
      "div",
      { class: "set-row" },
      h("div", {}, h("div", { class: "set-l" }, acc ? "Ingelogd" : "Niet ingelogd"), acc ? h("div", { class: "set-s" }, acc.username || acc.name) : null),
      acc
        ? h("button", { type: "button", class: "btn small", onclick: async () => { await logout(); rerender(); } }, "Uitloggen")
        : h("button", { type: "button", class: "btn small primary", onclick: async () => { try { await login(); rerender(); } catch (e) { toast(e.message, 3000); } } }, "Inloggen")
    )
  );
  for (const src of sources) {
    rows.push(
      h(
        "div",
        { class: "set-row" },
        h(
          "div",
          {},
          h("div", { class: "set-l" }, src.name),
          h("div", { class: "set-s" + (src.broken ? " warn" : "") }, (src.broken ? "Link werkt niet meer · " : "") + (src.follow ? "Volgen · " : "") + (src.lastSync ? "Bijgewerkt " + new Date(src.lastSync).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Nog niet bijgewerkt"))
        ),
        h(
          "div",
          { class: "row-btns" },
          h("button", { type: "button", class: "btn small", onclick: () => browse(src) }, "Kiezen"),
          h("button", { type: "button", class: "btn small" + (src.broken ? " primary" : ""), onclick: async () => { const f = await askLink("", src); if (f) rerender(); } }, "Nieuwe link"),
          h("button", {
            type: "button",
            class: "btn small",
            onclick: async () => {
              try {
                const r = await syncSource(src, { interactive: true, onProgress: (t, f) => progress(t, f || 0.5) });
                report(r);
              } catch (e) {
                toast(e.message, 4000);
              } finally {
                done();
                rerender();
              }
            },
          }, "Bijwerken"),
          h("button", {
            type: "button",
            class: "btn small danger-o",
            "aria-label": "Ontkoppelen",
            onclick: async () => {
              if (await confirmDlg("Map ontkoppelen?", "Nummers die al zijn toegevoegd blijven staan.", "Ontkoppelen")) {
                await removeSource(src.id);
                rerender();
              }
            },
            html: icon("close"),
          })
        )
      )
    );
  }
  rows.push(
    h("p", { class: "set-s pad-x" }, "Plak de link van een gedeelde SharePoint-map. Bij een link 'Iedereen met de link' is geen account nodig. De muziek blijft daarna ook zonder internet op dit apparaat."),
    h("div", { class: "btn-row" }, h("button", { type: "button", class: "btn", onclick: async () => { const s = await askLink(); if (s) { rerender(); browse(s); } }, html: icon("link") + "<span>SharePoint-map koppelen</span>" }))
  );
  return group("SharePoint", ...rows);
}
