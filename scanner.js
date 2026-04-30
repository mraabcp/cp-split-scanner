// scanner.js — Split Scanner v10 (Massive/Polygon API)
import fetch from 'node-fetch';
import fs from 'fs';

const API_KEY  = process.env.POLYGON_API_KEY;
const BASE_URL = 'https://api.polygon.io/v3/reference/splits';
const TICKERS_URL = 'https://api.polygon.io/v3/reference/tickers';
const OUT_FILE = 'splits.json';

if (!API_KEY) { console.error('Missing POLYGON_API_KEY'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDateRange() {
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 7);
  const to   = new Date(now); to.setDate(to.getDate() + 30);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

async function fetchSplits() {
  const { from, to } = getDateRange();
  const allResults = [];
  let url = `${BASE_URL}?execution_date.gte=${from}&execution_date.lte=${to}&limit=1000&order=desc&sort=execution_date&apiKey=${API_KEY}`;

  while (url) {
    console.log(`  Fetching splits page...`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const results = data.results || [];
    allResults.push(...results);
    console.log(`  → ${results.length} results (${allResults.length} total)`);
    url = data.next_url ? data.next_url + `&apiKey=${API_KEY}` : null;
    if (url) await sleep(300);
  }

  return allResults;
}

// Bulk fetch ticker details in batches
async function fetchTickerDetailsBatch(tickers) {
  const details = {};
  // Polygon tickers endpoint supports comma-separated list
  const batchSize = 50;
  for (let i = 0; i < tickers.length; i += batchSize) {
    const batch = tickers.slice(i, i + batchSize);
    const url = `${TICKERS_URL}?ticker=${batch.join(',')}&limit=1000&apiKey=${API_KEY}`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.log(`  Ticker batch error: ${res.status}`); continue; }
      const data = await res.json();
      for (const t of (data.results || [])) {
        details[t.ticker] = { name: t.name, type: t.type };
      }
    } catch(e) { console.log(`  Ticker batch error: ${e.message}`); }
    await sleep(500);
    console.log(`  Fetched ticker details batch ${Math.floor(i/batchSize)+1}/${Math.ceil(tickers.length/batchSize)}`);
  }
  return details;
}

const ETF_TYPES = new Set(['ETF','ETV','ETN','ETP']);

async function main() {
  console.log(`\n=== Split Scanner v10 (Massive API) — ${new Date().toISOString()} ===\n`);

  const splits = await fetchSplits();
  console.log(`\nTotal splits fetched: ${splits.length}`);

  // Get all unique tickers and fetch details in bulk
  const tickers = [...new Set(splits.map(s => s.ticker))];
  console.log(`\nFetching details for ${tickers.length} unique tickers...`);
  const tickerDetails = await fetchTickerDetailsBatch(tickers);
  console.log(`Got details for ${Object.keys(tickerDetails).length} tickers`);

  const enriched = splits.map(s => {
    const details = tickerDetails[s.ticker] || {};
    const company = details.name || s.ticker;
    const isETF   = ETF_TYPES.has(details.type);

    // Map Polygon adjustment_type to forward/reverse
    let type = 'unknown';
    if (s.adjustment_type === 'forward_split') type = 'forward';
    else if (s.adjustment_type === 'reverse_split') type = 'reverse';

    const n = s.split_to   || 1;
    const d = s.split_from || 1;
    const ratio = type === 'forward' ? `${n}-for-${d}` : `1-for-${d}`;

    return {
      id:      s.id || `${s.ticker}-${s.execution_date}`,
      company,
      ticker:  s.ticker,
      exDate:  s.execution_date,
      ratio,
      type,
      isETF,
      source: 'polygon',
    };
  });

  enriched.sort((a, b) => (b.exDate || '').localeCompare(a.exDate || ''));

  const fwd  = enriched.filter(r => r.type === 'forward').length;
  const rev  = enriched.filter(r => r.type === 'reverse').length;
  const etfs = enriched.filter(r => r.isETF).length;

  console.log(`\n✓ ${enriched.length} total | ${fwd} forward | ${rev} reverse | ${etfs} ETFs`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    totalRecords: enriched.length,
    splits:       enriched,
  }, null, 2));

  console.log(`Written to ${OUT_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
