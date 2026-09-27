/**
 * Live procurement feeds: fetch, normalise to one record shape, and keep only
 * opportunities that are still open.
 *
 *   sam         SAM.gov Get Opportunities API v2 — US federal (needs SAM_API_KEY)
 *   canadabuys  CanadaBuys open tender notices — Government of Canada open data (no key)
 *   ted         TED Search API v3 — EU/EEA public tenders (no key)
 *   worldbank   World Bank procurement notices API — Bank-financed projects (no key)
 *
 * Every fetcher also returns `raw` diagnostics (HTTP status, record count, the
 * field names it actually received, and a few raw samples) so a format change
 * upstream shows up in /api/health and in the daily feed check instead of
 * silently returning nothing.
 */

import { getJson, setJson } from './store.js';

export const LABELS = { sam: 'SAM.gov', canadabuys: 'CanadaBuys', ted: 'EU TED', worldbank: 'World Bank' };
export const SOURCES = Object.keys(LABELS);
export const DEFAULT_KEYWORDS = ['calcium carbonate', 'limestone', 'aragonite', 'lime'];
export const MAX_KEYWORDS = 6;

const DAY = 86400000;
const SOURCE_TIMEOUT_MS = 25000;
const NO_DEADLINE_MAX_AGE_DAYS = 45; // notices without a deadline are kept only if posted this recently

// How long a source's results are reused before the upstream is asked again.
// SAM.gov keys without an entity role get 10 requests a day, so it is cached longest.
const CACHE_TTL_MS = { sam: 8 * 3600e3, canadabuys: 3 * 3600e3, ted: 3 * 3600e3, worldbank: 3 * 3600e3 };
const CACHE_VERSION = 'v1';
const memoryCache = new Map();

/** For tests: forget cached results held in this instance. */
export function clearFeedCache() { memoryCache.clear(); }

/* ------------------------------------------------------------------ helpers */

export const str = v => (v == null ? '' : String(v).trim());

export function parseList(raw, max) {
  return [...new Set(String(raw || '').split(',').map(k => k.trim().slice(0, 60)).filter(Boolean))].slice(0, max);
}

function mmddyyyy(d) {
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
}
function yyyymmdd(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/**
 * Normalises the date formats these sources use. Returns an ISO string with a
 * time when one is known, otherwise "YYYY-MM-DD" (treated as end of that day).
 */
export function normDate(value, time) {
  const s = str(Array.isArray(value) ? value[0] : value);
  if (!s) return '';
  let m = s.match(/^(\d{4}-\d{2}-\d{2})(Z|[+-]\d{2}:?\d{2})?$/); // 2026-10-26 or 2026-10-26+01:00
  if (m) {
    const t = str(Array.isArray(time) ? time[0] : time).match(/^(\d{2}:\d{2}(?::\d{2})?)(Z|[+-]\d{2}:?\d{2})?$/);
    if (t) return `${m[1]}T${t[1].length === 5 ? t[1] + ':00' : t[1]}${t[2] || m[2] || ''}`;
    return m[1];
  }
  m = s.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?(Z|[+-]00:?00)?$/); // midnight UTC means "this date"
  if (m) return m[1];
  m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2})?)(.*)$/);
  if (m) return `${m[1]}T${m[2]}${m[3] || ''}`.trim();
  m = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[a-z]*[- ,]+(\d{4})/); // 05-Jun-2026
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // 06/05/2026 (US)
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const t = Date.parse(s);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}

// Minutes a time zone is ahead of UTC at instant t (negative in the Americas).
function zoneOffsetMinutes(t, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(t));
  const g = type => Number(parts.find(p => p.type === type).value);
  return Math.round((Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t) / 60000);
}

/**
 * A wall-clock time with no offset ("2026-10-07T14:00:00") read in a named zone,
 * returned with that zone's offset on that date (handles daylight saving).
 * Anything that already carries an offset, or is date-only, is returned unchanged.
 */
export function inZone(value, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value || '');
  if (!m) return value;
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  let off = zoneOffsetMinutes(wall, timeZone);
  off = zoneOffsetMinutes(wall - off * 60000, timeZone);
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

export function toTime(normalized, endOfDay = true) {
  if (!normalized) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    // A date-only deadline stays open through the end of that day anywhere in the Americas.
    return Date.parse(`${normalized}T${endOfDay ? '23:59:59' : '00:00:00'}-10:00`);
  }
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? null : t;
}

