#!/usr/bin/env node
/**
 * Aggiorna i prezzi degli strumenti in portafoglio lato server (niente CORS).
 *
 * - Legge gli strumenti da portfolio-static-data.js (+ scripts/watchlist.json opzionale)
 * - Risolve un prezzo per ogni ISIN / ticker via Yahoo Finance, con fallback su
 *   Borsa Italiana (MOT) per i titoli di Stato italiani e su alcuni proxy pubblici
 * - Recupera i cambi valuta -> EUR
 * - Scrive prices.json (root + docs/) usato dalla piattaforma come prezzo base
 * - Aggiorna portfolio-history.json (root + docs/) con il valore giornaliero
 *   di ogni cliente, così la dashboard ha uno storico reale del portafoglio
 *
 * Uso: node scripts/update-prices.mjs
 * Richiede Node >= 18 (fetch globale).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BASE_CURRENCY = 'EUR';
const FX_PAIRS = { USD: 'EURUSD=X', GBP: 'EURGBP=X', CHF: 'EURCHF=X', JPY: 'EURJPY=X' };
const HISTORY_MAX_POINTS = 1200;
const REQUEST_TIMEOUT_MS = 9000;
const RETRY_DELAY_MS = 350;
// Su runner GitHub la chiamata diretta a Yahoo di solito basta; in locale l'IP è spesso
// rate-limited e si passa dai proxy. Con DIRECT_ONLY=1 si saltano i proxy (test rapido).
const DIRECT_ONLY = process.env.DIRECT_ONLY === '1';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ *
 *  Fetch helpers con fallback su proxy pubblici (come fa la web app)
 * ------------------------------------------------------------------ */

async function rawFetch(url, { as = 'json' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: as === 'json' ? 'application/json,text/plain,*/*' : 'text/html,*/*' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (as === 'text') return text;
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function proxied(url) {
  if (DIRECT_ONLY) return [url];
  return [
    url,
    `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`
  ];
}

async function fetchWith(url, as) {
  let lastError;
  for (const attempt of proxied(url)) {
    try {
      return await rawFetch(attempt, { as });
    } catch (error) {
      lastError = error;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastError || new Error(`fetch ${as} failed`);
}

const fetchJSON = (url) => fetchWith(url, 'json');
const fetchText = (url) => fetchWith(url, 'text');

/* ------------------------------------------------------------------ *
 *  Sorgenti prezzo
 * ------------------------------------------------------------------ */

async function yahooQuote(idRaw) {
  const id = String(idRaw || '').trim();
  if (!id) return null;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(id)}?interval=1d&range=5d`;
      const data = await fetchJSON(url);
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta || {};
      const closes = (result?.indicators?.quote?.[0]?.close || []).filter((n) => Number.isFinite(n));
      const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : closes[closes.length - 1];
      if (!Number.isFinite(price) || price <= 0) continue;
      const prev = Number.isFinite(meta.chartPreviousClose)
        ? meta.chartPreviousClose
        : Number.isFinite(meta.previousClose)
        ? meta.previousClose
        : closes[closes.length - 2];
      const changePct = Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : 0;
      return {
        price,
        currency: meta.currency || BASE_CURRENCY,
        changePct: Number(changePct.toFixed(3)),
        name: meta.shortName || meta.longName || id,
        source: `yahoo:${id}`
      };
    } catch {
      /* prova host successivo */
    }
  }
  return null;
}

// Yahoo non quota i fondi per ISIN grezzo: prima risolvi ISIN/nome -> simbolo Yahoo.
async function yahooSymbolFor(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
  for (const host of hosts) {
    try {
      const url = `https://${host}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0&listsCount=0`;
      const data = await fetchJSON(url);
      const quotes = Array.isArray(data?.quotes) ? data.quotes : [];
      const hit = quotes.find((entry) => entry && entry.symbol);
      if (hit) return hit.symbol;
    } catch {
      /* prova host successivo */
    }
  }
  return null;
}

function isItalianGov(inst) {
  const hay = `${inst.isin || ''} ${inst.symbol || ''} ${inst.name || ''}`.toUpperCase();
  return /^IT000/.test(inst.isin || '') || /\b(BTP|CCT|CCTEU|CTZ|BOT)\b/.test(hay);
}

/** Fallback per titoli di Stato italiani: scheda MOT di Borsa Italiana. */
async function borsaItaliana(isin) {
  const code = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(code)) return null;
  const sections = ['btp', 'cct', 'obbligazioni-euro', 'ctz', 'bot'];
  for (const section of sections) {
    try {
      const html = await fetchText(
        `https://www.borsaitaliana.it/borsa/obbligazioni/mot/${section}/scheda/${code}.html?lang=it`
      );
      if (!html || /Pagina non trovata|Page not found/i.test(html)) continue;
      // "Prezzo Ultimo Contratto" oppure "Prezzo di riferimento"
      const m =
        html.match(/Prezzo Ultimo Contratto[\s\S]{0,240}?([0-9]{1,3}(?:[.,][0-9]{2,4}))/i) ||
        html.match(/Prezzo di [Rr]iferimento[\s\S]{0,240}?([0-9]{1,3}(?:[.,][0-9]{2,4}))/i) ||
        html.match(/Prezzo Ufficiale[\s\S]{0,240}?([0-9]{1,3}(?:[.,][0-9]{2,4}))/i);
      if (!m) continue;
      const price = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
      if (Number.isFinite(price) && price > 0 && price < 1000) {
        return { price, currency: 'EUR', changePct: 0, name: code, source: `borsaitaliana:${section}` };
      }
    } catch {
      /* prova sezione successiva */
    }
  }
  return null;
}

