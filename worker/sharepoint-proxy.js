// Muzivotheek SharePoint-tussenservice (Cloudflare Worker).
//
// Opent een SharePoint-deellink van het type "Iedereen met de link" zoals een
// browser dat doet (zonder account) en geeft de app:
//   GET /list?link=<deellink>[&path=<map>]  -> inhoud van de map (JSON)
//   GET /file?link=<deellink>&path=<bestand> -> het bestand (PDF)
//   GET /check?link=<deellink>               -> controle: wat er gebeurt (voor hulp bij problemen)
//
// Alleen lezen. Er wordt niets bewaard behalve een tijdelijke sessie in het
// geheugen. Alleen *.sharepoint.com-links en alleen verzoeken van de app.

const ALLOWED_ORIGINS = [
  "https://imetech-engineering.github.io",
  "http://localhost:8765",
  "http://localhost:8000",
];
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const SESSION_MS = 20 * 60 * 1000;
const sessions = new Map(); // link -> { cookie, origin, web, root, name, t }

export default {
  async fetch(req) {
    const origin = req.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Max-Age": "86400",
      Vary: "Origin",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(req.url);
    const json = (o, status = 200) => new Response(JSON.stringify(o, null, url.pathname === "/check" ? 2 : 0), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

    // Van een andere website dan de app? Weigeren (de controlepagina mag wel, voor hulp).
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Niet toegestaan" }, 403);

    const link = (url.searchParams.get("link") || "").trim();
    if (url.pathname === "/" || !link) return json({ ok: true, info: "Muzivotheek SharePoint-tussenservice. Gebruik /check?link=<deellink> om een link te testen." });
    let host;
    try {
      host = new URL(link).hostname;
    } catch (e) {
      return json({ error: "Ongeldige link" }, 400);
    }
    if (!/\.sharepoint\.com$/i.test(host)) return json({ error: "Alleen SharePoint-links" }, 400);

    try {
      if (url.pathname === "/check") return json(await check(link));
      const s = await session(link);
      const path = url.searchParams.get("path") || s.root;
      // Alleen binnen de gedeelde map blijven.
      if (!(path === s.root || path.startsWith(s.root + "/"))) return json({ error: "Buiten de gedeelde map" }, 403);

      if (url.pathname === "/list") return json(await list(s, path));
      if (url.pathname === "/file") {
        const r = await download(s, path);
        return new Response(r.body, {
          headers: { ...cors, "Content-Type": r.headers.get("Content-Type") || "application/pdf", "Cache-Control": "no-store" },
        });
      }
      return json({ error: "Onbekend verzoek" }, 404);
    } catch (e) {
      if (e.code === "login") return json({ error: "Deze link vraagt om inloggen. Deel de map met 'Iedereen met de link'.", needLogin: true }, 401);
      if (e.code === "gone") sessions.delete(link);
      return json({ error: e.message, expired: e.code === "gone" }, e.status || 502);
    }
  },
};

class Fail extends Error {
  constructor(msg, code, status) {
    super(msg);
    this.code = code;
    this.status = status;
  }
}

function setCookies(headers) {
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  if (typeof headers.getAll === "function") return headers.getAll("Set-Cookie");
  const one = headers.get("Set-Cookie");
  return one ? [one] : [];
}

function cookieHeader(jar) {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

// Link openen en redirects volgen, cookies verzamelen (zoals een browser).
async function follow(link, trace) {
  const jar = {};
  let url = link;
  let final = null;
  for (let i = 0; i < 12; i++) {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA, Accept: "text/html", Cookie: cookieHeader(jar) } });
    for (const sc of setCookies(r.headers)) {
      const kv = sc.split(";")[0];
      const eq = kv.indexOf("=");
      if (eq > 0) jar[kv.slice(0, eq).trim()] = kv.slice(eq + 1);
    }
    const loc = r.headers.get("Location");
    trace && trace.push({ url: url.replace(/([?&](e|share|at)=)[^&]+/g, "$1…"), status: r.status, cookies: Object.keys(jar) });
    if (r.status >= 300 && r.status < 400 && loc) {
      url = new URL(loc, url).href;
      continue;
    }
    final = { url, status: r.status, html: r.status === 200 ? (await r.text()).slice(0, 200000) : "" };
    break;
  }
  if (!final) throw new Fail("Te veel doorverwijzingen", "redirect", 502);
  const u = new URL(final.url);
  if (/^login\.|login\.microsoftonline/.test(u.hostname) || /\/_forms\/|authorize/i.test(u.pathname)) throw new Fail("Inloggen vereist", "login", 401);
  if (final.status === 404 || final.status === 403) throw new Fail("Link verlopen of ingetrokken", "gone", 404);
  return { jar, final };
}

