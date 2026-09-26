// Mappen op het apparaat koppelen.
//
// Computer (Chrome/Edge): map één keer kiezen, daarna bij elke start
// automatisch nieuwe en gewijzigde PDF's ophalen (ook uit submappen).
// Tablet/telefoon: de browser geeft geen blijvende toegang tot een map; daar
// kun je een map in één keer importeren. Submap = "Map" in de bibliotheek.

import { db, uid } from "./db.js";
import { importPdf, findBySrc, replaceFile } from "./library.js";

export const canLinkFolder = () => "showDirectoryPicker" in window;

export async function folderSources() {
  return (await db.all("sources")).filter((s) => s.type === "dir");
}

export async function linkFolder() {
  const handle = await window.showDirectoryPicker({ id: "muzivotheek", mode: "read" });
  const src = { id: uid(), type: "dir", name: handle.name, handle, added: Date.now(), lastSync: 0 };
  await db.put("sources", src.id, src);
  return src;
}

export async function unlinkFolder(id) {
  await db.del("sources", id);
}

async function* walk(dir, path = []) {
  for await (const entry of dir.values()) {
    if (entry.kind === "directory") yield* walk(entry, [...path, entry.name]);
    else if (/\.pdf$/i.test(entry.name)) yield { entry, path };
  }
}

// Map doorlopen. onProgress(tekst). Geeft {added, updated}.
export async function syncFolder(src, onProgress) {
  let added = 0;
  let updated = 0;
  for await (const { entry, path } of walk(src.handle)) {
    const file = await entry.getFile();
    const key = `dir:${src.id}:${[...path, entry.name].join("/")}`;
    const version = `${file.size}:${file.lastModified}`;
    const existing = await findBySrc(key);
    if (existing) {
      if (existing.srcVersion !== version) {
        onProgress && onProgress(`Bijwerken: ${entry.name}`);
        await replaceFile(existing, file, version);
        updated++;
      }
      continue;
    }
    onProgress && onProgress(`Toevoegen: ${entry.name}`);
    const r = await importPdf(file, { folder: path[0] || "", src: key, srcVersion: version });
    if (!r.duplicate) added++;
  }
  src.lastSync = Date.now();
  await db.put("sources", src.id, src);
  return { added, updated };
}

// Bij het starten: alle mappen waar we nog toegang toe hebben bijwerken.
// Mappen die opnieuw toestemming nodig hebben worden teruggegeven.
export async function syncAllFolders(onProgress) {
  const needPermission = [];
  let added = 0;
  let updated = 0;
  for (const src of await folderSources()) {
    try {
      const perm = await src.handle.queryPermission({ mode: "read" });
      if (perm !== "granted") {
        needPermission.push(src);
        continue;
      }
      const r = await syncFolder(src, onProgress);
      added += r.added;
      updated += r.updated;
    } catch (e) {
      console.warn("map bijwerken mislukt", src.name, e);
    }
  }
  return { added, updated, needPermission };
}

// Na een tik (vereist door de browser) opnieuw toestemming vragen en bijwerken.
export async function regrantAndSync(sources, onProgress) {
  let added = 0;
  let updated = 0;
  for (const src of sources) {
    if ((await src.handle.requestPermission({ mode: "read" })) !== "granted") continue;
    const r = await syncFolder(src, onProgress);
    added += r.added;
    updated += r.updated;
  }
  return { added, updated };
}

// Tablet/telefoon: hele map in één keer kiezen (geen blijvende koppeling).
export function pickFolderOnce() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.webkitdirectory = true;
    input.hidden = true;
    input.onchange = () => {
      const files = [...input.files]
        .filter((f) => /\.pdf$/i.test(f.name))
        .map((f) => {
          const parts = (f.webkitRelativePath || f.name).split("/");
          // parts[0] is de gekozen map zelf; de eerste submap wordt de "Map".
          return { file: f, folder: parts.length > 2 ? parts[1] : "" };
        });
      input.remove();
      resolve(files);
    };
    document.body.append(input);
    input.click();
  });
}

export const canPickFolderOnce = () => "webkitdirectory" in document.createElement("input");
