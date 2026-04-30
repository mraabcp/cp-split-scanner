// scanner.js — Split Scanner v11 (Massive/Polygon API)
import fetch from 'node-fetch';
import fs from 'fs';

const API_KEY  = process.env.POLYGON_API_KEY;
const BASE_URL = 'https://api.polygon.io/v3/reference/splits';
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
    console.log(`  Fetching splits...`);
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

// Fetch company name from Polygon ticker details (best effort)
async function fetchTickerName(ticker) {
  try {
    const res = await fetch(
      `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${API_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.results ? { name: data.results.name, type: data.results.type } : null;
  } catch(e) { return null; }
}

const ETF_TYPES = new Set(['ETF','ETV','ETN','ETP']);

async function main() {
  console.log(`\n=== Split Scanner v11 (Massive API) — ${new Date().toISOString()} ===\n`);

  const splits = await fetchSplits();
  console.log(`\nTotal splits fetched: ${splits.length}`);
  if (splits.length > 0) {
    console.log('Sample record:', JSON.stringify(splits[0], null, 2));
  }

  // Fetch company names from Yahoo Finance (free, no auth)
  const tickerDetails = {};
  const uniqueTickers = [...new Set(splits.map(s => s.ticker))];
  console.log(`\nFetching company names for ${uniqueTickers.length} tickers from Yahoo...`);
  for (let i = 0; i < uniqueTickers.length; i++) {
    const ticker = uniqueTickers[i];
    try {
      const res = await fetch(
        `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (res.ok) {
        const data = await res.json();
        const quote = data?.quotes?.[0];
        if (quote && quote.symbol === ticker) {
          tickerDetails[ticker] = {
            name: quote.longname || quote.shortname || ticker,
            type: quote.quoteType || '',
          };
        }
      }
    } catch(e) {}
    await sleep(150);
    if ((i+1) % 10 === 0) console.log(`  ${i+1}/${uniqueTickers.length} done`);
  }
  console.log(`Got names for ${Object.keys(tickerDetails).length}/${uniqueTickers.length} tickers`);

  const enriched = splits.map(s => {
    const details = tickerDetails[s.ticker];
    const company = details?.name || s.ticker;
    const isETF   = details?.type === 'ETF' || ETF_TYPES.has(details?.type);

    // Derive type from ratio if adjustment_type missing
    const n = Number(s.split_to)   || 1;
    const d = Number(s.split_from) || 1;
    let type = 'unknown';
    if (s.adjustment_type === 'forward_split')  type = 'forward';
    else if (s.adjustment_type === 'reverse_split') type = 'reverse';
    else if (n > d) type = 'forward';
    else if (d > n) type = 'reverse';

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