export function isOpen(o, now) {
  const due = toTime(o.response_deadline);
  if (due != null) return due > now.getTime();
  if (o.keep_without_deadline) return true;
  const posted = toTime(o.posted_date, false);
  return posted != null && now.getTime() - posted < NO_DEADLINE_MAX_AGE_DAYS * DAY;
}

// First English (or first available) value from TED-style multilingual fields.
export function pickLang(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return pickLang(value[0]);
  if (typeof value === 'object') {
    for (const k of ['eng', 'ENG', 'en', 'EN']) if (value[k] != null) return pickLang(value[k]);
    return pickLang(Object.values(value)[0]);
  }
  return String(value);
}

function keywordRegexes(keywords) {
  return keywords.map(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}\\b`, 'i'));
}

// Some government sites refuse requests that don't identify themselves.
export const USER_AGENT = 'Mozilla/5.0 (compatible; AragoCorOpportunityEngine/1.0; +https://www.aragocorminerals.com)';

function getWithTimeout(url, init = {}) {
  const headers = { 'User-Agent': USER_AGENT, ...(init.headers || {}) };
  return fetch(url, { ...init, headers, signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS) });
}

// Truncated copy of a raw record for diagnostics (never includes an API key).
function sampleOf(record) {
  const out = {};
  for (const [k, v] of Object.entries(record || {})) {
    if (/api_key|description$/i.test(k)) continue;
    const text = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = text && text.length > 160 ? text.slice(0, 160) + '…' : v;
  }
  return out;
}

function rawInfo() {
  return { status: null, received: 0, fields: [], samples: [] };
}
function noteRaw(raw, records, status) {
  raw.status = status;
  raw.received += records.length;
  if (!raw.fields.length && records[0] && typeof records[0] === 'object') raw.fields = Object.keys(records[0]).slice(0, 60);
  for (const r of records) if (raw.samples.length < 3) raw.samples.push(sampleOf(r));
}

/* ------------------------------------------------------------------ SAM.gov */

export async function fetchSam(keywords, now, opts = {}) {
  const raw = rawInfo();
  const apiKey = process.env.SAM_API_KEY;
  if (!apiKey) return { items: [], errors: [{ status: 0, message: 'SAM_API_KEY is not set in Vercel.' }], raw };

  const base = {
    api_key: apiKey, limit: String(opts.limit || 1000), offset: '0',
    postedFrom: mmddyyyy(new Date(+now - 364 * DAY)), postedTo: mmddyyyy(now), // posted window may be at most 1 year
    rdlfrom: mmddyyyy(now), rdlto: mmddyyyy(new Date(+now + 364 * DAY))       // still accepting responses
  };
  const byId = new Map();
  const errors = [];

  for (const keyword of keywords) {
    let res;
    try {
      res = await getWithTimeout(`https://api.sam.gov/opportunities/v2/search?${new URLSearchParams({ ...base, title: keyword })}`, { headers: { Accept: 'application/json' } });
    } catch {
      errors.push({ keyword, status: 0, message: 'Couldn’t reach SAM.gov' });
      continue;
    }
    raw.status = res.status;
    if (res.status === 404) continue; // SAM.gov answers 404 when nothing matches
    if (res.status === 401 || res.status === 403) {
      errors.push({ keyword, status: res.status, message: 'SAM.gov rejected the API key. Generate a new one and update SAM_API_KEY.' });
      break;
    }
    if (res.status === 429) {
      errors.push({ keyword, status: 429, message: 'SAM.gov daily request limit reached' });
      break;
    }
    if (!res.ok) { errors.push({ keyword, status: res.status, message: `SAM.gov returned ${res.status}` }); continue; }
    let data;
    try { data = await res.json(); } catch { errors.push({ keyword, status: res.status, message: 'Unreadable response from SAM.gov' }); continue; }
    const records = Array.isArray(data && data.opportunitiesData) ? data.opportunitiesData : [];
    noteRaw(raw, records, res.status);

    for (const item of records) {
      if (!item || !item.noticeId || byId.has(item.noticeId)) continue;
      if (str(item.active).toLowerCase() === 'no') continue;
      const pop = item.placeOfPerformance || {};
      const contacts = Array.isArray(item.pointOfContact) ? item.pointOfContact.filter(Boolean) : [];
      const poc = contacts.find(p => p.type === 'primary') || contacts[0] || null;
      const path = str(item.fullParentPathName || item.department).split('.').map(s => s.trim()).filter(Boolean);
      byId.set(item.noticeId, {
        feed: 'sam',
        notice_id: str(item.noticeId),
        title: str(item.title) || 'Untitled notice',
        buyer: path.length > 1 ? `${path[0]} › ${path[path.length - 1]}` : (path[0] || ''),
        source: LABELS.sam,
        region: 'United States',
        solicitation_number: str(item.solicitationNumber),
        notice_type: str(item.type),
        posted_date: normDate(item.postedDate),
        response_deadline: normDate(item.responseDeadLine || item.reponseDeadLine),
        naics: str(item.naicsCode),
        psc: str(item.classificationCode),
        set_aside: str(item.typeOfSetAsideDescription || item.setAside),
        place_of_performance: [pop.city && pop.city.name, pop.state && (pop.state.code || pop.state.name)].filter(Boolean).join(', '),
        contact: poc ? { name: str(poc.fullName || poc.fullname), email: str(poc.email), phone: str(poc.phone) } : null,
        url: `https://sam.gov/opp/${encodeURIComponent(str(item.noticeId))}/view`,
        matched_keyword: keyword
      });
    }
  }
  return { items: [...byId.values()], errors, raw };
}

