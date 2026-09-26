# Muzivotheek

Bladmuziek-lezer als PWA voor tablet en telefoon. Werkt volledig offline; alle
PDF's, krabbels en afspeellijsten blijven op het apparaat.

## Functies

- **Bibliotheek**: PDF's toevoegen (kiezen, slepen, of *Delen → Muzivotheek* vanuit WhatsApp/mail),
  zoeken, sorteren (titel, componist, map, nieuwste, laatst geopend, meest gespeeld),
  filteren op map en favorieten, lijst- of rasterweergave.
- **Lezer**: volledig scherm, scherm blijft aan, één/twee pagina's of doorlopend scrollen,
  halve pagina omslaan, witte randen automatisch wegsnijden, nachtstand, knijpen/dubbeltik om te zoomen.
- **Omslaan**: tik rechts/links, vegen, bluetooth-pedaal (PageUp/PageDown/pijltjes), auto-scroll.
- **Krabbels**: pen, markeerstift, tekens (p, mf, ♯, ♭, 𝄐, …), eigen tekst, gum, ongedaan maken.
- **Bladwijzers en sprongen**: sprong-knopjes op de pagina voor herhalingen/D.S./coda, met *Terug*.
- **Afspeellijsten**: maken, volgorde slepen, kopiëren; spelen loopt door naar het volgende nummer.
- **Metronoom** (ook in de lezer, tempo per nummer bewaard) en **stemapparaat** (C/B♭/E♭/F).
- **Audio bij een nummer** met A-B herhaling en tempo 50-125%.
- **Back-up** als .zip (delen naar Drive/OneDrive) en terugzetten.

## Structuur

```
pwa/                 statische site (GitHub Pages)
  index.html
  css/app.css
  js/                app.js (schermen), viewer.js (lezer), library.js, setlists.js,
                     ink.js (krabbels), pdf.js, db.js (IndexedDB), backup.js,
                     metronome.js, tuner.js, settings.js, ui.js, icons.js
  vendor/pdfjs/      pdf.js 4.10.38 (legacy build, Apache-2.0)
  service-worker.js  offline-cache + share target
.github/workflows/deploy.yml
```

Geen build-stap. Lokaal draaien: `cd pwa && python3 -m http.server 8000`.

## Publiceren

Push naar `main`. Eenmalig: **Settings → Pages → Source: GitHub Actions**.

Updates gaan vanzelf: bij publiceren wordt `__BUILD__` in `service-worker.js`
en `js/update.js` vervangen door datum + commit. De app controleert bij openen,
bij terugkeren en elk half uur, en toont dan *Nieuwe versie beschikbaar →
Bijwerken*. Terwijl de lezer open is wacht de melding tot je hem sluit.
Handmatig kan via Instellingen → *Controleren op updates*.
