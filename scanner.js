// scanner.js — Split & Corporate Actions Scanner v12 (Massive/Polygon API)
// Adds: ticker_change events (mergers, delistings, renames) + merger news alerts
import fetch from 'node-fetch';
import fs from 'fs';

const API_KEY  = process.env.POLYGON_API_KEY;
const SPLITS_URL = 'https://api.polygon.io/v3/reference/splits';
const EVENTS_URL = 'https://api.polygon.io/vX/reference/tickers'; // /{id}/events
const NEWS_URL   = 'https://api.polygon.io/v2/reference/news';
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

// ── 1. SPLITS (existing logic, unchanged) ─────────────────────

async function fetchSplits() {
  const { from, to } = getDateRange();
  const allResults = [];
  let url = `${SPLITS_URL}?execution_date.gte=${from}&execution_date.lte=${to}&limit=1000&order=desc&sort=execution_date&apiKey=${API_KEY}`;

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

// ── 2. TICKER EVENTS (new — mergers, renames, delistings) ─────

async function fetchTickerEvents(tickers) {
  const events = [];

  for (const ticker of tickers) {
    try {
      const url = `${EVENTS_URL}/${encodeURIComponent(ticker)}/events?types=ticker_change&apiKey=${API_KEY}`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const results = data.results?.events || [];
      for (const evt of results) {
        events.push({
          ticker,
          type: evt.type || 'ticker_change',
          date: evt.date || null,
          ticker_change: evt.ticker_change || null,
          name: data.results?.name || ticker,
        });
      }
    } catch (e) {
      // Experimental endpoint — tolerate failures silently
    }
    await sleep(200);
  }

  return events;
}

// ── 3. MERGER / ACQUISITION NEWS (new — keyword scan) ─────────

const MERGER_KEYWORDS = [
  'merger', 'acquisition', 'acquire', 'unification',
  'delisting', 'delist', 'ticker change', 'redomicil',
  'tender offer', 'scheme of arrangement',
];

async function fetchMergerNews() {
  const allArticles = [];
  const now = new Date();
  const from = new Date(now); from.setDate(from.getDate() - 14);
  const fromStr = from.toISOString().slice(0, 10);

  let url = `${NEWS_URL}?published_utc.gte=${fromStr}&limit=100&order=desc&sort=published_utc&apiKey=${API_KEY}`;
  let pages = 0;
  const MAX_PAGES = 5;

  while (url && pages < MAX_PAGES) {
    try {
      console.log(`  Fetching news page ${pages + 1}...`);
      const res = await fetch(url);
      if (!res.ok) break;
      const data = await res.json();
      const results = data.results || [];
      allArticles.push(...results);
      console.log(`  → ${results.length} articles (${allArticles.length} total)`);
      url = data.next_url ? data.next_url + `&apiKey=${API_KEY}` : null;
      pages++;
      if (url) await sleep(300);
    } catch (e) {
      console.log(`  News fetch error: ${e.message}`);
      break;
    }
  }

  // Filter for merger-related articles
  const matched = allArticles.filter(article => {
    const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
    return MERGER_KEYWORDS.some(kw => text.includes(kw));
  });

  console.log(`  → ${matched.length} merger-related articles from ${allArticles.length} total`);
  return matched;
}

// ── Shared: fetch company name ────────────────────────────────

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

// ── MAIN ──────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Corporate Actions Scanner v12 (Massive API) — ${new Date().toISOString()} ===\n`);

  // ── Phase 1: Splits (existing) ──
  console.log('── Phase 1: Splits ──');
  const splits = await fetchSplits();
  console.log(`Total splits fetched: ${splits.length}`);

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

  // Load existing data to determine what's new
  let existingIds = new Set();
  let existingActionIds = new Set();
  try {
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    (existing.splits || []).forEach(s => existingIds.add(s.id));
    (existing.corporateActions || []).forEach(a => existingActionIds.add(a.id));
    console.log(`Existing: ${existingIds.size} splits, ${existingActionIds.size} corporate actions`);
  } catch(e) { console.log('No existing splits.json — all records will be marked new'); }

  // Enrich splits (unchanged logic)
  const enriched = splits.map(s => {
    const details = tickerDetails[s.ticker];
    const company = details?.name || s.ticker;
    const isETF   = details?.type === 'ETF' || ETF_TYPES.has(details?.type);

    const n = Number(s.split_to)   || 1;
    const d = Number(s.split_from) || 1;
    let type = 'unknown';
    if (s.adjustment_type === 'forward_split')  type = 'forward';
    else if (s.adjustment_type === 'reverse_split') type = 'reverse';
    else if (n > d) type = 'forward';
    else if (d > n) type = 'reverse';

    const ratio = type === 'forward' ? `${n}-for-${d}` : `1-for-${d}`;

    if (!Number.isInteger(n) || !Number.isInteger(d)) return null;
    if (n === d) return null;
    if (n > 1000 || d > 1000) return null;

    const id = s.id || `${s.ticker}-${s.execution_date}`;
    return {
      id, company, ticker: s.ticker, exDate: s.execution_date,
      ratio, type, isETF,
      isNew: !existingIds.has(id),
      source: 'polygon',
    };
  });

  const filteredSplits = enriched.filter(r => r !== null);
  filteredSplits.sort((a, b) => (b.exDate || '').localeCompare(a.exDate || ''));

  const fwd  = filteredSplits.filter(r => r.type === 'forward').length;
  const rev  = filteredSplits.filter(r => r.type === 'reverse').length;
  const etfs = filteredSplits.filter(r => r.isETF).length;
  const newSplitCount = filteredSplits.filter(r => r.isNew).length;
  console.log(`\n✓ Splits: ${filteredSplits.length} total | ${fwd} forward | ${rev} reverse | ${etfs} ETFs | ${newSplitCount} new`);

  // ── Phase 2: Merger News ──
  console.log('\n── Phase 2: Merger & Acquisition News ──');
  const mergerArticles = await fetchMergerNews();

  // Deduplicate: ticker → most recent article
  const mergerMap = new Map();
  for (const article of mergerArticles) {
    for (const ticker of (article.tickers || [])) {
      const existing = mergerMap.get(ticker);
      if (!existing || (article.published_utc > existing.published_utc)) {
        mergerMap.set(ticker, article);
      }
    }
  }

  // Build corporate action records from news
  const corporateActions = [];
  for (const [ticker, article] of mergerMap) {
    const id = `news-${ticker}-${(article.published_utc || '').slice(0, 10)}`;
    const text = `${article.title || ''} ${article.description || ''}`.toLowerCase();
    let actionType = 'merger_news';
    if (text.includes('delist'))                actionType = 'delisting';
    else if (text.includes('tender offer'))     actionType = 'tender_offer';
    else if (text.includes('unification'))      actionType = 'unification';
    else if (text.includes('ticker change'))    actionType = 'ticker_change';
    else if (text.includes('acqui'))            actionType = 'acquisition';
    else if (text.includes('merger'))           actionType = 'merger';
    else if (text.includes('redomicil'))        actionType = 'redomiciliation';

    let company = tickerDetails[ticker]?.name || null;
    if (!company) {
      const details = await fetchTickerName(ticker);
      if (details) {
        company = details.name;
        tickerDetails[ticker] = details;
      }
      await sleep(150);
    }

    corporateActions.push({
      id,
      category: 'corporate_action',
      actionType,
      ticker,
      company: company || ticker,
      headline: article.title || '',
      summary: (article.description || '').slice(0, 300),
      publishedDate: (article.published_utc || '').slice(0, 10),
      articleUrl: article.article_url || '',
      source: article.publisher?.name || 'unknown',
      isNew: !existingActionIds.has(id),
      confirmed: false,
    });
  }

  // ── Phase 3: Ticker Events (check tickers from merger news) ──
  console.log('\n── Phase 3: Ticker Events (experimental) ──');
  const tickersToCheck = [...mergerMap.keys()].slice(0, 25);
  let tickerEvents = [];
  if (tickersToCheck.length > 0) {
    console.log(`Checking ${tickersToCheck.length} tickers for confirmed ticker changes...`);
    tickerEvents = await fetchTickerEvents(tickersToCheck);
    console.log(`✓ Found ${tickerEvents.length} ticker change events`);

    for (const evt of tickerEvents) {
      const match = corporateActions.find(a => a.ticker === evt.ticker);
      if (match) {
        match.confirmed = true;
        match.actionType = 'ticker_change';
        if (evt.ticker_change) {
          match.oldTicker = evt.ticker_change.ticker || null;
          match.newTicker = evt.ticker;
        }
        if (evt.date) match.eventDate = evt.date;
      } else {
        const id = `event-${evt.ticker}-${evt.date || 'unknown'}`;
        corporateActions.push({
          id,
          category: 'corporate_action',
          actionType: 'ticker_change',
          ticker: evt.ticker,
          company: evt.name || evt.ticker,
          headline: `Ticker change: ${evt.ticker_change?.ticker || '?'} → ${evt.ticker}`,
          summary: '',
          publishedDate: evt.date || '',
          articleUrl: '',
          source: 'polygon_events',
          isNew: !existingActionIds.has(id),
          confirmed: true,
          oldTicker: evt.ticker_change?.ticker || null,
          newTicker: evt.ticker,
          eventDate: evt.date || null,
        });
      }
    }
  }

  corporateActions.sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''));
  const newActionCount = corporateActions.filter(a => a.isNew).length;
  console.log(`✓ Corporate actions: ${corporateActions.length} total | ${newActionCount} new`);

  // ── Write output ──
  console.log('\n── Writing output ──');
  const output = {
    lastUpdated:           new Date().toISOString(),
    totalRecords:          filteredSplits.length,
    newThisScan:           newSplitCount,
    totalCorporateActions: corporateActions.length,
    newActionsThisScan:    newActionCount,
    splits:                filteredSplits,
    corporateActions:      corporateActions,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`Written to ${OUT_FILE}`);
  console.log(`  Splits: ${filteredSplits.length} (${newSplitCount} new)`);
  console.log(`  Corporate actions: ${corporateActions.length} (${newActionCount} new)`);
  console.log(`  Ticker events confirmed: ${tickerEvents.length}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