/* ------------------------------------------------------------------ CanadaBuys */

// RFC 4180 CSV parser: quoted fields, embedded commas and newlines, doubled quotes.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', i = 0, inQuotes = false;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function findCol(headers, ...patterns) {
  for (const p of patterns) {
    const i = headers.findIndex(h => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

export const CANADABUYS_URL = 'https://canadabuys.canada.ca/opendata/pub/openTenderNotice-ouvertAvisAppelOffres.csv';

export async function fetchCanadaBuys(keywords, now, opts = {}) {
  const raw = rawInfo();
  let res;
  try { res = await getWithTimeout(CANADABUYS_URL, { headers: { Accept: 'text/csv,text/plain;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-CA,en;q=0.9' } }); } catch { return { items: [], errors: [{ status: 0, message: 'Couldn’t reach CanadaBuys open data' }], raw }; }
  raw.status = res.status;
  if (!res.ok) return { items: [], errors: [{ status: res.status, message: `CanadaBuys returned ${res.status}` }], raw };

  const rows = parseCsv(await res.text());
  if (rows.length < 2) return { items: [], errors: [{ status: res.status, message: 'CanadaBuys file was empty' }], raw };
  const h = rows[0].map(x => x.trim());
  raw.fields = h.slice(0, 80);
  raw.received = rows.length - 1;
  const c = {
    title: findCol(h, /^title-titre-eng$/i, /^title.*eng/i, /^title/i),
    ref: findCol(h, /^referenceNumber/i),
    sol: findCol(h, /^solicitationNumber/i),
    closing: findCol(h, /^tenderClosingDate/i, /closingDate/i),
    published: findCol(h, /^publicationDate/i, /^amendmentDate/i),
    status: findCol(h, /^tenderStatus.*eng$/i, /^tenderStatus/i),
    buyer: findCol(h, /^contractingEntityName.*eng$/i, /^contractingEntityName/i),
    desc: findCol(h, /^tenderDescription.*eng$/i, /^tenderDescription/i),
    url: findCol(h, /^noticeURL.*eng$/i, /^noticeURL/i),
    region: findCol(h, /^regionsOfDelivery.*eng$/i, /^regionsOfDelivery/i),
    gsin: findCol(h, /^gsinDescription.*eng$/i, /^unspscDescription.*eng$/i),
    type: findCol(h, /^noticeType.*eng$/i, /^procurementMethod.*eng$/i),
    contactName: findCol(h, /^contactInfoName/i),
    contactEmail: findCol(h, /^contactInfoEmail/i),
    contactPhone: findCol(h, /^contactInfoPhone/i)
  };
  raw.columns = Object.fromEntries(Object.entries(c).map(([k, i]) => [k, i >= 0 ? h[i] : null]));
  for (const r of rows.slice(1, 4)) raw.samples.push(sampleOf(Object.fromEntries(h.map((name, i) => [name, r[i]]))));
  if (c.title < 0 || c.closing < 0) {
    return { items: [], errors: [{ status: 0, message: 'CanadaBuys file layout changed (title or closing date column not found)' }], raw };
  }

  const get = (r, k) => (c[k] >= 0 ? str(r[c[k]]) : '');
  const kwRes = keywordRegexes(keywords);
  const items = [];
  const seen = new Set();
  for (const r of rows.slice(1)) {
    if (r.length < 2) continue;
    const title = get(r, 'title');
    const desc = get(r, 'desc');
    const hit = kwRes.findIndex(re => re.test(`${title} ${desc} ${get(r, 'gsin')}`));
    if (hit < 0 && !opts.all) continue;
    if (/cancel|closed|expired|award/i.test(get(r, 'status'))) continue;
    const ref = get(r, 'ref') || get(r, 'sol') || title;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const contact = { name: get(r, 'contactName'), email: get(r, 'contactEmail'), phone: get(r, 'contactPhone') };
    const link = get(r, 'url');
    items.push({
      feed: 'canadabuys',
      notice_id: `canadabuys:${ref}`,
      title: title || 'Untitled tender',
      buyer: get(r, 'buyer'),
      source: LABELS.canadabuys,
      region: 'Canada',
      solicitation_number: get(r, 'sol') || get(r, 'ref'),
      notice_type: get(r, 'type'),
      posted_date: normDate(get(r, 'published')),
      response_deadline: inZone(normDate(get(r, 'closing')), 'America/Toronto'), // CanadaBuys times are Eastern
      place_of_performance: get(r, 'region'),
      contact: contact.name || contact.email || contact.phone ? contact : null,
      url: /^https?:\/\//i.test(link) ? link : 'https://canadabuys.canada.ca/en/tender-opportunities',
      sow_text: desc.slice(0, 4000),
      matched_keyword: hit >= 0 ? keywords[hit] : '',
      keep_without_deadline: true // this file lists only tenders CanadaBuys marks as open
    });
  }
  return { items, errors: [], raw };
}

/* ------------------------------------------------------------------ EU TED */

// TED's full-text search is loose (a search for "lime" also returns notices about
// "LIMS" software), and notice titles keep their free text in the original
// language. So TED results are kept only when some language version of the title
// names the material, in English or one of the main EU languages.
const TED_TERMS = {
  'calcium carbonate': ['calcium carbonate', 'carbonato de calcio', 'carbonato cálcico', 'carbonate de calcium', 'calciumcarbonat', 'kalziumkarbonat', 'calciumcarbonaat', 'carbonato di calcio', 'carbonato de cálcio', 'węglan wapnia', 'uhličitan vápenatý', 'kalciumkarbonat', 'kalsiumkarbonaatti', 'kalcium-karbonát', 'carbonat de calciu'],
  'limestone': ['limestone', 'caliza', 'piedra caliza', 'calcaire', 'pierre calcaire', 'kalkstein', 'kalksteinmehl', 'kalksteen', 'calcare', 'calcário', 'wapień', 'mączka wapienna', 'vápenec', 'kalksten', 'kalkkikivi', 'mészkő', 'calcar'],
  'aragonite': ['aragonite', 'aragonito', 'aragonit'],
  'lime': ['lime', 'agricultural lime', 'hydrated lime', 'quicklime', 'cal agrícola', 'cal hidratada', 'chaux', 'kalk', 'düngekalk', 'calce', 'cal viva', 'wapno', 'vápno', 'kalkki', 'mész', 'var']
};

function termRegex(term) {
  const body = term.normalize('NFC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

function tedMatcher(keywords) {
  const pairs = [];
  for (const k of keywords) {
    const terms = TED_TERMS[k.toLowerCase()] || [k];
    for (const t of terms) pairs.push([k, termRegex(t)]);
  }
  return text => {
    const hit = pairs.find(([, re]) => re.test(text.normalize('NFC')));
    return hit ? hit[0] : '';
  };
}

// Every language version of a TED multilingual field, joined for matching.
function allLang(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(allLang).join(' \n ');
  if (typeof value === 'object') return Object.values(value).map(allLang).join(' \n ');
  return String(value);
}

function tedLink(links, pub) {
  const html = links && typeof links === 'object' ? links.html : null;
  if (html && typeof html === 'object') {
    const url = html.ENG || html.eng || html.EN || Object.values(html)[0];
    if (typeof url === 'string' && /^https:\/\/ted\.europa\.eu\//.test(url)) return url;
  }
  return `https://ted.europa.eu/en/notice/-/detail/${encodeURIComponent(pub)}`;
}

export async function fetchTed(keywords, now, opts = {}) {
  const raw = rawInfo();
  const clean = k => k.replace(/["\\()]/g, ' ').replace(/\s+/g, ' ').trim();
  const ft = keywords.map(k => `FT~("${clean(k)}")`).join(' OR ');
  const since = yyyymmdd(new Date(+now - 180 * DAY));
  const fields = ['publication-number', 'notice-title', 'buyer-name', 'buyer-country', 'publication-date',
    'deadline-receipt-tender-date-lot', 'deadline-receipt-tender-time-lot'];
  const limit = opts.limit || 100;
  const maxPages = opts.maxPages || 3;

  // The first query is the precise one; the fallback drops the notice-type filter and
  // optional fields in case TED rejects either (it answers 400 for unknown names).
  const attempts = [
    { label: 'contract notices', query: `(${ft}) AND notice-type IN (cn-standard cn-social) AND PD>=${since} SORT BY publication-number DESC`, fields },
    { label: 'fallback', query: `(${ft}) AND PD>=${since} SORT BY publication-number DESC`, fields: ['publication-number', 'notice-title', 'buyer-name', 'publication-date', 'deadline-receipt-tender-date-lot'] }
  ];

  let lastError = null;
  for (const attempt of attempts) {
    const notices = [];
    let token = null, failed = false;
    for (let page = 0; page < maxPages; page++) {
      const body = { query: attempt.query, fields: attempt.fields, limit, scope: 'ACTIVE', paginationMode: 'ITERATION' };
      if (token) body.iterationNextToken = token;
      let res;
      try {
        res = await getWithTimeout('https://api.ted.europa.eu/v3/notices/search', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body)
        });
      } catch { lastError = { status: 0, message: 'Couldn’t reach the TED API' }; failed = true; break; }
      raw.status = res.status;
      if (!res.ok) {
        let detail = '';
        try { const j = await res.json(); detail = str(j.message || j.error || JSON.stringify(j)).slice(0, 200); } catch { /* ignore */ }
        lastError = { status: res.status, message: `TED returned ${res.status}${detail ? `: ${detail}` : ''}` };
        failed = true;
        break;
      }
      let data;
      try { data = await res.json(); } catch { lastError = { status: res.status, message: 'Unreadable response from TED' }; failed = true; break; }
      const batch = Array.isArray(data.notices) ? data.notices : [];
      noteRaw(raw, batch, res.status);
      raw.query = attempt.label;
      notices.push(...batch);
      token = data.iterationNextToken;
      if (!token || !batch.length) break;
    }
    if (failed && lastError && lastError.status === 400) continue; // try the simpler query
    if (failed) return { items: [], errors: [lastError], raw };

    const match = tedMatcher(keywords);
    const titleFilter = opts.titleFilter !== false;
    const items = [];
    raw.titleMatched = 0;
    for (const n of notices) {
      const pub = str(n['publication-number']);
      if (!pub) continue;
      const title = pickLang(n['notice-title']);
      const matched = match(allLang(n['notice-title']));
      if (matched) raw.titleMatched++;
      if (titleFilter && !matched) continue;
      const dates = [].concat(n['deadline-receipt-tender-date-lot'] || []);
      const times = [].concat(n['deadline-receipt-tender-time-lot'] || []);
      // Lots can close on different days: use the earliest deadline still in the future.
      const deadlines = dates.map((d, i) => normDate(d, times[i] || times[0])).filter(Boolean)
        .map(d => ({ d, t: toTime(d) })).filter(x => x.t != null).sort((a, b) => a.t - b.t);
      const next = deadlines.find(x => x.t > now.getTime()) || deadlines[deadlines.length - 1];
      const country = str([].concat(n['buyer-country'] || [])[0]);
      items.push({
        feed: 'ted',
        notice_id: `ted:${pub}`,
        title: title || `TED notice ${pub}`,
        buyer: [pickLang(n['buyer-name']), country].filter(Boolean).join(' · '),
        source: LABELS.ted,
        region: country || 'Europe',
        solicitation_number: pub,
        notice_type: 'Contract notice',
        posted_date: normDate(n['publication-date']),
        response_deadline: next ? next.d : '',
        url: tedLink(n.links, pub),
        matched_keyword: matched
      });
    }
    return { items, errors: [], raw };
  }
  return { items: [], errors: [lastError || { status: 0, message: 'TED search failed' }], raw };
}

/* ------------------------------------------------------------------ World Bank */

export async function fetchWorldBank(keywords, now, opts = {}) {
  const raw = rawInfo();
  const byId = new Map();
  const errors = [];
  for (const keyword of keywords) {
    const params = new URLSearchParams({ format: 'json', apilang: 'en', rows: String(opts.rows || 100), os: '0', qterm: keyword });
    let res;
    try { res = await getWithTimeout(`https://search.worldbank.org/api/v2/procnotices?${params}`, { headers: { Accept: 'application/json' } }); }
    catch { errors.push({ keyword, status: 0, message: 'Couldn’t reach the World Bank API' }); continue; }
    raw.status = res.status;
    if (!res.ok) { errors.push({ keyword, status: res.status, message: `World Bank returned ${res.status}` }); continue; }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch {
      errors.push({ keyword, status: res.status, message: `World Bank sent a non-JSON response (${text.slice(0, 40).replace(/\s+/g, ' ')}…)` });
      continue;
    }
    const container = data && data.procnotices;
    const list = Array.isArray(container) ? container
      : container && typeof container === 'object' ? Object.values(container).filter(v => v && typeof v === 'object')
      : [];
    noteRaw(raw, list, res.status);
    if (data && data.total != null) raw.total = data.total;

    for (const n of list) {
      const id = str(n.id);
      if (!id || byId.has(id)) continue;
      const type = str(n.notice_type);
      if (/award/i.test(type)) continue; // award notices aren't open opportunities
      if (/cancel|closed/i.test(str(n.notice_status))) continue;
      const title = str(n.bid_description || n.notice_text || n.project_name);
      byId.set(id, {
        feed: 'worldbank',
        notice_id: `worldbank:${id}`,
        title: title || `World Bank notice ${id}`,
        buyer: [str(n.contact_organization || n.project_name), str(n.project_ctry_name)].filter(Boolean).join(' · '),
        source: LABELS.worldbank,
        region: str(n.project_ctry_name),
        solicitation_number: str(n.bid_reference_no) || id,
        notice_type: type,
        posted_date: normDate(n.noticedate || n.notice_posted_date || n.publication_date),
        response_deadline: normDate(n.submission_deadline_date || n.submission_date || n.deadline_date),
        place_of_performance: str(n.project_ctry_name),
        url: `https://projects.worldbank.org/en/projects-operations/procurement-detail/${encodeURIComponent(id)}`,
        sow_text: str(n.project_name) && str(n.project_name) !== title ? `Project: ${str(n.project_name)}` : '',
        matched_keyword: keyword
      });
    }
  }
  return { items: [...byId.values()], errors, raw };
}

export const FETCHERS = { sam: fetchSam, canadabuys: fetchCanadaBuys, ted: fetchTed, worldbank: fetchWorldBank };

/* ------------------------------------------------------------------ cached loading */

function cacheKey(source, keywords) {
  return `oe:feed:${CACHE_VERSION}:${source}:${keywords.map(k => k.toLowerCase()).sort().join('|')}`;
}

function openOnly(items, now) {
  return items.filter(o => isOpen(o, now)).map(o => { const { keep_without_deadline, ...rest } = o; return rest; });
}

/**
 * Results for one source, from cache when fresh. Failed fetches are never cached,
 * so the next sync retries; a fresh failure falls back to the last good result.
 */
export async function loadSource(source, keywords, now = new Date(), { refresh = false } = {}) {
  const key = cacheKey(source, keywords);
  const ttl = CACHE_TTL_MS[source];
  const fresh = entry => entry && now.getTime() - entry.fetchedAt < ttl;

  if (!refresh) {
    const mem = memoryCache.get(key);
    if (fresh(mem)) return { ...mem, items: openOnly(mem.items, now), cached: true };
    const stored = await getJson(key);
    if (fresh(stored)) {
      memoryCache.set(key, stored);
      return { ...stored, items: openOnly(stored.items, now), cached: true };
    }
  }

  let result;
  try { result = await FETCHERS[source](keywords, now); }
  catch (err) { result = { items: [], errors: [{ status: 0, message: `${LABELS[source]} failed: ${err && err.message ? err.message : 'unknown error'}` }] }; }

  const items = openOnly(result.items, now);
  if (!result.errors.length) {
    const entry = { fetchedAt: now.getTime(), items, errors: [] };
    memoryCache.set(key, entry);
    await setJson(key, entry, (ttl / 1000) * 3); // kept longer than the TTL so it can serve as a fallback
    return { ...entry, cached: false };
  }

  // Partial or failed: return what was fetched, topped up by the last good result.
  const last = memoryCache.get(key) || (await getJson(key));
  if (last && last.items && last.items.length) {
    const ids = new Set(items.map(o => o.notice_id));
    const merged = items.concat(openOnly(last.items, now).filter(o => !ids.has(o.notice_id)));
    return { fetchedAt: last.fetchedAt, items: merged, errors: result.errors, cached: true, stale: true };
  }
  return { fetchedAt: now.getTime(), items, errors: result.errors, cached: false };
}
