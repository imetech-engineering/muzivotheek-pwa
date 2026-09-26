// SharePoint / OneDrive via Microsoft Graph (officiële route).
//
// Inloggen met een Microsoft-account (MSAL, PKCE). Een geplakte deellink wordt
// via /shares omgezet naar een map; daarna bladeren, zoeken en downloaden.
// De app-registratie staat in config.js (client-id is geen geheim).

import { db, uid } from "./db.js";
import { importPdf, findBySrc, replaceFile } from "./library.js";

const CFG = () => window.MUZI_CONFIG || {};
const SCOPES = ["User.Read", "Files.Read.All"];
const GRAPH = "https://graph.microsoft.com/v1.0";
const MSAL_URL = "https://cdn.jsdelivr.net/npm/@azure/msal-browser@3.28.0/lib/msal-browser.min.js";

export const spConfigured = () => {
  const id = CFG().clientId;
  return !!id && !id.startsWith("VUL_");
};

// ---------- inloggen ----------

let msalPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Kon Microsoft-login niet laden (geen internet?)"));
    document.head.append(s);
  });
}

function base() {
  // Map waarin de app staat, bv. https://imetech-engineering.github.io/muzivotheek-pwa/
  return new URL("./", location.href.split("#")[0]).href;
}

export function msal() {
  if (msalPromise) return msalPromise;
  msalPromise = (async () => {
    if (!spConfigured()) throw new Error("SharePoint is nog niet ingesteld (config.js).");
    if (!window.msal) await loadScript(MSAL_URL);
    const app = new window.msal.PublicClientApplication({
      auth: {
        clientId: CFG().clientId,
        authority: CFG().authority || "https://login.microsoftonline.com/common",
        redirectUri: base(),
      },
      cache: { cacheLocation: "localStorage", storeAuthStateInCookie: true },
    });
    await app.initialize();
    const res = await app.handleRedirectPromise();
    if (res && res.account) app.setActiveAccount(res.account);
    else if (!app.getActiveAccount() && app.getAllAccounts()[0]) app.setActiveAccount(app.getAllAccounts()[0]);
    return app;
  })();
  msalPromise.catch(() => (msalPromise = null));
  return msalPromise;
}

export async function account() {
  if (!spConfigured()) return null;
  try {
    return (await msal()).getActiveAccount();
  } catch (e) {
    return null;
  }
}

export async function login() {
  const app = await msal();
  try {
    const r = await app.loginPopup({ scopes: SCOPES, prompt: "select_account", redirectUri: base() + "auth.html" });
    app.setActiveAccount(r.account);
    return r.account;
  } catch (e) {
    if (e && (e.errorCode === "user_cancelled" || e.errorCode === "access_denied")) throw new Error("Inloggen geannuleerd");
    // Pop-ups geblokkeerd (bv. geïnstalleerde app): via doorverwijzen.
    localStorage.setItem("muzi.sp.resume", "1");
    await app.loginRedirect({ scopes: SCOPES, prompt: "select_account" });
    return null;
  }
}

export async function logout() {
  const app = await msal();
  const acc = app.getActiveAccount();
  if (!acc) return;
  // Alleen lokaal afmelden (geen Microsoft-venster).
  await app.clearCache({ account: acc }).catch(() => {});
  app.setActiveAccount(null);
}

// interactive = false: alleen stil (bij opstarten), anders mag er een venster komen.
export async function token(interactive = true) {
  const app = await msal();
  const acc = app.getActiveAccount();
  if (!acc) {
    if (!interactive) return null;
    await login();
    return token(false);
  }
  try {
    return (await app.acquireTokenSilent({ scopes: SCOPES, account: acc })).accessToken;
  } catch (e) {
    if (!interactive) return null;
    return (await app.acquireTokenPopup({ scopes: SCOPES, account: acc, redirectUri: base() + "auth.html" })).accessToken;
  }
}

// ---------- Graph ----------

