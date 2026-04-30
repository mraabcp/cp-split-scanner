// scanner.js — SEC EDGAR Split Scanner
// Runs server-side via GitHub Actions, writes splits.json

import fetch from 'node-fetch';
import fs from 'fs';

const USER_AGENT = 'Cerity Partners split-scanner mraab@ceritypartners.com';
const OUT_FILE = 'splits.json';
const LOOKBACK_DAYS = 60; // scan last 60 days on each run

// ---------- Search queries ----------
const QUERIES = [
  { q: '"forward split" "ex-date"',          forms: '8-K,497' },
  { q: '"reverse stock split" "ex-date"',    forms: '8-K,497' },
  { q: '"stock split" "ex-date"',            forms: '8-K,497' },
  { q: '"forward share split"',              forms: '497'     },
  { q: '"share split" "payable date"',       forms: '497'     },
  { q: '"reverse split" "ex-date"',          forms: '8-K,497' },
  { q: '"split-adjusted basis"',             forms: '8-K,497' },
  { q: '"forward stock split" ratio',        forms: '8-K'     },
];

// ---------- Regex patterns ----------
function extractDetails(text) {
  if (!text) return {};

  // Split type
  const isReverse = /reverse\s+(stock\s+)?split|1[- ]for[- ]\d+\s+reverse|consolidat/i.test(text);
  const isForward = /forward\s+(stock\s+|share\s+)?split|\d+[- ]for[- ]1\b|(\d+)[- ]for[- ][1-9]\d*\s+(forward|stock|share)/i.test(text);
  let type = 'unknown';
  if (isReverse && !isForward) type = 'reverse';
  else if (isForward) type = 'forward';
  else {
    const m = text.match(/(\d+)[- ]for[- ](\d+)/i);
    if (m) type = parseInt(m[1]) > parseInt(m[2]) ? 'forward' : 'reverse';
  }

  // Ratio
  let ratio = '';
  const ratioPatterns = [
    /(\d+)[- ]for[- ](\d+)\s+(forward\s+)?(stock\s+|share\s+)?split/i,
    /split\s+ratio\s+of\s+(\d+)[- :](for|to)[- :](\d+)/i,
    /(stock\s+)?split.*?(\d+)[- ]for[- ](\d+)/i,
    /1[- ]for[- ](\d+)\s+reverse/i,
    /reverse.*?1[- ]for[- ](\d+)/i,
  ];
  for (const pat of ratioPatterns) {
    const m = text.match(pat);
    if (m) {
      if (pat.source.includes('reverse') && m[1] && !m[2]) {
        ratio = `1-for-${m[1]}`;
      } else if (m[2] && m[3] && pat.source.includes('ratio')) {
        ratio = `${m[1]}-for-${m[3]}`;
      } else if (m[2] && m[3]) {
        ratio = `${m[2]}-for-${m[3]}`;
      } else if (m[1] && m[2]) {
        ratio = `${m[1]}-for-${m[2]}`;
      }
      if (ratio) break;
    }
  }

  // Ex-date
  let exDate = '';
  const exDatePatterns = [
    /ex[- ]?(?:distribution\s+)?date[^:]*?:\s*([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /ex[- ]?(?:distribution\s+)?date[^:]*?:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:begin|commence)\s+trading[^A-Z]*([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /split-adjusted basis\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /effective\s+(?:date\s+)?(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /([A-Za-z]+ \d{1,2},?\s*\d{4})[,\s]+(?:the\s+)?\(?ex[- ]?date/i,
  ];
  for (const pat of exDatePatterns) {
    const m = text.match(pat);
    if (m && m[1]) { exDate = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  // Ticker
  let ticker = '';
  const tickerPatterns = [
    /\((?:nasdaq|nyse(?:arca|mkt)?|otc)[:\s]+([A-Z]{1,6})\)/i,
    /ticker(?:\s+symbol)?[:\s"]+([A-Z]{1,6})/i,
    /symbol[:\s"]+([A-Z]{1,6})\b/i,
  ];
  for (const pat of tickerPatterns) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length <= 6) { ticker = m[1].toUpperCase(); break; }
  }

  return { type, ratio, exDate, ticker };
}

// ---------- Helpers ----------
const ETF_KEYWORDS = ['etf','fund','trust',' ishares','vanguard','spdr','invesco',
  'wisdomtree','proshares','direxion','graniteshares','global x','abrdn','blackrock'];

function isETF(company = '', formType = '') {
  if (formType === '497') return true;
  const c = company.toLowerCase();
  return ETF_KEYWORDS.some(k => c.includes(k));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function getDateRange() {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  return {
    startdt: start.toISOString().slice(0, 10),
    enddt:   end.toISOString().slice(0, 10),
  };
}

// ---------- EDGAR fetch ----------
async function searchEDGAR(query, forms) {
  const { startdt, enddt } = getDateRange();
  const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(query)}`
    + `&forms=${forms}&dateRange=custom&startdt=${startdt}&enddt=${enddt}`
    + `&hits.hits.total=true&hits.hits._source=entity_name,file_date,form_type,period_of_report,entity_id`;

  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for query: ${query}`);
  return res.json();
}

async function fetchFilingText(entityId, accessionRaw, formType) {
  if (!entityId || !accessionRaw) return '';
  // Build accession number format: 0001234567-26-000001
  const acc = accessionRaw.replace(/[^0-9]/g, '');
  if (acc.length < 18) return '';
  const accFmt = `${acc.slice(0,10)}-${acc.slice(10,12)}-${acc.slice(12)}`;
  const accPath = accFmt.replace(/-/g,'');
  const indexUrl = `https://www.sec.gov/Archives/edgar/data/${entityId}/${accPath}/${accFmt}-index.htm`;

  try {
    const res = await fetch(indexUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return '';
    const html = await res.text();

    // Find the primary document link
    const docMatch = html.match(/href="([^"]+\.(?:htm|txt)[^"]*)"/i);
    if (!docMatch) return '';

    const docUrl = docMatch[1].startsWith('http')
      ? docMatch[1]
      : `https://www.sec.gov${docMatch[1]}`;

    const docRes = await fetch(docUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!docRes.ok) return '';
    const text = await docRes.text();
    return text.slice(0, 12000); // first 12k chars is plenty
  } catch(e) {
    return '';
  }
}

// ---------- Main ----------
async function main() {
  console.log(`[${new Date().toISOString()}] Starting EDGAR split scan...`);

  // Load existing log
  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).splits || []; }
    catch(e) { existing = []; }
  }
  const existingIds = new Set(existing.map(r => r.id));

  const newRecords = [];
  let totalHits = 0;

  for (const { q, forms } of QUERIES) {
    console.log(`  Querying: "${q}" [${forms}]`);
    try {
      const data = await searchEDGAR(q, forms);
      const hits = data?.hits?.hits || [];
      totalHits += hits.length;
      console.log(`    → ${hits.length} hits`);

      for (const hit of hits) {
        const id = hit._id;
        if (!id || existingIds.has(id)) continue;

        const src = hit._source || {};
        const company  = src.entity_name  || 'Unknown';
        const filedAt  = src.file_date    || '';
        const formType = src.form_type    || '';
        const entityId = src.entity_id    || '';

        // Try highlight snippets first, then fetch filing text
        const highlight = hit.highlight || {};
        let snippets = Object.values(highlight).flat().join(' ');

        if (!snippets || snippets.length < 50) {
          await sleep(300);
          snippets = await fetchFilingText(entityId, id, formType);
        }

        const extracted = extractDetails(snippets || company);

        // Skip if we can't determine it's actually a split
        if (!extracted.type || extracted.type === 'unknown') {
          if (!/split/i.test(snippets)) continue;
        }

        const record = {
          id,
          company,
          ticker:    extracted.ticker  || '',
          formType,
          filedAt,
          ratio:     extracted.ratio   || '',
          exDate:    extracted.exDate  || '',
          type:      extracted.type    || 'unknown',
          isETF:     isETF(company, formType),
          edgarUrl:  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entityId}&type=${formType}&dateb=&owner=include&count=10`,
          filingUrl: `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(company.slice(0,30))}%22&forms=${formType}&dateRange=custom&startdt=${filedAt}&enddt=${filedAt}`,
        };

        newRecords.push(record);
        existingIds.add(id);
        console.log(`    + ${company} | ${formType} | ${extracted.type} | ${extracted.ratio} | ex: ${extracted.exDate}`);
      }
    } catch(e) {
      console.error(`  ERROR on query "${q}": ${e.message}`);
    }

    await sleep(500); // be polite to EDGAR
  }

  // Merge and deduplicate
  const allRecords = [...existing, ...newRecords];
  const seen = new Set();
  const deduped = allRecords.filter(r => {
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });

  // Sort by filedAt descending
  deduped.sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));

  const output = {
    lastUpdated: new Date().toISOString(),
    totalRecords: deduped.length,
    newThisScan: newRecords.length,
    splits: deduped,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n✓ Done. ${newRecords.length} new | ${deduped.length} total | written to ${OUT_FILE}`);
}

main().catch(e => { console.error(e); process.exit(1); });
