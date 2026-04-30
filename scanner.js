// scanner.js — SEC EDGAR Split Scanner v3
import fetch from 'node-fetch';
import fs from 'fs';

const USER_AGENT = 'Cerity Partners split-scanner mraab@ceritypartners.com';
const OUT_FILE = 'splits.json';
const LOOKBACK_DAYS = 60;

// Simpler single-term queries avoid EDGAR 500 errors
const QUERIES = [
  { q: '"stock split"',          forms: '8-K'     },
  { q: '"reverse split"',        forms: '8-K'     },
  { q: '"forward split"',        forms: '8-K,497' },
  { q: '"share split"',          forms: '497'     },
  { q: '"split-adjusted"',       forms: '497'     },
  { q: '"stock split"',          forms: '497'     },
];

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
    /split[^.]*?(\d+)[- ]for[- ](\d+)/i,
    /1[- ]for[- ](\d+)\s+reverse/i,
    /reverse[^.]*?1[- ]for[- ](\d+)/i,
    /(\d+)[- ]for[- ](\d+)/i,
  ];
  for (const pat of ratioTries) {
    const m = clean.match(pat);
    if (m) {
      const nums = [...m].slice(1).filter(x => x && /^\d+$/.test(x));
      if (nums.length >= 2) { ratio = `${nums[0]}-for-${nums[1]}`; break; }
      else if (nums.length === 1 && pat.source.includes('reverse')) { ratio = `1-for-${nums[0]}`; break; }
    }
  }

  let exDate = '';
  const exTries = [
    /ex[- ]?(?:distribution\s+)?date[^:\n]{0,20}:\s*([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /ex[- ]?date[^:\n]{0,20}:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    /(?:begin|commence)\s+trading[^.\n]{0,60}([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /split-adjusted[^.\n]{0,60}([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /effective[^.\n]{0,40}([A-Za-z]+ \d{1,2},?\s*\d{4})/i,
    /([A-Za-z]+ \d{1,2},?\s*\d{4})[^.\n]{0,30}ex[- ]?date/i,
  ];
  for (const pat of exTries) {
    const m = clean.match(pat);
    if (m?.[1]) { exDate = m[1].trim().replace(/\s+/g, ' '); break; }
  }

  let ticker = '';
  const tickTries = [
    /\((?:nasdaq|nyse(?:arca|mkt)?|otc)[:\s]+([A-Z]{1,6})\)/i,
    /ticker(?:\s+symbol)?[:\s"]+([A-Z]{1,6})\b/i,
    /\bsymbol[:\s"]+([A-Z]{1,6})\b/i,
  ];
  for (const pat of tickTries) {
    const m = clean.match(pat);
    if (m?.[1]?.length <= 6) { ticker = m[1].toUpperCase(); break; }
  }

  return { type, ratio, exDate, ticker };
}

const ETF_KEYWORDS = ['etf','fund','trust','ishares','vanguard','spdr','invesco',
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

  // Use the EDGAR full-text search UI endpoint which returns proper _source fields
  const params = new URLSearchParams({
    q:         query,
    dateRange: 'custom',
    startdt:   start.toISOString().slice(0, 10),
    enddt:     end.toISOString().slice(0, 10),
    forms:     forms,
  });

  const url = `https://efts.sec.gov/LATEST/search-index?${params}`;
  console.log(`  GET ${url}`);

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  });

  const body = await res.text();
  console.log(`  HTTP ${res.status} | preview: ${body.slice(0, 300)}`);

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(body);
}

async function fetchFilingDoc(hit) {
  try {
    const src = hit._source || {};
    // EDGAR search results have a 'file_date' and accession in _id
    const accRaw = (hit._id || '').replace(/[^0-9]/g, '');
    if (accRaw.length < 18) return '';

    // entity_id may come back as array or string
    const eid = Array.isArray(src.entity_id) ? src.entity_id[0] : src.entity_id;
    if (!eid) return '';

    const accFmt  = `${accRaw.slice(0,10)}-${accRaw.slice(10,12)}-${accRaw.slice(12)}`;
    const accPath = accFmt.replace(/-/g, '');
    const cik     = String(eid).replace(/\D/g,'');

    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${parseInt(cik)}/${accPath}/${accFmt}-index.htm`;
    console.log(`    index: ${indexUrl}`);

    const r1 = await fetch(indexUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!r1.ok) { console.log(`    index HTTP ${r1.status}`); return ''; }
    const html = await r1.text();

    // Find primary doc (first .htm that isn't the index)
    const links = [...html.matchAll(/href="([^"]+\.htm[l]?)"/gi)]
      .map(m => m[1])
      .filter(l => !/index/i.test(l));

    if (!links.length) { console.log('    no doc links found'); return ''; }

    const docUrl = links[0].startsWith('http') ? links[0] : `https://www.sec.gov${links[0]}`;
    console.log(`    doc: ${docUrl}`);

    const r2 = await fetch(docUrl, { headers: { 'User-Agent': USER_AGENT } });
    if (!r2.ok) return '';
    return (await r2.text()).slice(0, 15000);
  } catch(e) {
    console.log(`    fetchFilingDoc error: ${e.message}`);
    return '';
  }
}

async function main() {
  console.log(`\n=== SEC Split Scanner v3 — ${new Date().toISOString()} ===\n`);

  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).splits || []; }
    catch(e) { existing = []; }
  }
  const existingIds = new Set(existing.map(r => r.id));
  console.log(`Existing records: ${existing.length}\n`);

  const newRecords = [];

  for (const { q, forms } of QUERIES) {
    console.log(`\nQuery: ${q} [${forms}]`);
    try {
      const data = await searchEDGAR(q, forms);
      const hits  = data?.hits?.hits || [];
      const total = data?.hits?.total?.value ?? hits.length;
      console.log(`  ${hits.length} hits (${total} total)`);

      // Log raw _source of first hit so we know what fields are available
      if (hits.length > 0) {
        console.log(`  SAMPLE _source keys: ${Object.keys(hits[0]._source || {}).join(', ')}`);
        console.log(`  SAMPLE _source: ${JSON.stringify(hits[0]._source).slice(0, 400)}`);
        console.log(`  SAMPLE highlight: ${JSON.stringify(hits[0].highlight || {}).slice(0, 400)}`);
      }

      for (const hit of hits) {
        const id = hit._id;
        if (!id || existingIds.has(id)) continue;

        const src      = hit._source || {};
        const hl       = hit.highlight || {};

        // Try every plausible field name for company/entity
        const company  = src.entity_name
          || src.company_name
          || src.display_name
          || (Array.isArray(src.display_names) ? src.display_names[0]?.name : null)
          || src.filer_name
          || 'Unknown';

        const filedAt  = src.file_date || src.period_of_report || src.filed || '';
        const formType = src.form_type || src.type || '';
        const entityId = Array.isArray(src.entity_id) ? src.entity_id[0]
                       : (src.entity_id || src.cik || '');

        // Highlight snippets first
        let text = Object.values(hl).flat().join(' ');

        // Fetch filing doc if snippets too short
        if (text.replace(/<[^>]+>/g, '').length < 80) {
          await sleep(400);
          text = await fetchFilingDoc(hit);
        }

        const ex = extractDetails(text);
        if (ex.type === 'unknown' && !/split/i.test(text + company)) continue;

        const record = {
          id, company,
          ticker:   ex.ticker   || '',
          formType, filedAt,
          ratio:    ex.ratio    || '',
          exDate:   ex.exDate   || '',
          type:     ex.type     || 'unknown',
          isETF:    isETF(company, formType),
          edgarUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${entityId}&type=${formType}&dateb=&owner=include&count=10`,
        };

        newRecords.push(record);
        existingIds.add(id);
        console.log(`  + [${formType}] ${company} | ${ex.type} | ${ex.ratio} | ex:${ex.exDate} | tick:${ex.ticker}`);
      }
    } catch(e) {
      console.error(`  ERROR: ${e.message}`);
    }
    await sleep(700);
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
