# MuzIVOtheek

Bladmuziek-lezer als PWA voor tablet en telefoon. Werkt volledig offline; alle
PDF's, krabbels en afspeellijsten blijven op het apparaat.

## Functies

- **Herkennen**: titel, componist, arrangeur en partij uit de bestandsnaam ("01 Titel - Componist - 2e Cornet"),
  daarna uit de tekst in de PDF, en bij scans/foto's met OCR (tesseract.js, in de browser, eenmalig ± 9 MB,
  daarna offline). Zelf ingevulde velden worden nooit overschreven.
- **Foto's** (JPG/PNG) worden bij het toevoegen een PDF; meerdere foto's kunnen samen één nummer worden.
- **Scannen met telefoon**: tablet met een slechte camera? *+ → Scannen met telefoon* toont een QR-code.
  Scan die met de telefoon, maak daar foto's (camera of *Uit galerij*); ze worden automatisch bijgesneden,
  rechtgetrokken en verbeterd, je controleert het resultaat en verstuurt het naar de tablet. Ook via *Pagina's toevoegen* bij een bestaand nummer. Zie hieronder.
- **Bibliotheek**: PDF's toevoegen (kiezen, slepen, *Delen → Muzivotheek* vanuit WhatsApp/mail, of een
  hele map; op de computer blijft een gekoppelde map automatisch bijgewerkt, submap = Map),
  zoeken, sorteren (titel, componist, map, nieuwste, laatst geopend, meest gespeeld),
  filteren op map en favorieten, lijst- of rasterweergave.
- **Lezer**: volledig scherm, scherm blijft aan, één/twee/automatisch pagina's of doorlopend scrollen,
  halve pagina omslaan (volgorde instelbaar), witte randen wegsnijden, nachtstand.
  Zoomen via één camera-transform: knijpen, twee vingers schuiven, dubbeltik; niets verspringt.
- **Omslaan**: tik rechts/links, vegen, bluetooth-pedaal (PageUp/PageDown/pijltjes), of gewoon scrollen (optioneel schermbreed).
- **Krabbels**: pen, markeerstift, muzieksymbolen (Noto Music, OFL) met instelbare grootte
  (crescendo/decrescendo ook langer te slepen over meerdere maten, zonder dat ze hoger worden),
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
  scan.html          telefoonpagina voor "Scannen met telefoon"
  vendor/peerjs/     PeerJS 1.5.5 (MIT), vendor/qrcode/ qrcode-generator 2.0.4 (MIT)
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

## Scannen met telefoon

