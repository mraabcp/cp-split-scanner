// scanner.js — SEC EDGAR Split Scanner v8
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

// ── Noise lists ──────────────────────────────────────────────────────────────
const NOISE_LIST = [
  'principal funds','vanguard fenway','vanguard chester','vanguard malvern','vanguard windsor',
  'vanguard admiral','columbia funds','columbia etf trust i','columbia etf trust ii',
  'invesco exchange-traded fund trust','invesco actively managed','j.p. morgan exchange',
  'goldman sachs trust','new york life','american century','bny mellon','mml series',
  'northern lights fund','ea series trust','rayliant','proshares trust','vaneck etf',
  'spdr dow jones','spdr s&p 500 etf trust','spdr s&p midcap','select sector spdr',
  'state street institutional','fidelity salem','fidelity concord','fidelity investment trust',
  'parnassus','gabelli','neuberger berman equity','mutual fund & variable','mutual fund series trust',
  'first eagle','cash account trust','innovator etfs','listed funds trust','touchstone etf',
  'capital-force','ubs series','calvert','chesapeake investment','proshares trust ii',
  'baillie gifford etf','payden','credit suisse opportunity','truth social funds',
  'first trust exchange','eaton vance','ultimus','world funds','pimco funds','wisdomtree trust',
  'vegashares','rbb fund','rbb fund trust','clearway energy','marketwise',
  'moa funds','ridgefield acquisition','lxp industrial','entrepreneur universe','momentus inc',
  'boxlight corp','22nd century','wheeler real estate','tilray','phoenix motor','374water',
  'interactive strength','strive, inc','bonk, inc','leafbuyer','yijia group','brooqly',
  'sunshine biopharma','teucrium','lifeward','bnb plus corp','sharonai','ai era corp',
  'protext mobility','awaysis capital','birchtech corp','dbx etf','hsbc funds',
  'exchange place advisors','neuberger berman etf','columbia funds series',
  'invesco exchange-traded fund trust ii','advisors series trust','lord abbett trust',
  'vela funds','pace select advisors','morgan stanley etf','uscf etf','amplify etf',
  'investment managers series trust','trust for professional managers','direxion shares etf',
  'vaneck funds','abrdn funds','etf series solutions','marketwise',
];

const ETF_KEYWORDS = ['etf','fund','trust','ishares','vanguard','spdr','invesco',
  'wisdomtree','proshares','direxion','graniteshares','global x','abrdn','blackrock',
  'tidal','themes etf','granite','volatility shares','valkyrie'];

function isETF(company = '', formType = '') {
  if (formType === '497') return true;
  return ETF_KEYWORDS.some(k => company.toLowerCase().includes(k));
}

function isNoise(company = '') {
  const c = company.toLowerCase();
  return NOISE_LIST.some(n => c.includes(n));
}

// ── ETF 497 table parser ─────────────────────────────────────────────────────
// iShares/BlackRock 497s contain pipe-delimited tables like:
// | Fund Name | Ticker | Forward Split Ratio |
// | iShares Russell 1000 Growth ETF | IWF | 4:1 |
function parseETFTable(text) {
  const results = [];
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  // Find table rows with ticker and ratio
  // Pattern: | Fund Name | TICKER | N:M | or | N:M |
  const rowReg = /\|\s*([^|]{5,60})\s*\|\s*([A-Z]{1,6})\s*\|\s*(\d+)\s*:\s*(\d+)\s*\|/g;
  let m;
  while ((m = rowReg.exec(clean)) !== null) {
    const [, fundName, ticker, num, den] = m;
    if (/fund name|ticker|ratio/i.test(fundName)) continue; // skip header rows
    const n = parseInt(num), d = parseInt(den);
    const type = n > d ? 'forward' : 'reverse';
    const ratio = type === 'forward' ? `${n}-for-${d}` : `1-for-${d}`;
    results.push({ fundName: fundName.trim(), ticker: ticker.trim(), ratio, type });
  }

  // Also try: | Fund Name | Ticker | N-for-M |
  const rowReg2 = /\|\s*([^|]{5,60})\s*\|\s*([A-Z]{1,6})\s*\|\s*(\d+)[- ]for[- ](\d+)\s*\|/gi;
  while ((m = rowReg2.exec(clean)) !== null) {
    const [, fundName, ticker, num, den] = m;
    if (/fund name|ticker|ratio/i.test(fundName)) continue;
    const n = parseInt(num), d = parseInt(den);
    const type = n > d ? 'forward' : 'reverse';
    const ratio = type === 'forward' ? `${n}-for-${d}` : `1-for-${d}`;
    // Don't duplicate
    if (!results.find(r => r.ticker === ticker.trim())) {
      results.push({ fundName: fundName.trim(), ticker: ticker.trim(), ratio, type });
    }
  }

  return results;
}