async function resolvePrice(inst) {
  const candidates = [];
  const push = (v) => {
    const s = String(v || '').trim();
    if (s && !candidates.includes(s)) candidates.push(s);
  };
  push(inst.isin);
  push(inst.symbol);
  // ticker "puliti" tipo "BTP-TF-3-00-AG29-EUR" non sono quotabili: saltali
  const usable = candidates.filter((c) => /^[A-Z0-9]{1,6}([.\-=][A-Z0-9]+)?$/i.test(c) || /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(c));

  for (const candidate of usable) {
    const quote = await yahooQuote(candidate);
    if (quote) return { ...quote, matched: candidate };
    await sleep(150);
  }

  // Titoli di Stato italiani: scheda MOT di Borsa Italiana (fonte più affidabile per i bond).
  if (isItalianGov(inst) && inst.isin) {
    const bi = await borsaItaliana(inst.isin);
    if (bi) return { ...bi, matched: inst.isin };
  }

  // Fondi / ETF: risolvi ISIN o nome -> simbolo Yahoo, poi quota.
  for (const query of [inst.isin, inst.name].filter(Boolean)) {
    const symbol = await yahooSymbolFor(query);
    await sleep(150);
    if (symbol && symbol.toUpperCase() !== String(inst.symbol || '').toUpperCase()) {
      const quote = await yahooQuote(symbol);
      if (quote) return { ...quote, matched: `${query}->${symbol}` };
      await sleep(150);
    }
  }

  return null;
}

/* ------------------------------------------------------------------ *
 *  Lettura strumenti dal portafoglio
 * ------------------------------------------------------------------ */

function loadStaticData() {
  const file = join(ROOT, 'portfolio-static-data.js');
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < 0) throw new Error('portfolio-static-data.js: JSON non trovato');
  return JSON.parse(text.slice(start, end + 1));
}

function collectInstruments(staticData) {
  const map = new Map();
  const add = (p) => {
    if (!p) return;
    const key = String(p.isin || p.symbol || '').toUpperCase();
    if (!key) return;
    const type = p.type || 'Altro';
    if (type === 'Liquidità') return;
    if (!map.has(key)) {
      map.set(key, {
        key,
        isin: p.isin || '',
        symbol: p.symbol || '',
        currency: p.currency || BASE_CURRENCY,
        type,
        name: p.name || p.symbol || p.isin || key
      });
    }
  };
  (staticData.clients || []).forEach((client) => (client.positions || []).forEach(add));

  const watchPath = join(__dirname, 'watchlist.json');
  if (existsSync(watchPath)) {
    try {
      const extra = JSON.parse(readFileSync(watchPath, 'utf8'));
      (Array.isArray(extra) ? extra : []).forEach((entry) =>
        add(typeof entry === 'string' ? { symbol: entry } : entry)
      );
    } catch (error) {
      console.warn('watchlist.json ignorato:', error.message);
    }
  }
  return [...map.values()];
}

/* ------------------------------------------------------------------ *
 *  Cambi valuta
 * ------------------------------------------------------------------ */

async function loadFx() {
  const fx = { EUR: 1 };
  for (const [currency, pair] of Object.entries(FX_PAIRS)) {
    const quote = await yahooQuote(pair);
    if (quote && Number.isFinite(quote.price) && quote.price > 0) {
      fx[currency] = Number((1 / quote.price).toFixed(6)); // valuta -> EUR
    }
    await sleep(150);
  }
  return fx;
}

/* ------------------------------------------------------------------ *
 *  Storico valore portafoglio
 * ------------------------------------------------------------------ */

function readJsonSafe(path, fallback) {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`Impossibile leggere ${path}:`, error.message);
  }
  return fallback;
}

