// Afspeellijsten: geordende lijsten met nummers.

import { db, uid } from "./db.js";

export async function allSetlists() {
  const lists = await db.all("setlists");
  return lists.sort((a, b) => (b.updated || 0) - (a.updated || 0));
}

export const getSetlist = (id) => db.get("setlists", id);

export async function saveSetlist(list) {
  list.updated = Date.now();
  await db.put("setlists", list.id, list);
  document.dispatchEvent(new CustomEvent("setlists"));
  return list;
}

export function newSetlist(name) {
  return saveSetlist({ id: uid(), name, songIds: [], created: Date.now(), date: "", notes: "" });
}

export async function deleteSetlist(id) {
  await db.del("setlists", id);
  document.dispatchEvent(new CustomEvent("setlists"));
}

export async function duplicateSetlist(id) {
  const src = await getSetlist(id);
  if (!src) return null;
  return saveSetlist({ ...src, id: uid(), name: src.name + " (kopie)", created: Date.now() });
}

export async function addToSetlist(id, songIds) {
  const list = await getSetlist(id);
  if (!list) return;
  list.songIds.push(...songIds);
  return saveSetlist(list);
}
