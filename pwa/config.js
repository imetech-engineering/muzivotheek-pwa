// Instellingen voor de koppeling met SharePoint (Microsoft Graph).
// De client-id is geen geheim en mag in de openbare repo staan.
// Hoe je hem krijgt: zie README, kopje "SharePoint instellen".
window.MUZI_CONFIG = {
  clientId: "2fbb60d6-bedb-41d5-aac8-891d096219ca",
  // "common" = inloggen met werk-/schoolaccounts van elke organisatie én
  // persoonlijke Microsoft-accounts.
  authority: "https://login.microsoftonline.com/common",
  // Adres van de tussenservice (Cloudflare Worker, zie worker/README.md). Hiermee
  // werken links "Iedereen met de link" zonder account. Leeg = alleen via inloggen.
  proxyUrl: "",
};
