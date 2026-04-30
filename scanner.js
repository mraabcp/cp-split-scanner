// scanner.js — SEC EDGAR Split Scanner v2
// Runs server-side via GitHub Actions, writes splits.json

import fetch from 'node-fetch';
import fs from 'fs';

const USER_AGENT = 'Cerity Partners split-scanner mraab@ceritypartners.com';
const OUT_FILE = 'splits.json';
const LOOKBACK_DAYS = 60;

const QUERIES = [
  { q: '"forward split" "ex-date"',        forms: '8-K,497' },
  { q: '"reverse stock split" "ex-date"',  forms: '8-K,497' },
  { q: '"stock split" "ex-date"',          forms: '8-K,497' },
  { q: '"forward share split"',            forms: '497'     },
  { q: '"share split" "payable date"',     forms: '497'     },
  { q: '"reverse split" "ex-date"',        forms: '8-K,497' },
  { q: '"split-adjusted basis"',           forms: '8-K,497' },
  { q: '"forward stock split" "ratio"',    forms: '8-K'     },
];

function extractDetails(text) {
  if (!text) return { type: 'unknown', ratio: '', exDate: '', ticker: '' };

  const isReverse = /reverse\s+(stock\s+)?split|1[- ]for[- ]\d+\s+reverse|consolidat/i.test(text);
  const isForward = /forward\s+(stock\s+|share\s+)?split|\d+\s*-\s*for\s*-\s*1\b/i.test(text);
  let type = 'unknown';
  if (isReverse && !isForward) type = 'reverse';
  else if (isForward) type = 'forward';
  else {
    const m = text.match(/(\d+)[- ]for[- ](\d+)/i);
    if (m) type = parseInt(m[1]) > parseInt(m[2]) ? 'forward' : 'reverse';
  }

  let ratio = '';
  const ratioTries = [
    /(\d+)[- ]for[- ](\d+)\s+(forward\s+)?(stock\s+|share\s+)?split/i,
    /(stock\s+|share\s+)?split.*?(\d+)[- ]for[- ](\d+)/i,
    /1[- ]for[- ](\d+)\s+reverse/i,
    /reverse.*?1[- ]for[- ](\d+)/i,
    /(\d+)[- ]for[- ](\d+)/i,
  ];
  for (const pat of ratioTries) {
    const m = text.match(pat);
    if (m) {
      if (pat.source.includes('reverse') && m.length === 2) {
        ratio = `1-for-${m[1]}`;
      } else {
        const nums = [...m].slice(1).filter(x => x && /^\d+$/.test(x));
        if (nums.length >= 2) ratio = `${nums[0]}-for-${nums[1]}`;
      }
      if (ratio) break;
    }
  }

  let exDate = '';
  const exTries = [
    /ex[- ]?(?:distribution\s+)?date[^:\n]*?:\s*([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /ex[- ]?(?:distribution\s+)?date[^:\n]*?:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:begin|commence)\s+trading[^A-Z\n]*?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /split-adjusted basis\s+(?:on\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /effective\s+(?:as of\s+)?([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /([A-Za-z]+ \d{1,2},?\s*\d{4})[,\s]+(?:the\s+)?\(?ex[- ]?date/i,
  ];
  for (const pat of exTries) {
    const m = text.match(pat);
    if (m && m[1]) { exDate = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  let ticker = '';
  const tickTries = [
    /\((?:nasdaq|nyse(?:arca|mkt)?|otc)[:\s]+([A-Z]{1,6})\)/i,
    /ticker(?:\s+symbol)?[:\s"]+([A-Z]{1,6})\b/i,
    /\bsymbol[:\s"]+([A-Z]{1,6})\b/i,
  ];
  for (const pat of tickTries) {
    const m = text.match(pat);
    if (m && m[1] && m[1].length <= 6) { ticker = m[1].toUpperCase(); break; }
  }

  return { type, ratio, exDate, ticker };
}

const ETF_KEYWORDS = ['etf','fund','trust',' ishares','vanguard','spdr','invesco',
  'wisdomtree','proshares','direxion','graniteshares','global x','abrdn','blackrock'];

function isETF(company = '', formType = '') {
  if (formType === '497') return true;
  return ETF_KEYWORDS.some(k => company.toLowerCase().includes(k));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchEDGAR(query, forms) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const startdt = start.toISOString().slice(0, 10);
  const enddt   = end.toISOString().slice(0, 10);

  // Use URLSearchParams for clean encoding
  const params = new URLSearchParams();
  params.set('q', query);
  params.set('forms', forms);
  params.set('dateRange', 'custom');
  params.set('startdt', startdt);
  params.set('enddt', enddt);

  const url = `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
  console.log(`    GET ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'application/json',
    }
  });

  const body = await res.text();
  console.log(`    → HTTP ${res.status} | body[0:200]: ${body.slice(0,200)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0,100)}`);
  return JSON.parse(body);
}

async function fetchFilingText(hit) {
  try {
    const accRaw = (hit._id || '').replace(/[^0-9]/g, '');
    const src = hit._source || {};
    const entityId = String(src.entity_id || '').padStart(10, '0');
    if (!accRaw || accRaw.length < 18 || entityId === '0000000000') return '';

    const accFmt = `${accRaw.slice(0,10)}-${accRaw.slice(10,12)}-${accRaw.slice(12)}`;
    const accPath = accFmt.replace(/-/g, '');
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(entityId)}/${accPath}/${accFmt}-index.htm`;

    const res = await fetch(indexUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return '';
    const html = await res.text();

    const matches = [...html.matchAll(/href="([^"]+\.htm[^"]*)"/gi)];
    const docLink = matches.find(m => !m[1].toLowerCase().includes('index'));
    if (!docLink) return '';

    const docUrl = docLink[1].startsWith('http') ? docLink[1] : `https://www.sec.gov${docLink[1]}`;
    const docRes = await fetch(docUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!docRes.ok) return '';
    return (await docRes.text()).slice(0, 15000);
  } catch(e) { return ''; }
}

async function main() {
  console.log(`\n=== SEC Split Scanner v2 — ${new Date().toISOString()} ===\n`);

  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).splits || []; }
    catch(e) { existing = []; }
  }
  const existingIds = new Set(existing.map(r => r.id));
  console.log(`Loaded ${existing.length} existing records.\n`);

  const newRecords = [];
  let totalHits = 0;

  for (const { q, forms } of QUERIES) {
    console.log(`\nQuery: "${q}" [${forms}]`);
    try {
      const data = await searchEDGAR(q, forms);
      const hits = data?.hits?.hits || [];
      const total = data?.hits?.total?.value ?? data?.hits?.total ?? hits.length;
      totalHits += hits.length;
      console.log(`  → ${hits.length} hits returned (${total} total matches)`);

      for (const hit of hits) {
        const id = hit._id;
        if (!id || existingIds.has(id)) continue;

        const src = hit._source || {};
        const company  = src.entity_name || (src.display_names?.[0]?.name) || 'Unknown';
        const filedAt  = src.file_date   || src.period_of_report || '';
        const formType = src.form_type   || '';
        const entityId = src.entity_id   || '';

        const highlight = hit.highlight || {};
        let snippets = Object.values(highlight).flat().join(' ')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

        if (snippets.length < 80) {
          console.log(`    Fetching doc for: ${company}`);
          await sleep(400);
          const doc = await fetchFilingText(hit);
          snippets = doc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        }

        const extracted = extractDetails(snippets);

        if (extracted.type === 'unknown' && !/split/i.test(snippets + company)) continue;

        const record = {
          id, company,
          ticker:   extracted.ticker  || '',
          formType, filedAt,
          ratio:    extracted.ratio   || '',
          exDate:   extracted.exDate  || '',
          type:     extracted.type    || 'unknown',
          isETF:    isETF(company, formType),
          edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entityId}&type=${formType}&dateb=&owner=include&count=10`,
        };

        newRecords.push(record);
        existingIds.add(id);
        console.log(`  + ${company} | ${formType} | ${extracted.type} | ${extracted.ratio} | ex:${extracted.exDate}`);
      }
    } catch(e) {
      console.error(`  ERROR: ${e.message}`);
    }
    await sleep(600);
  }

  const all = [...existing, ...newRecords];
  const seen = new Set();
  const deduped = all.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  deduped.sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    totalRecords: deduped.length,
    newThisScan:  newRecords.length,
    splits:       deduped,
  }, null, 2));

  console.log(`\n✓ Done. ${newRecords.length} new | ${deduped.length} total`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