// Pad van de gedeelde map uit de eind-URL of de pagina halen.
function folderPath(final) {
  const u = new URL(final.url);
  let p = u.searchParams.get("id") || u.searchParams.get("RootFolder");
  if (!p) {
    const m = final.html.match(/"rootFolder"\s*:\s*"([^"]+)"/) || final.html.match(/[?&]id=(%2F[^"&']+)/);
    if (m) p = m[1].includes("%2F") ? decodeURIComponent(m[1]) : m[1].replace(/\\u002f/gi, "/");
  }
  return p ? p.replace(/\/$/, "") : null;
}

function webFromPath(origin, p) {
  const seg = p.split("/");
  if (["sites", "teams", "personal"].includes(seg[1])) return `${origin}/${seg[1]}/${seg[2]}`;
  return origin;
}

async function session(link) {
  const hit = sessions.get(link);
  if (hit && Date.now() - hit.t < SESSION_MS) return hit;
  const { jar, final } = await follow(link);
  const root = folderPath(final);
  if (!root) throw new Fail("Kon de map in deze link niet vinden. Is het een link naar een map?", "nofolder", 422);
  const origin = new URL(final.url).origin;
  const s = { cookie: cookieHeader(jar), origin, web: webFromPath(origin, root), root, name: decodeURIComponent(root.split("/").pop()), t: Date.now() };
  sessions.set(link, s);
  return s;
}

const q = (s) => encodeURIComponent(s.replace(/'/g, "''"));

async function sp(s, url, init = {}) {
  const r = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, Accept: "application/json;odata=nometadata", Cookie: s.cookie, ...(init.headers || {}) },
    redirect: "manual",
  });
  if (r.status === 302 || r.status === 401) throw new Fail("Sessie verlopen", "gone", 404);
  return r;
}

