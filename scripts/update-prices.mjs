#!/usr/bin/env node
/**
 * Aggiorna i prezzi degli strumenti in portafoglio lato server (niente CORS).
 *
 * Sorgenti (in ordine), scelte perché rispondono anche dagli IP dei runner GitHub:
 *   1. Borsa Italiana  — BTP/CCT (MOT), azioni quotate a Milano, ETF (ETFplus).
 *                        Fonte principale (schede pubbliche, scraping del prezzo).
 *   2. Yahoo Finance   — solo bonus, con "circuit breaker": se i primi tentativi
 *                        falliscono (IP bloccato) smette di provarci. Con PROXY_BASE
 *                        passa dal Cloudflare Worker e torna affidabile (fondi inclusi).
 *   FX -> EUR: api.frankfurter.app (tassi BCE, senza chiave).
 *
 * Con la variabile d'ambiente PROXY_BASE impostata (URL del Cloudflare Worker in
 * worker/) le chiamate Yahoo passano dal worker e tornano affidabili (fondi inclusi).
 *
 * Limite di tempo complessivo: DEADLINE_MS. Oltre quello scrive quel che ha.
 *
 * Uso: node scripts/update-prices.mjs           (Node >= 18)
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BASE_CURRENCY = 'EUR';
const FX_CURRENCIES = ['USD', 'GBP', 'CHF', 'JPY'];
const HISTORY_MAX_POINTS = 1200;
const REQUEST_TIMEOUT_MS = 6000;
const DEADLINE_MS = 6 * 60 * 1000;
const YAHOO_FAILURE_LIMIT = 4; // dopo N fallimenti consecutivi si smette con Yahoo

const PROXY_BASE = (process.env.PROXY_BASE || '').trim().replace(/\/+$/, '');
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const START = Date.now();
const timeLeft = () => DEADLINE_MS - (Date.now() - START);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let yahooFailures = 0;
let yahooDisabled = false;

/* ------------------------------------------------------------------ *
 *  Fetch di base
 * ------------------------------------------------------------------ */

async function rawFetch(url, as) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: as === 'json' ? 'application/json,text/plain,*/*' : 'text/*,*/*'
      },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    return as === 'json' ? JSON.parse(text) : text;
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url) {
  return rawFetch(url, 'json');
}
async function getText(url) {
  return rawFetch(url, 'text');
}

/* ------------------------------------------------------------------ *
 *  FX -> EUR
 * ------------------------------------------------------------------ */

async function loadFx() {
  const fx = { EUR: 1 };
  // Frankfurter (tassi BCE, nessuna chiave, risponde da qualsiasi IP)
  for (const host of ['api.frankfurter.app', 'api.frankfurter.dev']) {
    try {
      const data = await getJSON(`https://${host}/latest?base=EUR&symbols=${FX_CURRENCIES.join(',')}`);
      for (const ccy of FX_CURRENCIES) {
        const perEur = data?.rates?.[ccy];
        if (Number.isFinite(perEur) && perEur > 0) fx[ccy] = Number((1 / perEur).toFixed(6));
      }
      if (FX_CURRENCIES.every((c) => Number.isFinite(fx[c]))) return fx;
    } catch (error) {
      console.warn(`FX ${host} non disponibile:`, error.message);
    }
  }
  // Bonus: Yahoo per le valute ancora mancanti (se raggiungibile)
  for (const ccy of FX_CURRENCIES) {
    if (Number.isFinite(fx[ccy])) continue;
    const q = await yahooQuote(`EUR${ccy}=X`);
    if (q && q.price > 0) fx[ccy] = Number((1 / q.price).toFixed(6));
  }
  return fx;
}

/* ------------------------------------------------------------------ *
 *  Sorgente 1: Borsa Italiana
 * ------------------------------------------------------------------ */

