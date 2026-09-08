# Franco Invest — proxy dedicato (opzionale)

La piattaforma funziona **senza** questo worker: usa i proxy pubblici
(allorigins / codetabs / corsproxy) per i prezzi intraday e la chiave Groq
resta nel file locale `portfolio-local-config.js`.

Questo worker serve a:

1. **Togliere la dipendenza dai proxy pubblici** (lenti e a volte offline) per le
   quotazioni live e lo scraping di Borsa Italiana.
2. **Spostare la chiave Groq lato server**, così non sta più in chiaro in un file.

## Deploy (Cloudflare, piano gratuito)

Serve un account Cloudflare (gratis) e Node installato.

```bash
cd worker
npx wrangler login
npx wrangler secret put GROQ_API_KEY   # incolla la chiave gsk_... quando richiesto
npx wrangler deploy
```

Al termine `wrangler` stampa l'URL del worker, tipo:

```
https://franco-invest-proxy.<tuo-subdominio>.workers.dev
```

## Collegare la piattaforma al worker

In **`portfolio-shared-config.js`** (che viene deployato) aggiungi:

```js
window.PORTFOLIO_DESK_SECRETS.proxyBase = 'https://franco-invest-proxy.<tuo-subdominio>.workers.dev';
```

Fatto questo:

- i prezzi live e lo scraping passano dal worker (con fallback ai proxy pubblici
  se il worker non risponde);
- le richieste Groq vanno a `<proxyBase>/groq` e il browser **non** invia più la
  chiave. A quel punto puoi togliere `groqApiKey` da `portfolio-local-config.js`.

Se un giorno vuoi un endpoint Groq diverso da `<proxyBase>/groq`:

```js
window.PORTFOLIO_DESK_SECRETS.groqProxy = 'https://.../groq';
```

## Endpoint esposti

| Metodo | Path                     | Uso                                             |
|--------|--------------------------|-------------------------------------------------|
| GET    | `/fetch?url=<URL>`       | proxy generico (solo host Yahoo / Borsa Italiana)|
| GET    | `/quote?symbol=<SYM>`    | chart Yahoo per un simbolo                       |
| POST   | `/groq`                  | inoltro a Groq con chiave lato server            |