// Inhoud van een map: eerst de eenvoudige REST-vraag, anders zoals de SharePoint-website zelf.
async function list(s, path) {
  let r = await sp(s, `${s.web}/_api/web/GetFolderByServerRelativePath(decodedurl='${q(path)}')?$expand=Folders,Files&$select=Name,ServerRelativeUrl,Folders/Name,Folders/ServerRelativeUrl,Folders/ItemCount,Files/Name,Files/ServerRelativeUrl,Files/Length,Files/TimeLastModified,Files/ETag`);
  if (r.ok) {
    const d = await r.json();
    return {
      name: d.Name,
      path,
      folders: (d.Folders || []).filter((f) => f.Name !== "Forms").map((f) => ({ name: f.Name, path: f.ServerRelativeUrl })),
      files: (d.Files || []).map((f) => ({ name: f.Name, path: f.ServerRelativeUrl, size: +f.Length || 0, modified: f.TimeLastModified, etag: f.ETag || f.TimeLastModified })),
      via: "rest",
    };
  }
  const restStatus = r.status;
  // Terugval: RenderListDataAsStream (werkt vaak wel voor gastlinks).
  const digest = await formDigest(s);
  const seg = path.split("/");
  const listUrl = ["sites", "teams", "personal"].includes(seg[1]) ? seg.slice(0, 4).join("/") : seg.slice(0, 2).join("/");
  r = await sp(s, `${s.web}/_api/web/GetListUsingPath(DecodedUrl=@a1)/RenderListDataAsStream?@a1='${q(listUrl)}'&RootFolder=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json;odata=nometadata", Accept: "application/json;odata=nometadata", ...(digest ? { "X-RequestDigest": digest } : {}) },
    body: JSON.stringify({ parameters: { RenderOptions: 2, AllowMultipleValueFilterForTaxonomyFields: true, AddRequiredFields: true, ViewXml: "<View><RowLimit Paged=\"TRUE\">5000</RowLimit></View>" } }),
  });
  if (!r.ok) throw new Fail(`SharePoint weigert de map te tonen (${restStatus}/${r.status})`, r.status === 404 ? "gone" : "list", r.status === 404 ? 404 : 502);
  const d = await r.json();
  const rows = d.Row || (d.ListData && d.ListData.Row) || [];
  return {
    name: decodeURIComponent(path.split("/").pop()),
    path,
    folders: rows.filter((x) => String(x.FSObjType) === "1").map((x) => ({ name: x.FileLeafRef, path: x.FileRef })),
    files: rows.filter((x) => String(x.FSObjType) !== "1").map((x) => ({ name: x.FileLeafRef, path: x.FileRef, size: +(x.File_x0020_Size || x.SMTotalFileStreamSize || 0), modified: x["Modified."] || x.Modified, etag: x._UIVersionString || x["Modified."] || x.Modified })),
    via: "stream",
  };
}

async function formDigest(s) {
  try {
    const r = await sp(s, `${s.web}/_api/contextinfo`, { method: "POST", headers: { Accept: "application/json;odata=nometadata" } });
    if (!r.ok) return null;
    return (await r.json()).FormDigestValue || null;
  } catch (e) {
    return null;
  }
}

async function download(s, path) {
  let r = await sp(s, `${s.web}/_api/web/GetFileByServerRelativePath(decodedurl='${q(path)}')/$value`, { headers: { Accept: "*/*" } });
  if (r.ok) return r;
  r = await sp(s, `${s.web}/_layouts/15/download.aspx?SourceUrl=${encodeURIComponent(path)}`, { headers: { Accept: "*/*" } });
  if (r.ok) return r;
  throw new Fail("Downloaden mislukt (" + r.status + ")", r.status === 404 ? "gone" : "download", r.status === 404 ? 404 : 502);
}

// Controlepagina: laat stap voor stap zien wat er gebeurt.
async function check(link) {
  const out = { link: link.replace(/([?&](e|at)=)[^&]+/g, "$1…"), steps: [] };
  try {
    const trace = [];
    const { jar, final } = await follow(link, trace);
    out.redirects = trace;
    out.finalUrl = final.url.replace(/([?&](e|share|at)=)[^&]+/g, "$1…");
    const root = folderPath(final);
    out.folder = root;
    if (!root) {
      out.steps.push("Map niet gevonden in de pagina");
      out.pageStart = final.html.slice(0, 1500);
      return out;
    }
    const origin = new URL(final.url).origin;
    const s = { cookie: cookieHeader(jar), origin, web: webFromPath(origin, root), root, t: Date.now() };
    out.web = s.web;
    const l = await list(s, root);
    out.listedVia = l.via;
    out.folders = l.folders.map((f) => f.name);
    out.files = l.files.slice(0, 20).map((f) => f.name);
    const pdf = l.files.find((f) => /\.pdf$/i.test(f.name));
    if (pdf) {
      const r = await download(s, pdf.path);
      out.download = { name: pdf.name, status: r.status, type: r.headers.get("Content-Type") };
    }
    out.ok = true;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    out.code = e.code;
  }
  return out;
}
