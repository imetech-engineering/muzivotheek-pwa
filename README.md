# Muzivotheek

Bladmuziek-lezer als PWA voor tablet en telefoon. Werkt volledig offline; alle
PDF's, krabbels en afspeellijsten blijven op het apparaat.

## Functies

- **Bibliotheek**: PDF's toevoegen (kiezen, slepen, *Delen → Muzivotheek* vanuit WhatsApp/mail, of een
  hele map; op de computer blijft een gekoppelde map automatisch bijgewerkt, submap = Map),
  zoeken, sorteren (titel, componist, map, nieuwste, laatst geopend, meest gespeeld),
  filteren op map en favorieten, lijst- of rasterweergave.
- **Lezer**: volledig scherm, scherm blijft aan, één/twee/automatisch pagina's of doorlopend scrollen,
  halve pagina omslaan (volgorde instelbaar), witte randen wegsnijden, nachtstand.
  Zoomen via één camera-transform: knijpen, twee vingers schuiven, dubbeltik; niets verspringt.
- **Omslaan**: tik rechts/links, vegen, bluetooth-pedaal (PageUp/PageDown/pijltjes), auto-scroll.
- **Krabbels**: pen, markeerstift, muzieksymbolen (Noto Music, OFL) met instelbare grootte,
  verslepen, eigen tekst, gum, ongedaan maken.
- **Bladwijzers en sprongen**: sprong-knopjes op de pagina voor herhalingen/D.S./coda, met *Terug*.
- **Afspeellijsten**: maken, volgorde slepen, kopiëren; spelen loopt door naar het volgende nummer.
- **Metronoom** (ook in de lezer, tempo per nummer bewaard) en **stemapparaat** (C/B♭/E♭/F).
- **Meespelen**: opname (mp3) of YouTube-link per nummer, met A-B herhalen, ±10 s en tempo.
  YouTube via de officiële speler (youtube-nocookie), alleen met internet.
- **Back-up** als .zip (delen naar Drive/OneDrive) en terugzetten.
- **SharePoint**: link van een gedeelde map plakken, inloggen met Microsoft, door submappen
  bladeren, zoeken, nummers aanvinken. Een map *volgen* = nieuwe/gewijzigde nummers komen er
  bij het openen vanzelf bij. Krabbels en gegevens blijven bij een nieuwe versie behouden.

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

## SharePoint instellen (eenmalig)

De app gebruikt de officiële Microsoft Graph-koppeling. Daarvoor is één
app-registratie nodig:

1. Ga naar <https://entra.microsoft.com> → **Applicaties → App-registraties → Nieuwe registratie**.
2. Naam: `Muzivotheek`.
3. Ondersteunde accounttypen: **Accounts in elke organisatiedirectory en persoonlijke
   Microsoft-accounts** (dan kunnen ook leden van andere organisaties inloggen).
4. Omleidings-URI: platform **Single-page application (SPA)**, adres
   `https://imetech-engineering.github.io/muzivotheek-pwa/` → **Registreren**.
5. Bij **Verificatie** een tweede SPA-omleidings-URI toevoegen:
   `https://imetech-engineering.github.io/muzivotheek-pwa/auth.html`.
6. Bij **API-machtigingen** → **Machtiging toevoegen** → Microsoft Graph → **Gedelegeerde
   machtigingen** → `Files.Read.All` (User.Read staat er al).
7. Kopieer de **Toepassings-id (client)** van de overzichtspagina naar `pwa/config.js`.

Zolang `config.js` geen client-id heeft, is SharePoint in de app verborgen.
Leden hebben een Microsoft-account nodig met toegang tot de gedeelde map. Blokkeert
een organisatie toestemming door gebruikers, dan moet een beheerder daar eenmalig
toestemming geven.