// Extract ex-dates per ticker from ETF filing text
function extractETFExDates(text) {
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Oct\\.?|Nov\\.?|Dec\\.?';
  const dateReg = new RegExp(`((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'gi');
  const dates = [];
  let m;
  while ((m = dateReg.exec(clean)) !== null) dates.push(m[1].trim().replace(/\s+/g,' '));
  // Return all unique dates found — caller can assign to funds
  return [...new Set(dates)];
}

// ── 8-K parser ───────────────────────────────────────────────────────────────
function extractDetails(text) {
  if (!text) return { type: 'unknown', ratio: '', exDate: '', ticker: '' };
  const clean = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const isReverse = /reverse\s+(stock\s+)?split|1[- ]for[- ]\d+\s+reverse/i.test(clean);
  const isForward = /forward\s+(stock\s+|share\s+)?split|\d+\s*-\s*for\s*-\s*1\b/i.test(clean);
  let type = 'unknown';
  if (isReverse && !isForward) type = 'reverse';
  else if (isForward) type = 'forward';
  else {
    const m = clean.match(/(\d+)[- ]for[- ](\d+)/i);
    if (m) type = parseInt(m[1]) > parseInt(m[2]) ? 'forward' : 'reverse';
  }

  let ratio = '';
  const ratioTries = [
    /(\d+)[- ]for[- ](\d+)\s+(forward\s+)?(stock\s+|share\s+)?split/i,
    /split[^.]{0,40}?(\d+)[- ]for[- ](\d+)/i,
    /(\d+)\s*:\s*(\d+)\s*(?:forward|reverse|stock|share)?\s*split/i,
    /(\d+)[- ]for[- ](\d+)/i,
  ];
  for (const pat of ratioTries) {
    const m = clean.match(pat);
    if (m) {
      const nums = [...m].slice(1).filter(x => x && /^\d+$/.test(x));
      if (nums.length >= 2) { ratio = `${nums[0]}-for-${nums[1]}`; break; }
    }
  }

  const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.?|Feb\\.?|Mar\\.?|Apr\\.?|Jun\\.?|Jul\\.?|Aug\\.?|Sep\\.?|Oct\\.?|Nov\\.?|Dec\\.?';
  let exDate = '';
  const exTries = [
    new RegExp(`ex[- ]?(?:distribution\\s+)?date[^:\\n]{0,30}:\\s*((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`ex[- ]?date[^:\\n]{0,20}:\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4})`, 'i'),
    new RegExp(`(?:begin|commence|start)\\s+trading[^.\\n]{0,80}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`split-adjusted[^.\\n]{0,80}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`effective[^.\\n]{0,60}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
    new RegExp(`((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})[^.\\n]{0,30}ex[- ]?date`, 'i'),
    new RegExp(`payable[^.\\n]{0,40}((?:${MONTHS})\\s+\\d{1,2},?\\s*\\d{4})`, 'i'),
  ];
  for (const pat of exTries) {
    const m = clean.match(pat);
    if (m?.[1]) { exDate = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  let ticker = '';
  const tickTries = [
    /\((?:nasdaq(?:gm|gs|cm)?|nyse(?:arca|mkt)?|cboe|bats)[:\s]+([A-Z]{1,6})\)/i,
    /ticker\s+symbol[:\s"]+([A-Z]{1,6})\b/i,
    /trading\s+(?:symbol|under\s+the\s+symbol)[:\s"]+([A-Z]{1,6})\b/i,
    /trades?\s+under\s+(?:the\s+)?(?:ticker|symbol)[:\s"]+([A-Z]{1,6})\b/i,
    /ticker\s+symbol\s+is\s+([A-Z]{2,6})\b/i,
    /\bsymbol[:\s"]+([A-Z]{2,6})\b/i,
  ];
  for (const pat of tickTries) {
    const m = clean.match(pat);
    if (m?.[1]?.length >= 2 && m[1].length <= 6) { ticker = m[1].toUpperCase(); break; }
  }

  return { type, ratio, exDate, ticker };
}

// Is this actually a split announcement? Require at least ratio OR clear split language
function isSplitAnnouncement(text, type, ratio, exDate) {
  if (ratio) return true;
  if (exDate) return true;
  if (type !== 'unknown') return true;
  // Require explicit announcement language
  return /(?:announces?|authorized?|approv|effectuat|declared?)\s+(?:a\s+)?(?:reverse|forward)?\s*(?:stock\s+)?split/i.test(text);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseDisplayName(displayNames) {
  if (!displayNames?.length) return { company: 'Unknown', ticker: '' };
  const raw = displayNames[0];
  const tickerMatch = raw.match(/\(([A-Z]{1,6}(?:,\s*[A-Z]{1,6})*)\)\s+\(CIK/);
  const ticker = tickerMatch ? tickerMatch[1].split(',')[0].trim() : '';
  const company = raw.split('(')[0].trim() || raw;
  return { company, ticker };
}

async function searchPage(query, forms, from) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - LOOKBACK_DAYS);
  const params = new URLSearchParams({
    q: query, dateRange: 'custom',
    startdt: start.toISOString().slice(0, 10),
    enddt:   end.toISOString().slice(0, 10),
    forms, from: String(from),
  });
  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getAllHits(query, forms, existingIds) {
  const allHits = [];
  let from = 0, pageNum = 0;
  while (pageNum < 40) {
    const data = await searchPage(query, forms, from);
    const hits = data?.hits?.hits || [];
    const total = data?.hits?.total?.value ?? 0;
    const newHits = hits.filter(h => h._id && !existingIds.has(h._id));
    allHits.push(...newHits);
    console.log(`  page ${pageNum+1}: ${hits.length} returned, ${newHits.length} new (${total} total)`);
    from += hits.length;
    pageNum++;
    if (hits.length === 0 || from >= total) break;
    if (newHits.length === 0) { console.log(`  all known — stopping`); break; }
    await sleep(600);
  }
  return allHits;
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
    return (await res.text()).slice(0, 20000);
  } catch(e) { return ''; }
}

async function main() {
  console.log(`\n=== SEC Split Scanner v8 — ${new Date().toISOString()} ===\n`);

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
      const hits = await getAllHits(q, forms, existingIds);
      console.log(`  processing ${hits.length} new hits`);

      for (const hit of hits) {
        const id  = hit._id;
        if (!id || existingIds.has(id)) continue;

        const src = hit._source || {};
        const { company, ticker: displayTicker } = parseDisplayName(src.display_names);
        const filedAt  = src.file_date || '';
        const formType = src.form || src.root_forms?.[0] || '';
        const cik      = src.ciks?.[0] || '';

        if (isNoise(company)) { existingIds.add(id); continue; }

        await sleep(200);
        const docText = await fetchFilingDoc(src, id);

        // ── ETF 497 filing: parse table rows → one record per fund ───────────
        if (formType === '497' || formType?.startsWith('497')) {
          const tableRows = parseETFTable(docText);
          if (tableRows.length > 0) {
            const exDates = extractETFExDates(docText);
            tableRows.forEach((row, i) => {
              const recId = `${id}:${row.ticker}`;
              if (existingIds.has(recId)) return;
              const record = {
                id: recId,
                company: row.fundName || company,
                ticker: row.ticker,
                formType, filedAt,
                ratio:  row.ratio,
                exDate: exDates[i] || exDates[0] || '',
                type:   row.type,
                isETF:  true,
                edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=497&dateb=&owner=include&count=10`,
              };
              newRecords.push(record);
              existingIds.add(recId);
              existingIds.add(id); // also mark base id
              console.log(`  + [ETF] ${row.fundName} (${row.ticker}) | ${row.type} | ${row.ratio} | ex:${record.exDate}`);
            });
            continue;
          }
          // If no table found, fall through to regular extraction
        }

        // ── 8-K filing: standard extraction ─────────────────────────────────
        const ex = extractDetails(docText);

        // Strict signal check — skip if no real split announcement
        if (!isSplitAnnouncement(docText, ex.type, ex.ratio, ex.exDate)) {
          existingIds.add(id);
          continue;
        }

        const ticker = displayTicker || ex.ticker || '';
        const record = {
          id, company, ticker, formType, filedAt,
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
