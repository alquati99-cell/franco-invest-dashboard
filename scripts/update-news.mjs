#!/usr/bin/env node
/**
 * Genera il digest notizie della piattaforma, niente chiave/AI: Google News RSS
 * per ogni tema (nessuna autenticazione, nessun limite pratico per un uso così).
 *
 * Scrive news.json (root + docs/) con le headline per tema, che l'app carica
 * a costo zero (fetch statico, stesso dominio).
 *
 * Uso: node scripts/update-news.mjs   (Node >= 18)
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const REQUEST_TIMEOUT_MS = 10000;
const ITEMS_PER_TOPIC = 8;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Stessi temi di sempre (erano gli hint per Groq, ora sono la query RSS).
const TOPICS = [
  { id: 'eni', label: 'ENI', query: 'Eni SpA azioni' },
  { id: 'enel', label: 'ENEL', query: 'Enel SpA azioni utility' },
  { id: 'snam', label: 'SNAM', query: 'Snam SpA gas rete' },
  { id: 'saipem', label: 'Saipem', query: 'Saipem contratti offshore' },
  { id: 'banks', label: 'Banche ITA', query: 'UniCredit Intesa Sanpaolo Banco BPM MPS' },
  { id: 'geopolitics', label: 'Geopolitica & Macro', query: 'BTP spread Bund BCE tassi geopolitica mercati' }
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml,text/xml,*/*' },
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function stripHtmlTags(value) {
  return decodeXmlEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseGoogleNewsRss(xml) {
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const rawTitle = decodeXmlEntities(extractTag(block, 'title'));
    const link = decodeXmlEntities(extractTag(block, 'link'));
    const pubDate = extractTag(block, 'pubDate');
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/i);
    let source = sourceMatch ? decodeXmlEntities(sourceMatch[1]) : '';
    let title = rawTitle;
    // Google News mette quasi sempre "Titolo - Fonte" nel <title>: se combacia con
    // la fonte (dal tag <source> o, in mancanza, dalla coda del titolo), la stacca.
    if (source && rawTitle.endsWith(` - ${source}`)) {
      title = rawTitle.slice(0, -(source.length + 3));
    } else if (!source && rawTitle.includes(' - ')) {
      const idx = rawTitle.lastIndexOf(' - ');
      title = rawTitle.slice(0, idx);
      source = rawTitle.slice(idx + 3);
    }
    const parsedDate = pubDate ? new Date(pubDate) : null;
    if (!title || !link) continue;
    items.push({
      title: stripHtmlTags(title),
      link,
      source: stripHtmlTags(source) || 'Google News',
      publishedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toISOString() : null
    });
  }
  return items;
}

async function fetchTopicNews(topic) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic.query)}&hl=it&gl=IT&ceid=IT:it`;
  try {
    const xml = await fetchText(url);
    const items = parseGoogleNewsRss(xml)
      .sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''))
      .slice(0, ITEMS_PER_TOPIC);
    console.log(`  ✓ ${topic.label}: ${items.length} notizie`);
    return items;
  } catch (error) {
    console.warn(`  · ${topic.label}: errore (${error.message}) — tema saltato`);
    return null;
  }
}

async function main() {
  const topics = [];
  for (const topic of TOPICS) {
    const items = await fetchTopicNews(topic);
    topics.push({ id: topic.id, label: topic.label, items: items || [] });
    await sleep(400);
  }

  const totalItems = topics.reduce((sum, t) => sum + t.items.length, 0);
  const output = {
    generatedAt: new Date().toISOString(),
    source: 'Google News RSS',
    topics
  };

  for (const dir of [ROOT, join(ROOT, 'docs')]) {
    writeFileSync(join(dir, 'news.json'), JSON.stringify(output, null, 2) + '\n');
  }

  console.log(`\nFatto: ${totalItems} notizie su ${topics.length} temi.`);
}

main().catch((error) => {
  console.error('update-news fallito:', error);
  process.exit(1);
});
