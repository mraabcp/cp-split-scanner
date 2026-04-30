// scanner.js — SEC EDGAR Split Scanner v5
import fetch from 'node-fetch';
import fs from 'fs';

const USER_AGENT = 'Cerity Partners split-scanner mraab@ceritypartners.com';
const OUT_FILE = 'splits.json';
const LOOKBACK_DAYS = 180;

const QUERIES = [
  { q: '"stock split"',   forms: '8-K'     },
  { q: '"reverse split"', forms: '8-K'     },
  { q: '"forward split"', forms: '8-K,497' },
  { q: '"share split"',   forms: '497'     },
  { q: '"stock split"',   forms: '497'     },
];

function parseDisplayName(displayNames) {
  if (!displayNames?.length) return { company: 'Unknown', ticker: '' };
  const raw = displayNames[0];
  // Format: "iSHARES TRUST  (IWF, IEFA)  (CIK 0001100663)"
  // or just: "iSHARES TRUST  (CIK 0001100663)"
  const tickerMatch = raw.match(/\(([A-Z]{1,6}(?:,\s*[A-Z]{1,6})*)\)\s+\(CIK/);
  const ticker = tickerMatch ? tickerMatch[1].split(',')[0].trim() : '';
  const company = raw.split('(')[0].trim() || raw;
  return { company, ticker };
}

function extractDetails(text) {
  if (!text) return { type: 'unknown', ratio: '', exDate: '' };
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Type detection
  const isReverse = /reverse\s+(stock\s+)?split|1[- ]for[- ]\d+\s+reverse/i.test(clean);
  const isForward = /forward\s+(stock\s+|share\s+)?split|\d+\s*-\s*for\s*-\s*1\b/i.test(clean);
  let type = 'unknown';
  if (isReverse && !isForward) type = 'reverse';
  else if (isForward) type = 'forward';
  else {
    const m = clean.match(/(\d+)[- ]for[- ](\d+)/i);
    if (m) type = parseInt(m[1]) > parseInt(m[2]) ? 'forward' : 'reverse';
  }

  // Ratio
  let ratio = '';
  const ratioTries = [
    /(\d+)[- ]for[- ](\d+)\s+(forward\s+)?(stock\s+|share\s+)?split/i,
    /split[^.]{0,40}?(\d+)[- ]for[- ](\d+)/i,
    /(\d+)[- ]for[- ](\d+)/i,
  ];
  for (const pat of ratioTries) {
    const m = clean.match(pat);
    if (m) {
      const nums = [...m].slice(1).filter(x => x && /^\d+$/.test(x));
      if (nums.length >= 2) { ratio = `${nums[0]}-for-${nums[1]}`; break; }
    }
  }

  // Ex-date — full month names to avoid truncation
  let exDate = '';
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
  const exTries = [
    new RegExp(`ex[- ]?(?:distribution\\s+)?date[^:\\n]{0,30}:\\s*((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`ex[- ]?date[^:\\n]{0,20}:\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4})`, 'i'),
    new RegExp(`(?:begin|commence)\\s+trading[^.\\n]{0,80}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`split-adjusted[^.\\n]{0,80}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`effective[^.\\n]{0,60}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})[^.\\n]{0,30}ex[- ]?date`, 'i'),
    new RegExp(`payable[^.\\n]{0,40}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
  ];
  for (const pat of exTries) {
    const m = clean.match(pat);
    if (m?.[1]) { exDate = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  // Also try to extract ETF ticker from document text
  let ticker = '';
  const tickTries = [
    /\((?:nasdaq|nyse(?:arca|mkt)?|otc|cboe)[:\s]+([A-Z]{1,6})\)/i,
    /ticker(?:\s+symbol)?[:\s"]+([A-Z]{1,6})\b/i,
    /trading\s+(?:symbol|under)[\s:"]+([A-Z]{1,6})\b/i,
    /listed\s+(?:on|under)[^.]{0,40}\(([A-Z]{1,6})\)/i,
    /symbol[:\s"]+([A-Z]{1,6})\b/i,
  ];
  for (const pat of tickTries) {
    const m = clean.match(pat);
    if (m?.[1]?.length <= 6 && m[1].length >= 1) { ticker = m[1].toUpperCase(); break; }
  }

  return { type, ratio, exDate, ticker };
}

// Skip these — they mention splits but aren't split filings
const NOISE_COMPANIES = ['clearway energy', 'marketwise', 'principal funds',
  'vanguard fenway', 'vanguard chester', 'vanguard malvern', 'vanguard windsor',
  'columbia funds', 'columbia etf', 'invesco exchange', 'invesco actively',
  'j.p. morgan exchange', 'goldman sachs trust', 'new york life',
  'american century', 'bny mellon', 'mml series', 'northern lights fund',
  'ea series trust', 'rayliant', 'proshares trust', 'vaneck etf'];

const ETF_KEYWORDS = ['etf','fund','trust','ishares','vanguard','spdr','invesco',
  'wisdomtree','proshares','direxion','graniteshares','global x','abrdn','blackrock',
  'tidal','themes etf','granite'];

function isETF(company = '', formType = '') {
  if (formType === '497') return true;
  return ETF_KEYWORDS.some(k => company.toLowerCase().includes(k));
}

function isNoise(company = '') {
  const c = company.toLowerCase();
  return NOISE_COMPANIES.some(n => c.includes(n));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function searchEDGAR(query, forms) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const params = new URLSearchParams({
    q: query, dateRange: 'custom',
    startdt: start.toISOString().slice(0, 10),
    enddt:   end.toISOString().slice(0, 10),
    forms,
  });
  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchFilingDoc(src, hitId) {
  try {
    const adsh    = src.adsh || hitId.split(':')[0];
    const cik     = (src.ciks?.[0] || '').replace(/\D/g, '');
    const docFile = hitId.includes(':') ? hitId.split(':')[1] : null;
    if (!adsh || !cik) return '';

    const accPath = adsh.replace(/-/g, '');
    let docUrl;

    if (docFile) {
      docUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accPath}/${docFile}`;
    } else {
      const idxUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accPath}/${adsh}-index.htm`;
      const r0 = await fetch(idxUrl, { headers: { 'User-Agent': USER_AGENT } });
      if (!r0.ok) return '';
      const html = await r0.text();
      const links = [...html.matchAll(/href="([^"]+\.htm[l]?)"/gi)]
        .map(m => m[1]).filter(l => !/index/i.test(l));
      if (!links.length) return '';
      docUrl = links[0].startsWith('http') ? links[0] : `https://www.sec.gov${links[0]}`;
    }

    const res = await fetch(docUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return '';
    return (await res.text()).slice(0, 15000);
  } catch(e) { return ''; }
}

async function main() {
  console.log(`\n=== SEC Split Scanner v5 — ${new Date().toISOString()} ===\n`);

  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).splits || []; }
    catch(e) { existing = []; }
  }
  const existingIds = new Set(existing.map(r => r.id));
  console.log(`Existing: ${existing.length}\n`);

  const newRecords = [];

  for (const { q, forms } of QUERIES) {
    console.log(`\nQuery: ${q} [${forms}]`);
    try {
      const data  = await searchEDGAR(q, forms);
      const hits  = data?.hits?.hits || [];
      const total = data?.hits?.total?.value ?? hits.length;
      console.log(`  ${hits.length} hits (${total} total)`);

      for (const hit of hits) {
        const id  = hit._id;
        if (!id || existingIds.has(id)) continue;

        const src = hit._source || {};
        const { company, ticker } = parseDisplayName(src.display_names);
        const filedAt  = src.file_date || '';
        const formType = src.form || src.root_forms?.[0] || '';
        const cik      = src.ciks?.[0] || '';

        if (isNoise(company)) { console.log(`  - noise: ${company}`); existingIds.add(id); continue; }

        await sleep(250);
        const docText = await fetchFilingDoc(src, id);
        const ex = extractDetails(docText);

        if (ex.type === 'unknown' && !/split/i.test(docText)) {
          console.log(`  - skip: ${company}`); existingIds.add(id); continue;
        }

        const record = {
          id, company,
          ticker:   ticker || ex.ticker || '',
          formType, filedAt,
          ratio:    ex.ratio  || '',
          exDate:   ex.exDate || '',
          type:     ex.type   || 'unknown',
          isETF:    isETF(company, formType),
          edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${formType}&dateb=&owner=include&count=10`,
        };

        newRecords.push(record);
        existingIds.add(id);
        console.log(`  + ${company} (${ticker}) | ${formType} | ${ex.type} | ${ex.ratio} | ex:${ex.exDate}`);
      }
    } catch(e) {
      console.error(`  ERROR: ${e.message}`);
    }
    await sleep(500);
  }

  const all  = [...existing, ...newRecords];
  const seen = new Set();
  const out  = all.filter(r => { if (seen.has(r.id)) return false; seen.add(r.id); return true; });
  out.sort((a, b) => (b.filedAt || '').localeCompare(a.filedAt || ''));

  fs.writeFileSync(OUT_FILE, JSON.stringify({
    lastUpdated:  new Date().toISOString(),
    totalRecords: out.length,
    newThisScan:  newRecords.length,
    splits:       out,
  }, null, 2));

  console.log(`\n✓ ${newRecords.length} new | ${out.length} total`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
