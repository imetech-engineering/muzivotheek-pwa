# SharePoint-tussenservice (Cloudflare Worker)

Hiermee kunnen muzikanten zonder Microsoft-account nummers halen uit een SharePoint-map
die gedeeld is met **"Iedereen met de link"**. De Worker opent de link zoals een browser
dat doet, geeft de app de inhoud van de map en de PDF's, en bewaart niets. Alleen lezen,
alleen `*.sharepoint.com`, alleen verzoeken vanaf de Muzivotheek-app.

## Eenmalig plaatsen (± 10 minuten, gratis)

1. Maak een gratis account op <https://dash.cloudflare.com/sign-up>.
2. Kies links **Workers & Pages** → **Maken** → **Worker maken**.
   Naam: `muzivotheek` → **Implementeren**.
3. Klik **Code bewerken**. Haal alle voorbeeldcode weg en plak de inhoud van
   [`sharepoint-proxy.js`](https://raw.githubusercontent.com/imetech-engineering/muzivotheek-pwa/main/worker/sharepoint-proxy.js).
   Klik **Implementeren**.
4. Kopieer het adres bovenin, bijvoorbeeld `https://muzivotheek.<jouwnaam>.workers.dev`,
   en zet het in `pwa/config.js` bij `proxyUrl`.

## Automatisch bijwerken vanuit GitHub (aanrader)

Dan hoef je nooit meer code te plakken: elke wijziging in `worker/` wordt vanzelf
gepubliceerd.

1. Cloudflare: rechtsboven je profiel → **Profile** → **API Tokens** → **Create Token** →
   bij *Edit Cloudflare Workers* op **Use template** → **Continue to summary** →
   **Create Token**. Kopieer de sleutel.
2. GitHub: repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**. Naam: `CLOUDFLARE_API_TOKEN`, waarde: de sleutel → **Add secret**.

## Code plakken (handmatig)

Plak [`dist/muzivotheek-worker.min.js`](https://raw.githubusercontent.com/imetech-engineering/muzivotheek-pwa/main/worker/dist/muzivotheek-worker.min.js)
(één regel, korter en makkelijker te kopiëren dan de leesbare versie).
Na elke wijziging aan `sharepoint-proxy.js`: `npx esbuild sharepoint-proxy.js --minify --format=esm --outfile=dist/muzivotheek-worker.min.js`.

## Link testen

Open in een browser:

```
https://muzivotheek.<jouwnaam>.workers.dev/check?link=<de SharePoint-link>
```

Je ziet stap voor stap wat er gebeurt. `"ok": true` = alles werkt. Anders staat bij
`error` wat er mis is (bijvoorbeeld dat de link om inloggen vraagt).

## Voorwaarden

- De map moet gedeeld zijn met **Iedereen met de link**. Test: open de link in een
  privévenster; vraagt hij om in te loggen, dan werkt het niet zonder account.
- Sommige organisaties hebben "Iedereen"-links uitgeschakeld. Dan kan alleen de route
  met inloggen (Microsoft-account).
- Gratis Cloudflare-abonnement: 100.000 verzoeken per dag, ruim genoeg.
- Werkt dit ooit niet meer omdat Microsoft iets aan SharePoint verandert: de app valt
  terug op inloggen met een Microsoft-account.
