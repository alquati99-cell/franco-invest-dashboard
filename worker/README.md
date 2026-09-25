# Franco Invest — proxy dedicato

**Già deployato** su `https://franco-invest-proxy.alquati99.workers.dev` e collegato:
- in `portfolio-shared-config.js` (`window.PORTFOLIO_DESK_SECRETS.proxyBase`) per le
  quotazioni live nel browser;
- come variabile del repo `PROXY_BASE` (Settings → Secrets and variables → Actions →
  Variables) per lo script `scripts/update-prices.mjs`, che così risolve anche i
  fondi (ricerca ISIN → simbolo Yahoo) e i titoli esteri dai runner GitHub, che
  altrimenti Yahoo blocca.

Fa da ponte verso Yahoo Finance e Borsa Italiana: elimina la dipendenza dai proxy
CORS pubblici (allorigins / codetabs / corsproxy), più lenti e meno affidabili.

## Ridistribuire dopo una modifica a `price-proxy.js`

```bash
cd worker
npx wrangler deploy
```

Stessa identità (`franco-invest-proxy`), stesso URL: non serve toccare
`portfolio-shared-config.js` né la variabile `PROXY_BASE`.

## Endpoint esposti

| Metodo | Path                  | Uso                                                |
|--------|-----------------------|-----------------------------------------------------|
| GET    | `/fetch?url=<URL>`    | proxy generico (solo host Yahoo / Borsa Italiana)    |
| GET    | `/quote?symbol=<SYM>` | chart Yahoo per un simbolo                           |

Le notizie **non** passano più da qui: il digest è generato da
`scripts/update-news.mjs` via GitHub Action (Google News RSS, nessuna chiave),
vedi `news.json` e `.github/workflows/update-news.yml`.