async function graph(path, tok, extraHeaders = {}) {
  const url = path.startsWith("http") ? path : GRAPH + path;
  const r = await fetch(url, { headers: { Authorization: "Bearer " + tok, ...extraHeaders } });
  if (!r.ok) {
    let msg = "";
    try {
      msg = (await r.json()).error.message;
    } catch (e) {}
    const err = new Error(explain(r.status, msg));
    err.status = r.status;
    throw err;
  }
  return r.json();
}

function explain(status, msg) {
  if (status === 401) return "Niet (meer) ingelogd. Log opnieuw in.";
  if (status === 403) return "Geen toegang tot deze map met dit account.";
  if (status === 404) return "Map niet gevonden. Klopt de link nog?";
  if (status === 429) return "Microsoft vraagt even te wachten. Probeer het zo opnieuw.";
  return msg || "SharePoint gaf fout " + status;
}

// Deellink → id voor /shares (base64url met "u!" ervoor).
export function shareId(link) {
  const b64 = btoa(unescape(encodeURIComponent(link.trim()))).replace(/=+$/, "").replace(/\//g, "_").replace(/\+/g, "-");
  return "u!" + b64;
}

export function looksLikeLink(s) {
  try {
    const u = new URL(s.trim());
    return /sharepoint\.com$|onedrive\.live\.com$|1drv\.ms$|sharepoint\.[a-z]+$/i.test(u.hostname);
  } catch (e) {
    return false;
  }
}

export async function resolveLink(link, tok) {
  const sid = shareId(link);
  const item = await graph(`/shares/${sid}/driveItem?$select=id,name,folder,file,parentReference,webUrl`, tok, { Prefer: "redeemSharingLink" });
  return { sid, item };
}

// Inhoud van een map. Eerst via de drive; lukt dat niet (gastlink), via de deellink.
export async function listChildren(src, itemId, tok) {
  const sel = "$select=id,name,folder,file,size,lastModifiedDateTime,cTag,eTag&$top=999";
  const paths = [`/drives/${src.driveId}/items/${itemId}/children?${sel}`, `/shares/${src.sid}/items/${itemId}/children?${sel}`];
  let lastErr;
  for (const p of paths) {
    try {
      let out = [];
      let page = await graph(p, tok);
      out = out.concat(page.value);
      while (page["@odata.nextLink"]) {
        page = await graph(page["@odata.nextLink"], tok);
        out = out.concat(page.value);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (e.status !== 403 && e.status !== 404) throw e;
    }
  }
  throw lastErr;
}

export const isPdf = (it) => it.file && /\.pdf$/i.test(it.name);

// Alle PDF's onder een map, met pad (voor zoeken en volgen).
export async function listAll(src, itemId, tok, path = [], onProgress) {
  const out = [];
  const kids = await listChildren(src, itemId, tok);
  onProgress && onProgress(path.join(" / ") || src.name);
  for (const k of kids) {
    if (k.folder) out.push(...(await listAll(src, k.id, tok, [...path, k.name], onProgress)));
    else if (isPdf(k)) out.push({ ...k, path });
  }
  return out;
}

async function download(src, itemId, tok) {
  const meta = await graph(`/drives/${src.driveId}/items/${itemId}?$select=id,name,@microsoft.graph.downloadUrl`, tok).catch(() =>
    graph(`/shares/${src.sid}/items/${itemId}?$select=id,name,@microsoft.graph.downloadUrl`, tok)
  );
  const url = meta["@microsoft.graph.downloadUrl"];
  // De downloadlink is vooraf geautoriseerd en werkt zonder token (CORS-veilig).
  const r = url ? await fetch(url) : await fetch(`${GRAPH}/drives/${src.driveId}/items/${itemId}/content`, { headers: { Authorization: "Bearer " + tok } });
  if (!r.ok) throw new Error("Downloaden mislukt (" + r.status + ")");
  const blob = await r.blob();
  return new File([blob], meta.name, { type: "application/pdf" });
}

// ---------- bronnen (gekoppelde SharePoint-mappen) ----------

export async function spSources() {
  return (await db.all("sources")).filter((s) => s.type === "sp");
}

export async function addSource(link) {
  const tok = await token(true);
  const { sid, item } = await resolveLink(link, tok);
  if (!item.folder) throw new Error("Deze link wijst naar een bestand, niet naar een map. Deel de map zelf.");
  const src = {
    id: uid(),
    type: "sp",
    name: item.name,
    link: link.trim(),
    sid,
    driveId: item.parentReference && item.parentReference.driveId,
    itemId: item.id,
    follow: false,
    added: Date.now(),
    lastSync: 0,
  };
  await db.put("sources", src.id, src);
  return src;
}

// Nieuwe deellink voor een bestaande map (de oude link is verlopen of vervangen).
// Nummers, krabbels en "volgen" blijven; zelfde bestanden worden herkend.
export async function relinkSource(src, link) {
  const tok = await token(true);
  const { sid, item } = await resolveLink(link, tok);
  if (!item.folder) throw new Error("Deze link wijst naar een bestand, niet naar een map. Deel de map zelf.");
  Object.assign(src, { name: item.name, link: link.trim(), sid, driveId: item.parentReference && item.parentReference.driveId, itemId: item.id, broken: false });
  await db.put("sources", src.id, src);
  return src;
}

export const saveSource = (src) => db.put("sources", src.id, src);
export const removeSource = (id) => db.del("sources", id);

const srcKey = (src, it) => `sp:${src.driveId}:${it.id}`;

export async function isImported(src, it) {
  return !!(await findBySrc(srcKey(src, it)));
}

// Gekozen bestanden binnenhalen. items: driveItems met .path (submappen).
export async function importItems(src, items, onProgress) {
  const tok = await token(true);
  let added = 0;
  let updated = 0;
  let i = 0;
  for (const it of items) {
    i++;
    onProgress && onProgress(`${i} van ${items.length}: ${it.name}`, i / items.length);
    const key = srcKey(src, it);
    const version = it.cTag || it.eTag || it.lastModifiedDateTime || "";
    const existing = await findBySrc(key);
    if (existing && existing.srcVersion === version) continue;
    const file = await download(src, it.id, tok);
    if (existing) {
      await replaceFile(existing, file, version);
      updated++;
    } else {
      const r = await importPdf(file, { folder: (it.path && it.path[0]) || "", src: key, srcVersion: version });
      if (!r.duplicate) added++;
    }
  }
  return { added, updated };
}

// Bijwerken: gewijzigde nummers vervangen; bij "volgen" ook nieuwe toevoegen.
export async function syncSource(src, { interactive = false, onProgress } = {}) {
  const tok = await token(interactive);
  if (!tok) return { added: 0, updated: 0, needLogin: true };
  let all;
  try {
    all = await listAll(src, src.itemId, tok, [], (p) => onProgress && onProgress("Kijken in " + p));
  } catch (e) {
    if (e.status === 403 || e.status === 404) {
      // Link verlopen of ingetrokken: onthouden, zodat de app om de nieuwe link kan vragen.
      src.broken = true;
      await saveSource(src);
      e.message = `De link van "${src.name}" werkt niet meer. Plak de nieuwe link.`;
    }
    throw e;
  }
  if (src.broken) src.broken = false;
  const todo = [];
  for (const it of all) {
    const existing = await findBySrc(srcKey(src, it));
    const version = it.cTag || it.eTag || it.lastModifiedDateTime || "";
    if (existing ? existing.srcVersion !== version : src.follow) todo.push(it);
  }
  const r = await importItems(src, todo, onProgress);
  src.lastSync = Date.now();
  await saveSource(src);
  return r;
}

export async function syncAllSharePoint(opts = {}) {
  let added = 0;
  let updated = 0;
  let needLogin = false;
  const broken = [];
  if (!spConfigured() || !navigator.onLine) return { added, updated, needLogin, broken };
  const sources = await spSources();
  if (!sources.length) return { added, updated, needLogin, broken };
  for (const src of sources) {
    try {
      const r = await syncSource(src, opts);
      added += r.added;
      updated += r.updated;
      needLogin = needLogin || !!r.needLogin;
    } catch (e) {
      console.warn("SharePoint bijwerken mislukt", src.name, e);
      if (e.status === 401) needLogin = true;
    }
    if (src.broken) broken.push(src);
  }
  return { added, updated, needLogin, broken };
}