De telefoon opent `scan.html#<code>` (via de QR-code) in de browser; installeren is niet nodig.
Foto's worden op de telefoon verkleind (max. 2600 px) en rechtstreeks naar de tablet gestuurd
via WebRTC ([PeerJS](https://peerjs.com), `vendor/peerjs`, MIT). De tablet bewaart ze; de telefoon
toont wat de tablet heeft, dus opnieuw verbinden na de camera-app gaat vanzelf goed.

- **Koppelen** gaat één keer via de gratis PeerJS-koppelserver (`0.peerjs.com`); de foto's zelf gaan
  direct van apparaat naar apparaat (zelfde wifi), of via de PeerJS-relay als dat niet lukt.
  Er wordt niets bewaard. Beide apparaten hebben internet nodig voor het koppelen.
- **Eigen koppelserver** (als de gratis server ooit hapert): zet vóór het laden
  `window.MUZI_PEER = { host, port, path, secure }` (bijv. in `config.js`). Zie `js/phonelink.js`.
- **Testen** lokaal: `npx peerjs --port 9000` en `window.MUZI_PEER = {host:"127.0.0.1", port:9000, path:"/", secure:false}`.
- **Camera in de pagina** (`js/scancam.js`): Chrome blijft actief (met de losse camera-app kan Android
  Chrome wegens geheugengebrek afsluiten). Grote foto's worden direct verkleind gedecodeerd.
- **Scannen** (`js/docscan.js`, `js/scanedit.js`, OpenCV.js 4.12 in `vendor/opencv`, Apache-2.0): in de
  camera toont een roze kader live welk blad gevonden wordt. Na elke foto: automatisch bijsnijden,
  rechttrekken, papier wit maken (delen door de geschatte achtergrond) en verbeteren, en dan het resultaat
  controleren in het gewone aanpasscherm (knijpen/dubbeltik = inzoomen; *Klaar* of terug = naar de tablet,
  prullenbak = weggooien, *Opnieuw* = nieuwe foto). Aanpassen kan
  daar en later (tik op een pagina): hoeken en hele zijkanten (met vergrootglas), draaien, filter *Zwart-wit* of *Grijs*,
  schuifje *Schoner ⟷ Meer details*, *Spikkels weg* (losse vlekjes kleiner dan ± 3 px worden wit; noten
  en staccato-punten blijven) en *Kromming weg* (gebogen blad rechttrekken). De laatste keuzes gelden voor de volgende foto's. Laatste
  scan linksonder in de camera. OpenCV (± 3,5 MB over de lijn) wordt alleen op de telefoon geladen en
  daar apart gecachet (`muzi-opencv-*`).
- **Blad zoeken** (`detectQuad`, `detectQuadBest`): eerst op klein formaat (zelfde als het live kader),
  pas daarna groter; van de gevonden vierhoeken wint die met de lichtste rand binnen t.o.v. erbuiten
  (papier op een donkerdere ondergrond), zodat een patroon in een kleed of tafel niet wint. Lukt het
  op de foto niet, dan geldt het kader dat live in beeld was.
- **Kromming weg** (`dewarp` in `js/docscan.js`): de notenbalken horen recht te lopen. Het blad wordt in
  staande stroken geknipt; per strook wordt gemeten hoeveel het lijnenpatroon verschuift t.o.v. de
  buurstrook, dat wordt per hoogte glad gemaakt (kromme graad 3) en de pixels worden teruggeschoven.
- **Scherm aan**: tablet en telefoon houden het scherm aan zolang scannen open is (wake lock). Valt de
  tablet toch even uit, dan blijft de telefoon proberen en worden wachtende foto's daarna verstuurd.
- Code: `js/phonecam.js` (tablet), `js/scan.js` + `scan.html` (telefoon), `js/phonelink.js` (gedeeld),
  QR-code met `vendor/qrcode` (MIT).

## SharePoint zonder account

Voor links "Iedereen met de link" haalt de app de map op via een kleine gratis
tussenservice (Cloudflare Worker, map `worker/`). Geen login en geen beheerder nodig.
Plaatsen: zie [`worker/README.md`](worker/README.md), daarna het adres in `pwa/config.js`
bij `proxyUrl`. Links die om inloggen vragen, gaan via de Microsoft-route hieronder.

## SharePoint met Microsoft-account (eenmalig instellen)

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
6. (Optioneel) Bij **API-machtigingen** `Files.Read.All` toevoegen. Niet nodig: de app vraagt
   dit leesrecht zelf aan bij het inloggen.
7. Kopieer de **Toepassings-id (client)** van de overzichtspagina naar `pwa/config.js`.

De app vraagt alleen **leesrechten**: er wordt nooit iets naar SharePoint geschreven. Krabbels,
bladwijzers en lijsten blijven op het apparaat.

**Toestemming bij andere organisaties.** Microsoft laat gebruikers van een *andere* organisatie
geen toestemming geven aan een nieuwe multi-tenant app van een niet-geverifieerde uitgever.
Staat de SharePoint in de Microsoft-omgeving van de vereniging, dan moet hun beheerder eenmalig
toestemming geven via
`https://login.microsoftonline.com/<tenant-id-vereniging>/adminconsent?client_id=<client-id>`.
Alternatief: dezelfde app-registratie in hún omgeving aanmaken en die client-id gebruiken.

**Nieuwe deellinks.** Wordt er een nieuwe link gedeeld, plak die dan bij *+ → Uit SharePoint* of
deel hem vanuit WhatsApp naar Muzivotheek; de app vraagt of het de nieuwe link van een bestaande
map is. Werkt een oude link niet meer, dan meldt de bibliotheek dat. Nummers en krabbels blijven.

Zolang `config.js` geen client-id heeft, is SharePoint in de app verborgen.
Leden hebben een Microsoft-account nodig met toegang tot de gedeelde map. Blokkeert
een organisatie toestemming door gebruikers, dan moet een beheerder daar eenmalig
toestemming geven.
