/**
 * Franco Invest — proxy dedicato (Cloudflare Worker, piano free).
 *
 * Sostituisce i proxy CORS pubblici (allorigins / codetabs / corsproxy): Yahoo
 * Finance e Borsa Italiana rispondono in modo affidabile passando da qui, anche
 * dai runner GitHub Actions che Yahoo altrimenti blocca.
 *
 * Endpoint:
 *   GET /fetch?url=<URL>   -> proxy generico verso host in whitelist (Yahoo, Borsa Italiana)
 *   GET /quote?symbol=AAPL -> scorciatoia: chart Yahoo per un simbolo
 *
 * Deploy: vedi worker/README.md
 */

const ALLOWED_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'finance.yahoo.com',
  'www.borsaitaliana.it',
  'borsaitaliana.it'
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS }
  });
}

function hostAllowed(hostname) {
  return ALLOWED_HOSTS.includes(hostname);
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (path === '/quote') {
        const symbol = url.searchParams.get('symbol');
        if (!symbol) return json({ error: 'missing_symbol' }, 400);
        const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
        return proxyGet(target);
      }

      if (path === '/fetch') {
        const target = url.searchParams.get('url');
        if (!target) return json({ error: 'missing_url' }, 400);
        let parsed;
        try {
          parsed = new URL(target);
        } catch {
          return json({ error: 'bad_url' }, 400);
        }
        if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
          return json({ error: 'host_not_allowed', host: parsed.hostname }, 403);
        }
        return proxyGet(parsed.toString());
      }

      return json({ ok: true, service: 'franco-invest price-proxy', endpoints: ['/fetch', '/quote'] });
    } catch (error) {
      return json({ error: 'proxy_failure', detail: String(error && error.message || error) }, 502);
    }
  }
};

async function proxyGet(target) {
  const upstream = await fetch(target, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      Accept: 'application/json,text/html,*/*'
    },
    cf: { cacheTtl: 60, cacheEverything: true }
  });
  const contentType = upstream.headers.get('Content-Type') || 'text/plain';
  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=60', ...CORS }
  });
}
