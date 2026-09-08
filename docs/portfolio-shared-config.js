window.PORTFOLIO_DESK_SECRETS = window.PORTFOLIO_DESK_SECRETS || {};

// Proxy dedicato opzionale (Cloudflare Worker) — vedi worker/README.md.
// Quando è impostato: quotazioni live e Groq passano di qui, niente proxy pubblici,
// chiave Groq lato server. Lascia commentato finché il worker non è deployato.
// window.PORTFOLIO_DESK_SECRETS.proxyBase = 'https://franco-invest-proxy.<subdominio>.workers.dev';