// Stessa logica lato app (reconcileBakedPrice): allinea la scala per-100 / per-1 e
// scarta il prezzo di mercato se diverge troppo dal carico.
function reconcilePrice(price, avgCost) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const ref = Number(avgCost);
  if (!Number.isFinite(ref) || ref <= 0) return price;
  let aligned = price;
  const ratio = price / ref;
  if (ratio >= 20 && ratio <= 5000) aligned = price / 100;
  else if (ratio <= 0.05 && ratio >= 0.0002) aligned = price * 100;
  const finalRatio = aligned / ref;
  if (finalRatio < 0.25 || finalRatio > 4) return null;
  return aligned;
}

function buildHistoryPoint(staticData, priceMap, fx) {
  const today = new Date().toISOString().slice(0, 10);
  const totals = {};
  let grand = 0;
  (staticData.clients || []).forEach((client) => {
    let clientTotal = 0;
    (client.positions || []).forEach((p) => {
      const qty = Number(p.qty) || 0;
      if (qty <= 0) return;
      const posCcy = p.currency || BASE_CURRENCY;
      let priceEur;
      if (p.type === 'Liquidità') {
        priceEur = (fx[posCcy] || 1);
      } else {
        const hit = priceMap[String(p.isin || '').toUpperCase()] || priceMap[String(p.symbol || '').toUpperCase()];
        const marketInPosCcy = hit && Number.isFinite(hit.price)
          ? hit.price * (fx[hit.currency] || 1) / (fx[posCcy] || 1)
          : null;
        const reconciled = marketInPosCcy !== null ? reconcilePrice(marketInPosCcy, p.avgCost) : null;
        priceEur = Number.isFinite(reconciled)
          ? reconciled * (fx[posCcy] || 1)
          : (Number(p.avgCost) || 0) * (fx[posCcy] || 1);
      }
      clientTotal += qty * priceEur;
    });
    totals[client.id] = Number(clientTotal.toFixed(2));
    grand += clientTotal;
  });
  return { date: today, totals, total: Number(grand.toFixed(2)) };
}

function upsertHistory(existing, point) {
  const list = Array.isArray(existing) ? existing.filter((e) => e && e.date !== point.date) : [];
  list.push(point);
  list.sort((a, b) => a.date.localeCompare(b.date));
  return list.slice(-HISTORY_MAX_POINTS);
}

/* ------------------------------------------------------------------ *
 *  Main
 * ------------------------------------------------------------------ */

async function main() {
  const staticData = loadStaticData();
  const instruments = collectInstruments(staticData);
  console.log(`Strumenti da aggiornare: ${instruments.length}`);

  const fx = await loadFx();
  console.log('Cambi -> EUR:', fx);

  const prices = {};
  let ok = 0;
  let miss = 0;
  const missed = [];

  for (const inst of instruments) {
    const resolved = await resolvePrice(inst);
    if (resolved) {
      const record = {
        price: Number(resolved.price.toFixed(6)),
        currency: resolved.currency || inst.currency || BASE_CURRENCY,
        changePct: resolved.changePct || 0,
        name: inst.name,
        asOf: new Date().toISOString().slice(0, 10),
        source: resolved.source
      };
      if (inst.isin) prices[inst.isin.toUpperCase()] = record;
      if (inst.symbol) prices[inst.symbol.toUpperCase()] = record;
      ok++;
      console.log(`  ✓ ${inst.name} (${resolved.matched}) = ${record.price} ${record.currency}`);
    } else {
      miss++;
      missed.push(inst.name);
      console.log(`  · ${inst.name} — nessun prezzo (resta manuale)`);
    }
    await sleep(150);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    base: BASE_CURRENCY,
    fx,
    counts: { total: instruments.length, resolved: ok, manual: miss },
    prices
  };

  for (const dir of [ROOT, join(ROOT, 'docs')]) {
    writeFileSync(join(dir, 'prices.json'), JSON.stringify(output, null, 2) + '\n');
  }

  const historyPath = join(ROOT, 'portfolio-history.json');
  const history = upsertHistory(readJsonSafe(historyPath, []), buildHistoryPoint(staticData, prices, fx));
  for (const dir of [ROOT, join(ROOT, 'docs')]) {
    writeFileSync(join(dir, 'portfolio-history.json'), JSON.stringify(history, null, 2) + '\n');
  }

  console.log(`\nFatto: ${ok} prezzi risolti, ${miss} restano manuali.`);
  if (missed.length) console.log('Manuali:', missed.join(' | '));
}

main().catch((error) => {
  console.error('update-prices fallito:', error);
  process.exit(1);
});
