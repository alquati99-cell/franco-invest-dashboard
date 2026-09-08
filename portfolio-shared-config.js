window.PORTFOLIO_DESK_SECRETS = window.PORTFOLIO_DESK_SECRETS || {};

// Proxy dedicato (Cloudflare Worker, worker/). Le quotazioni live e le ricerche
// strumento passano di qui: niente proxy pubblici, e Yahoo risponde anche quando
// bloccherebbe la chiamata diretta. Vedi worker/README.md.
window.PORTFOLIO_DESK_SECRETS.proxyBase = 'https://franco-invest-proxy.alquati99.workers.dev';
