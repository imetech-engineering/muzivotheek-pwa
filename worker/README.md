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
