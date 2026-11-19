// Sneltoets: één nummer dat altijd bovenin staat (bibliotheek en lezer).
// Het nummer-id staat in de instellingen (quickSong); bestaat het nummer niet
// meer, dan blijft de knop verborgen.

import { getSong } from "./library.js";
import { settings } from "./settings.js";

// Knop in de app-kop bijwerken (zichtbaar + titel als tooltip).
export async function refreshQuick() {
  const b = document.getElementById("quick-btn");
  if (!b) return;
  const id = settings().quickSong;
  const song = id ? await getSong(id) : null;
  b.hidden = !song;
  const label = song ? "Sneltoets: " + song.title : "Sneltoets";
  b.title = label;
  b.setAttribute("aria-label", label);
}
