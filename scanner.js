// scanner.js — Split Scanner v9 (Massive/Polygon API)
import fetch from 'node-fetch';
import fs from 'fs';

const API_KEY  = process.env.POLYGON_API_KEY;
const BASE_URL = 'https://api.polygon.io/v3/reference/splits';
const OUT_FILE = 'splits.json';

if (!API_KEY) { console.error('Missing POLYGON_API_KEY'); process.exit(1); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Lookback: 90 days behind, 180 days forward
function getDateRange() {
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 90);
  const to   = new Date(now); to.setDate(to.getDate() + 180);
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  };
}

async function fetchSplits() {
  const { from, to } = getDateRange();
  const allResults = [];
  let url = `${BASE_URL}?execution_date.gte=${from}&execution_date.lte=${to}&limit=1000&sort=execution_date.desc&apiKey=${API_KEY}`;

  while (url) {
    console.log(`  Fetching: ${url.replace(API_KEY, '***')}`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const results = data.results || [];
    allResults.push(...results);
    console.log(`  → ${results.length} results (${allResults.length} total)`);

    // Paginate via next_url
    url = data.next_url ? data.next_url + `&apiKey=${API_KEY}` : null;
    if (url) await sleep(300);
  }

  return allResults;
}

async function fetchTickerDetails(ticker) {
  try {
    const res = await fetch(
      `https://api.polygon.io/v3/reference/tickers/${ticker}?apiKey=${API_KEY}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.results || null;
  } catch(e) { return null; }
}

const ETF_TYPES = new Set(['ETF', 'ETV', 'ETN', 'ETP']);

async function main() {
  console.log(`\n=== Split Scanner v9 (Massive API) — ${new Date().toISOString()} ===\n`);

  const splits = await fetchSplits();
  console.log(`\nTotal splits fetched: ${splits.length}`);

  // Enrich with company names — batch with rate limit awareness
  const enriched = [];
  for (let i = 0; i < splits.length; i++) {
    const s = splits[i];
    const n = parseInt(s.split_to), d = parseInt(s.split_from);
    const type = s.adjustment_type === 'forward_split' ? 'forward'
               : s.adjustment_type === 'reverse_split' ? 'reverse'
               : s.adjustment_type || 'unknown';
    const ratio = type === 'forward' ? `${n}-for-${d}` : `1-for-${d}`;

    // Fetch ticker details every 5th record to get company name + ETF flag
    // (rate limit: free tier = 5 req/min)
    let company = s.ticker;
    let isETF = false;
    if (i % 5 === 0) {
      await sleep(1200); // ~5 req/min safe rate
      const details = await fetchTickerDetails(s.ticker);
      if (details) {
        company = details.name || s.ticker;
        isETF = ETF_TYPES.has(details.type);
      }
    }

    enriched.push({
      id:       s.id || `${s.ticker}-${s.execution_date}`,
      company,
      ticker:   s.ticker,
      formType: isETF ? '497' : '8-K',
      filedAt:  s.execution_date,
      exDate:   s.execution_date,
      ratio,
      type,
      isETF,
      edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=${encodeURIComponent(s.ticker)}&CIK=&type=8-K&dateb=&owner=include&count=5`,
    });

    if (i % 20 === 0) console.log(`  Enriched ${i+1}/${splits.length}...`);
  }

  // Sort by ex-date descending
  enriched.sort((a, b) => (b.exDate || '').localeCompare(a.exDate || ''));

  const fwd = enriched.filter(r => r.type === 'forward').length;
  const rev = enriched.filter(r => r.type === 'reverse').length;
  const etfs = enriched.filter(r => r.isETF).length;

  console.log(`\n✓ ${enriched.length} total | ${fwd} forward | ${rev} reverse | ${etfs} ETFs`);

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    totalRecords: enriched.length,
    newThisScan:  enriched.length,
    splits:       enriched,
  }, null, 2));

  console.log(`Written to ${OUT_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