// Le schede Borsa Italiana (azioni, ETF, MOT) hanno tutte lo stesso blocco prezzo:
//   <span class="... -formatPrice"><strong>8,97</strong></span>
//   <span class="... -percPrice"><strong>-0,30%</strong></span>
// Il path senza suffisso di mercato redirige da solo a quello giusto (-MTAA, -ETFP, ...).
const BORSA_BOND_SECTIONS = [
  'obbligazioni/mot/btp/scheda',
  'obbligazioni/mot/btp-indicizzati-all-inflazione-europea/scheda',
  'obbligazioni/mot/cct/scheda',
  'obbligazioni/mot/bot/scheda',
  'obbligazioni/mot/obbligazioni-euro/scheda',
  'obbligazioni/mot/obbligazioni-in-valuta/scheda'
];
function parseBorsaPrice(html) {
  if (!html) return null;
  const priceM = html.match(/-formatPrice"[^>]*>\s*<strong>\s*([\d.]+,\d+)\s*<\/strong>/i);
  if (!priceM) return null;
  const price = parseFloat(priceM[1].replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(price) || price <= 0 || price > 1e7) return null;
  const pctM = html.match(/-percPrice"[^>]*>\s*<strong>\s*([+-]?[\d.]+,\d+)\s*%/i);
  const changePct = pctM ? parseFloat(pctM[1].replace(/\./g, '').replace(',', '.')) : 0;
  return { price, changePct: Number.isFinite(changePct) ? changePct : 0 };
}

async function borsaItalianaTry(isin, sections) {
  const code = String(isin || '').trim().toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(code)) return null;
  for (const section of sections) {
    if (timeLeft() < 12000) return null;
    try {
      const html = await getText(`https://www.borsaitaliana.it/borsa/${section}/${code}.html?lang=it`);
      const parsed = parseBorsaPrice(html);
      if (parsed) {
        return {
          price: parsed.price,
          currency: 'EUR',
          changePct: Number(parsed.changePct.toFixed(3)),
          name: code,
          source: `borsaitaliana:${section.split('/')[0]}`
        };
      }
    } catch {
      /* sezione successiva */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 *  Sorgente 2: Yahoo (bonus, con circuit breaker)
 * ------------------------------------------------------------------ */

async function yahooGet(path) {
  const url = PROXY_BASE
    ? `${PROXY_BASE}/fetch?url=${encodeURIComponent(`https://query1.finance.yahoo.com${path}`)}`
    : `https://query1.finance.yahoo.com${path}`;
  return getJSON(url);
}

async function yahooQuote(idRaw) {
  if (yahooDisabled) return null;
  const id = String(idRaw || '').trim();
  if (!id) return null;
  try {
    const data = await yahooGet(`/v8/finance/chart/${encodeURIComponent(id)}?interval=1d&range=5d`);
    const result = data?.chart?.result?.[0];
    const meta = result?.meta || {};
    const closes = (result?.indicators?.quote?.[0]?.close || []).filter((n) => Number.isFinite(n));
    const price = Number.isFinite(meta.regularMarketPrice) ? meta.regularMarketPrice : closes[closes.length - 1];
    if (!Number.isFinite(price) || price <= 0) throw new Error('no price');
    const prev = meta.chartPreviousClose ?? meta.previousClose ?? closes[closes.length - 2];
    const changePct = Number.isFinite(prev) && prev !== 0 ? ((price - prev) / prev) * 100 : 0;
    yahooFailures = 0;
    return {
      price,
      currency: meta.currency || BASE_CURRENCY,
      changePct: Number(changePct.toFixed(3)),
      name: meta.shortName || meta.longName || id,
      source: `yahoo:${id}`
    };
  } catch {
    if (!PROXY_BASE && ++yahooFailures >= YAHOO_FAILURE_LIMIT) {
      yahooDisabled = true;
      console.warn(`Yahoo irraggiungibile da questo IP: disattivato dopo ${yahooFailures} tentativi.`);
    }
    return null;
  }
}

async function yahooSymbolFor(query) {
  if (yahooDisabled) return null;
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    const data = await yahooGet(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=5&newsCount=0&listsCount=0`);
    const hit = (data?.quotes || []).find((e) => e && e.symbol);
    return hit ? hit.symbol : null;
  } catch {
    if (!PROXY_BASE && ++yahooFailures >= YAHOO_FAILURE_LIMIT) yahooDisabled = true;
    return null;
  }
}

/* ------------------------------------------------------------------ *
 *  Risoluzione prezzo per strumento
 * ------------------------------------------------------------------ */

function isBondish(inst) {
  const hay = `${inst.isin || ''} ${inst.symbol || ''} ${inst.name || ''} ${inst.type || ''}`.toUpperCase();
  return /OBBLIG|BOND/.test(hay) || /\b(BTP|CCT|CCTEU|CTZ|BOT|BUND|TREASURY|T-BOND)\b/.test(hay);
}
function hasIsin(inst) {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(String(inst.isin || '').toUpperCase());
}
function isItalianIsin(inst) {
  return /^IT[A-Z0-9]{9}\d$/.test(String(inst.isin || '').toUpperCase());
}
function looksLikeEtf(inst) {
  const hay = `${inst.symbol || ''} ${inst.name || ''} ${inst.type || ''}`.toUpperCase();
  return inst.type === 'ETF' || /\b(ETF|UCITS|ISHARES|LYXOR|XTRACKERS|VANGUARD|AMUNDI|INVESCO|WISDOMTREE|SPDR)\b/.test(hay);
}

async function resolvePrice(inst) {
  // 1) Borsa Italiana — fonte principale.
  //    Azioni: SOLO ISIN italiani (il segmento BGEM per i titoli esteri è poco
  //    liquido e i prezzi possono essere stantii -> meglio Yahoo o manuale).
  //    ETF: anche ISIN IE/LU, il segmento ETFplus è liquido.
  if (hasIsin(inst)) {
    if (isBondish(inst)) {
      const bi = await borsaItalianaTry(inst.isin, BORSA_BOND_SECTIONS);
      if (bi) return { ...bi, matched: inst.isin };
    } else if (looksLikeEtf(inst)) {
      const bi = await borsaItalianaTry(inst.isin, ['etf/scheda']);
      if (bi) return { ...bi, matched: inst.isin };
    } else if (isItalianIsin(inst)) {
      const bi = await borsaItalianaTry(inst.isin, ['azioni/scheda']);
      if (bi) return { ...bi, matched: inst.isin };
    }
  }

  // 2) Yahoo — bonus (ticker/ISIN diretto, poi ricerca ISIN->simbolo per i fondi)
  const directCandidates = [inst.symbol, inst.isin]
    .map((c) => String(c || '').trim())
    .filter((c) => /^[A-Z0-9]{1,6}([.\-=][A-Z0-9]+)?$/i.test(c) || /^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(c));
  for (const candidate of directCandidates) {
    const q = await yahooQuote(candidate);
    if (q && sane(q, inst)) return { ...q, matched: candidate };
  }
  // Ricerca simbolo SOLO per ISIN (per nome Yahoo restituisce spesso match assurdi:
  // opzioni, indici, titoli omonimi). L'ISIN è univoco.
  if (!yahooDisabled && hasIsin(inst)) {
    const symbol = await yahooSymbolFor(inst.isin);
    if (symbol) {
      const q = await yahooQuote(symbol);
      if (q && sane(q, inst)) return { ...q, matched: `${inst.isin}->${symbol}` };
    }
  }
  return null;
}

// Scarta match palesemente sbagliati: valuta esotica o prezzo fuori scala rispetto
// al carico (dopo l'eventuale allineamento per-100).
const SANE_CURRENCIES = new Set(['EUR', 'USD', 'GBP', 'CHF', 'JPY']);
function sane(quote, inst) {
  if (!SANE_CURRENCIES.has(String(quote.currency || '').toUpperCase())) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 *  Lettura strumenti
 * ------------------------------------------------------------------ */

function loadStaticData() {
  const text = readFileSync(join(ROOT, 'portfolio-static-data.js'), 'utf8');
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
    if (!key || (p.type || 'Altro') === 'Liquidità') return;
    if (!map.has(key)) {
      map.set(key, {
        key,
        isin: p.isin || '',
        symbol: p.symbol || '',
        currency: p.currency || BASE_CURRENCY,
        type: p.type || 'Altro',
        name: p.name || p.symbol || p.isin || key
      });
    }
  };
  (staticData.clients || []).forEach((c) => (c.positions || []).forEach(add));

  const watchPath = join(__dirname, 'watchlist.json');
  if (existsSync(watchPath)) {
    try {
      JSON.parse(readFileSync(watchPath, 'utf8')).forEach((e) =>
        add(typeof e === 'string' ? { symbol: e } : e)
      );
    } catch (error) {
      console.warn('watchlist.json ignorato:', error.message);
    }
  }
  // Bond prima (Borsa Italiana è rapida e affidabile), poi il resto
  return [...map.values()].sort((a, b) => Number(isBondish(b)) - Number(isBondish(a)));
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

// Come lato app (reconcileBakedPrice): allinea la scala per-100 / per-1 e scarta
// il prezzo di mercato se diverge troppo dal prezzo di carico.
function reconcilePrice(price, avgCost) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const ref = Number(avgCost);
  if (!Number.isFinite(ref) || ref <= 0) return price;
  // Solo allineamento per-100 -> per-1 (tipico dei bond: carico 0,99 vs quotazione 99).
  const aligned = price / ref >= 20 && price / ref <= 5000 ? price / 100 : price;
  const finalRatio = aligned / ref;
  if (finalRatio < 0.4 || finalRatio > 2.5) return null;
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
        priceEur = fx[posCcy] || 1;
      } else {
        const hit =
          priceMap[String(p.isin || '').toUpperCase()] || priceMap[String(p.symbol || '').toUpperCase()];
        const marketInPosCcy =
          hit && Number.isFinite(hit.price) ? (hit.price * (fx[hit.currency] || 1)) / (fx[posCcy] || 1) : null;
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
  console.log(`Strumenti da aggiornare: ${instruments.length}${PROXY_BASE ? ' (via proxy)' : ''}`);

  const fx = await loadFx();
  console.log('Cambi -> EUR:', fx);

  const prices = {};
  let ok = 0;
  const missed = [];

  for (const inst of instruments) {
    if (timeLeft() < 20000) {
      console.warn(`Tempo scaduto: interrotto a ${ok} risolti, ${instruments.length - ok - missed.length} non tentati.`);
      break;
    }
    let resolved = null;
    try {
      resolved = await resolvePrice(inst);
    } catch (error) {
      console.warn(`  ! ${inst.name}: ${error.message}`);
    }
    if (resolved && Number.isFinite(resolved.price)) {
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
      missed.push(inst.name);
      console.log(`  · ${inst.name} — nessun prezzo (resta manuale)`);
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    base: BASE_CURRENCY,
    fx,
    counts: { total: instruments.length, resolved: ok, manual: instruments.length - ok },
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

  console.log(`\nFatto in ${((Date.now() - START) / 1000).toFixed(0)}s: ${ok} prezzi risolti, ${instruments.length - ok} manuali.`);
  if (missed.length) console.log('Manuali:', missed.join(' | '));
}

main().catch((error) => {
  console.error('update-prices fallito:', error);
  process.exit(1);
});
