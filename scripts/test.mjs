#!/usr/bin/env node
/**
 * Offline tests: every upstream (SAM.gov, CanadaBuys, TED, World Bank, Redis) is
 * replaced by a fixture, so this runs anywhere with no keys and no network.
 *   npm test
 */

import assert from 'node:assert/strict';
import { GET as getOpportunities } from '../api/opportunities.js';
import { GET as getState, POST as postState } from '../api/state.js';
import { GET as getHealth } from '../api/health.js';
import middleware from '../middleware.js';
import { parseCsv, normDate, isOpen, clearFeedCache, inZone } from '../lib/feeds.js';

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (err) { console.error(`FAIL ${name}\n     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`); process.exitCode = 1; }
}

/* ---------------------------------------------------------------- fixtures */
const NOW = Date.now();
const day = n => new Date(NOW + n * 864e5).toISOString().slice(0, 10);
const calls = [];
let samMode = 'ok', tedMode = 'ok', wbMode = 'ok';

const csvEsc = v => `"${String(v).replace(/"/g, '""')}"`;
const CSV_HEAD = ['title-titre-eng', 'title-titre-fra', 'referenceNumber-numeroReference', 'solicitationNumber-numeroSollicitation', 'publicationDate-datePublication', 'tenderClosingDate-appelOffresDateCloture', 'tenderStatus-appelOffresStatut-eng', 'contractingEntityName-nomEntitContractante-eng', 'tenderDescription-descriptionAppelOffres-eng', 'noticeURL-URLavis-eng'];
const CSV_ROWS = [
  ['Supply of Limestone, Crushed', 'Fourniture', 'PW-26-001', 'W0120-26', day(-5), day(10) + 'T14:00:00', 'Open', 'Parks Canada', 'Agricultural limestone,\nbulk "super sacks"', 'https://canadabuys.canada.ca/en/tender-opportunities/tender-notice/pw-26-001'],
  ['IT services', 'x', 'PW-26-002', 'W1', day(-5), day(10), 'Open', 'SSC', 'Cloud', 'https://x.example'],
  ['Calcium carbonate reagent', 'x', 'PW-26-003', 'W2', day(-30), day(-2), 'Open', 'DFO', 'reagent', 'https://y.example'],
  ['Sublime lime wash', 'x', 'PW-26-004', 'W3', day(-3), day(20), 'Cancelled', 'DFO', 'lime', 'https://z.example']
];
const CSV = '﻿' + [CSV_HEAD, ...CSV_ROWS].map(r => r.map(csvEsc).join(',')).join('\r\n') + '\r\n';

// In-memory stand-in for Upstash Redis (only the commands the app uses).
const redis = { strings: new Map(), sets: new Map(), hashes: new Map() };
function runRedis([cmd, key, ...args]) {
  const set = () => redis.sets.get(key) || redis.sets.set(key, new Set()).get(key);
  const hash = () => redis.hashes.get(key) || redis.hashes.set(key, new Map()).get(key);
  switch (cmd) {
    case 'PING': return 'PONG';
    case 'GET': return redis.strings.has(key) ? redis.strings.get(key) : null;
    case 'SET': redis.strings.set(key, args[0]); return 'OK';
    case 'DEL': redis.strings.delete(key); redis.sets.delete(key); redis.hashes.delete(key); return 1;
    case 'SADD': set().add(args[0]); return 1;
    case 'SREM': set().delete(args[0]); return 1;
    case 'SMEMBERS': return [...(redis.sets.get(key) || [])];
    case 'HSET': hash().set(args[0], args[1]); return 1;
    case 'HDEL': hash().delete(args[0]); return 1;
    case 'HGETALL': return [...(redis.hashes.get(key) || new Map())].flat();
    default: throw new Error('unsupported ' + cmd);
  }
}

globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  calls.push(url);
  if (url.startsWith('https://redis.test/')) {
    const cmds = JSON.parse(init.body);
    return Response.json(cmds.map(c => ({ result: runRedis(c) })));
  }
  if (url.includes('api.sam.gov')) {
    if (samMode === 'limit') return new Response('{}', { status: 429 });
    const kw = new URL(url).searchParams.get('title');
    if (kw === 'aragonite') return new Response('none', { status: 404 });
    return Response.json({ opportunitiesData: [
      { noticeId: 'S1', title: 'Calcium carbonate for water treatment', solicitationNumber: '140R-26-Q-0042', fullParentPathName: 'INTERIOR, DEPARTMENT OF THE.BUREAU OF RECLAMATION.LOWER COLORADO', responseDeadLine: day(5) + 'T14:00:00-04:00', postedDate: day(-3), active: 'Yes', api_key_echo: 'x' },
      { noticeId: 'S2', title: 'Archived', responseDeadLine: day(5), active: 'No' },
      { noticeId: 'S3', title: 'Past due', responseDeadLine: day(-1) + 'T10:00:00-04:00', active: 'Yes' }
    ] });
  }
  if (url.includes('canadabuys')) return new Response(CSV, { headers: { 'content-type': 'text/csv' } });
  if (url.includes('api.ted.europa.eu')) {
    const body = JSON.parse(init.body);
    if (tedMode === '400first' && body.query.includes('notice-type')) return Response.json({ message: 'Unknown field' }, { status: 400 });
    if (tedMode === 'down') return new Response('x', { status: 503 });
    return Response.json({ notices: [
      { 'publication-number': '656715-2026', 'notice-title': { eng: ['Spain – Limestone for remineralisation'] }, 'buyer-name': { spa: ['Canal de Isabel II'] }, 'buyer-country': ['ESP'], 'publication-date': day(-4) + '+02:00', 'deadline-receipt-tender-date-lot': [day(-1) + '+01:00', day(12) + '+01:00'], 'deadline-receipt-tender-time-lot': ['16:00:00+01:00'] },
      { 'publication-number': '600000-2026', 'notice-title': { eng: 'Old water notice' }, 'deadline-receipt-tender-date-lot': [day(-4) + '+01:00'] },
      { 'publication-number': '600010-2026', 'notice-title': { eng: 'Sweden – Software supply services – IT system LIMS KGG 2026' }, 'deadline-receipt-tender-date-lot': [day(20) + '+01:00'] },
      { 'publication-number': '600020-2026', 'notice-title': { eng: 'Spain – Water-treatment chemicals – Suministro de carbonato cálcico para la ETAP', spa: 'España – Productos químicos – Suministro de carbonato cálcico para la ETAP' }, 'deadline-receipt-tender-date-lot': [day(25) + '+01:00'] }
    ], totalNoticeCount: 2, iterationNextToken: null });
  }
  if (url.includes('search.worldbank.org')) {
    if (wbMode === 'xml') return new Response('<?xml version="1.0"?><procnotices/>', { headers: { 'content-type': 'text/xml' } });
    return Response.json({ total: 3, procnotices: [
      { id: 'OP1', notice_type: 'Invitation for Bids', bid_description: 'Supply of agricultural lime', project_name: 'Ag Resilience', project_ctry_name: 'Jamaica', submission_deadline_date: day(15) + 'T00:00:00Z', noticedate: '20-Sep-2026' },
      { id: 'OP2', notice_type: 'Contract Award', bid_description: 'Award', submission_deadline_date: day(15) },
      { id: 'OP3', notice_type: 'Request for Expression of Interest', bid_description: 'Old, no deadline', noticedate: '01-Jan-2020' }
    ] });
  }
  throw new Error('unexpected fetch ' + url);
};

const req = (path, init = {}) => new Request('https://oe.test' + path, init);
const basic = (user, pass) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

/* ---------------------------------------------------------------- helpers */
await test('CSV parser handles quotes, commas and newlines', () => {
  const rows = parseCsv('﻿a,b\r\n"x, y","line1\nline2 ""q"""\r\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'line1\nline2 "q"']]);
});

await test('dates from every source normalise', () => {
  assert.equal(normDate('2026-10-26+01:00', '16:00:00+01:00'), '2026-10-26T16:00:00+01:00');
  assert.equal(normDate('2026-10-26'), '2026-10-26');
  assert.equal(normDate('2026-10-26T00:00:00Z'), '2026-10-26');
  assert.equal(normDate('05-Jun-2026'), '2026-06-05');
  assert.equal(normDate('06/05/2026'), '2026-06-05');
  assert.equal(normDate('2026-10-15T14:00:00-04:00'), '2026-10-15T14:00:00-04:00');
  assert.equal(normDate(''), '');
});

await test('CanadaBuys closing times are read as Eastern time, including daylight saving', () => {
  assert.equal(inZone('2026-10-07T14:00:00', 'America/Toronto'), '2026-10-07T14:00:00-04:00');
  assert.equal(inZone('2026-12-07T14:00:00', 'America/Toronto'), '2026-12-07T14:00:00-05:00');
  assert.equal(inZone('2029-03-31T13:00:00', 'America/Toronto'), '2029-03-31T13:00:00-04:00');
  assert.equal(inZone('2026-10-07', 'America/Toronto'), '2026-10-07');
  assert.equal(inZone('2026-10-07T14:00:00Z', 'America/Toronto'), '2026-10-07T14:00:00Z');
});

await test('open means deadline in the future (or recent with no deadline)', () => {
  const now = new Date(NOW);
  assert.equal(isOpen({ response_deadline: day(1) }, now), true);
  assert.equal(isOpen({ response_deadline: new Date(NOW - 60000).toISOString() }, now), false);
  assert.equal(isOpen({ response_deadline: '', posted_date: day(-10) }, now), true);
  assert.equal(isOpen({ response_deadline: '', posted_date: day(-90) }, now), false);
  assert.equal(isOpen({ response_deadline: '', keep_without_deadline: true }, now), true);
});

/* ---------------------------------------------------------------- feeds route */
await test('all four feeds: only open, normalised notices come back', async () => {
  process.env.SAM_API_KEY = 'TEST';
  clearFeedCache();
  const res = await getOpportunities(req('/api/opportunities?keywords=calcium%20carbonate,limestone,aragonite,lime'));
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'private, no-store');
  const ids = body.opportunities.map(o => o.notice_id).sort();
  assert.deepEqual(ids, ['S1', 'canadabuys:PW-26-001', 'ted:600020-2026', 'ted:656715-2026', 'worldbank:OP1']);
  assert.equal(body.opportunities.find(o => o.notice_id === 'ted:600020-2026').matched_keyword, 'calcium carbonate');
  for (const s of ['sam', 'canadabuys', 'ted', 'worldbank']) assert.equal(body.sources[s].ok, true, s);
  const ted = body.opportunities.find(o => o.feed === 'ted');
  assert.equal(ted.response_deadline, day(12) + 'T16:00:00+01:00');
  assert.equal(ted.buyer, 'Canal de Isabel II · ESP');
  const cb = body.opportunities.find(o => o.feed === 'canadabuys');
  assert.equal(cb.sow_text, 'Agricultural limestone,\nbulk "super sacks"');
  assert.match(cb.response_deadline, /T14:00:00-0[45]:00$/);
  assert.ok(!('keep_without_deadline' in cb));
  assert.ok(!JSON.stringify(body).includes('api_key'));
});

await test('repeat syncs reuse cached results instead of spending SAM.gov requests', async () => {
  const before = calls.filter(u => u.includes('api.sam.gov')).length;
  await getOpportunities(req('/api/opportunities?keywords=calcium%20carbonate,limestone,aragonite,lime&sources=sam'));
  await getOpportunities(req('/api/opportunities?keywords=calcium%20carbonate,limestone,aragonite,lime&sources=sam&refresh=1'));
  assert.equal(calls.filter(u => u.includes('api.sam.gov')).length, before);
});

await test('a failing feed reports its error and keeps the last good results', async () => {
  tedMode = 'down';
  const body = await (await getOpportunities(req('/api/opportunities?keywords=calcium%20carbonate,limestone,aragonite,lime&sources=ted&refresh=1'))).json();
  assert.equal(body.sources.ted.ok, false);
  assert.match(body.sources.ted.error, /503/);
  assert.equal(body.sources.ted.stale, true);
  assert.deepEqual(body.opportunities.map(o => o.notice_id).sort(), ['ted:600020-2026', 'ted:656715-2026']);
  tedMode = 'ok';
});

await test('TED falls back to the simpler query when the first is rejected', async () => {
  tedMode = '400first';
  clearFeedCache();
  const body = await (await getOpportunities(req('/api/opportunities?keywords=water&sources=ted'))).json();
  assert.equal(body.sources.ted.ok, true);
  assert.equal(body.sources.ted.count, 1); // only the open 'Water-treatment chemicals' notice names water
  tedMode = 'ok';
});

await test('World Bank sending XML is reported, not crashed on', async () => {
  wbMode = 'xml';
  clearFeedCache();
  const body = await (await getOpportunities(req('/api/opportunities?keywords=water&sources=worldbank'))).json();
  assert.equal(body.sources.worldbank.ok, false);
  assert.match(body.sources.worldbank.error, /non-JSON/);
  wbMode = 'ok';
});

await test('SAM.gov daily limit and missing key are explained', async () => {
  samMode = 'limit';
  clearFeedCache();
  let body = await (await getOpportunities(req('/api/opportunities?keywords=zz1&sources=sam'))).json();
  assert.match(body.sources.sam.error, /daily request limit/);
  samMode = 'ok';
  delete process.env.SAM_API_KEY;
  clearFeedCache();
  body = await (await getOpportunities(req('/api/opportunities?keywords=zz2&sources=sam'))).json();
  assert.match(body.sources.sam.error, /SAM_API_KEY/);
  process.env.SAM_API_KEY = 'TEST';
});

await test('RFP_KEYWORDS overrides keywords sent by the page', async () => {
  process.env.RFP_KEYWORDS = 'marble, dolomite';
  clearFeedCache();
  const body = await (await getOpportunities(req('/api/opportunities?keywords=anything&sources=worldbank'))).json();
  assert.deepEqual(body.keywords, ['marble', 'dolomite']);
  assert.equal(body.keywordsLocked, true);
  delete process.env.RFP_KEYWORDS;
});

/* ---------------------------------------------------------------- password */
await test('password: locked with a clear message until DASHBOARD_PASSWORD is set', async () => {
  delete process.env.DASHBOARD_PASSWORD;
  const res = middleware(req('/'));
  assert.equal(res.status, 503);
  assert.match(await res.text(), /DASHBOARD_PASSWORD/);
});

await test('password: wrong or missing sign-in gets a login prompt; right one passes', async () => {
  process.env.DASHBOARD_PASSWORD = 'correct horse ✓';
  assert.equal(middleware(req('/')).status, 401);
  assert.match(middleware(req('/')).headers.get('www-authenticate'), /^Basic realm=/);
  assert.equal(middleware(req('/', { headers: { authorization: basic('james', 'nope') } })).status, 401);
  assert.equal(middleware(req('/', { headers: { authorization: basic('', 'correct horse ✓') } })).status, 401);
  assert.equal(middleware(req('/', { headers: { authorization: basic('james', 'correct horse ✓') } })), undefined);
});

/* ---------------------------------------------------------------- workspace */
await test('workspace: without a database the page is told to stay local', async () => {
  delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN;
  const body = await (await getState(req('/api/state', { headers: { authorization: basic('james', 'x') } }))).json();
  assert.deepEqual(body, { configured: false, user: 'james' });
  const res = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"ops":[]}' }));
  assert.equal(res.status, 501);
});

await test('workspace: changes are stored and read back for everyone', async () => {
  process.env.KV_REST_API_URL = 'https://redis.test';
  process.env.KV_REST_API_TOKEN = 'tok';
  const ops = [
    { op: 'star', id: 'S1', on: true },
    { op: 'note', id: 'S1', text: 'Call the buyer Monday' },
    { op: 'row', id: 'manual-1', value: { notice_id: 'manual-1', title: 'Aquarium sand RFQ', response_deadline: day(9), added_by: 'james' } },
    { op: 'hide', id: 'ted:1', on: true },
    { op: 'checked', id: 'bidnet', at: new Date(NOW).toISOString() },
    { op: 'grade', id: 'S1', grade: 'WT-CAL' },
    { op: 'settings', value: { keywords: ['aragonite'], sources: ['sam'], company: 'AragoCor Minerals', secret: 'dropped' } }
  ];
  const post = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://oe.test' }, body: JSON.stringify({ ops }) }));
  assert.equal(post.status, 200);
  const body = await (await getState(req('/api/state', { headers: { authorization: basic('maria', 'x') } }))).json();
  assert.equal(body.configured, true);
  assert.equal(body.user, 'maria');
  assert.deepEqual(body.stars, ['S1']);
  assert.equal(body.notes.S1, 'Call the buyer Monday');
  assert.equal(body.rows['manual-1'].title, 'Aquarium sand RFQ');
  assert.deepEqual(body.hidden, ['ted:1']);
  assert.equal(body.grades.S1, 'WT-CAL');
  assert.deepEqual(body.settings, { keywords: ['aragonite'], sources: ['sam'], company: 'AragoCor Minerals' });
});

await test('workspace: a closed opportunity is forgotten everywhere', async () => {
  await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'forget', id: 'S1' }, { op: 'note', id: 'manual-1', text: '' }] }) }));
  const body = await (await getState(req('/api/state'))).json();
  assert.deepEqual(body.stars, []);
  assert.equal(body.notes.S1, undefined);
  assert.equal(body.grades.S1, undefined);
});

await test('workspace: refuses cross-site posts, non-JSON and bad input', async () => {
  const cross = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{"ops":[]}' }));
  assert.equal(cross.status, 403);
  const form = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"ops":[]}' }));
  assert.equal(form.status, 415);
  const bad = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'drop-table' }] }) }));
  assert.equal(bad.status, 400);
  const long = await postState(req('/api/state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'note', id: 'x', text: 'a'.repeat(20001) }] }) }));
  assert.equal(long.status, 400);
});

/* ---------------------------------------------------------------- health */
await test('health: reports each feed and configuration without secrets', async () => {
  process.env.SAM_API_KEY = 'SECRET-KEY-VALUE';
  process.env.DASHBOARD_PASSWORD = 'SECRET-PASSWORD';
  const res = await getHealth(req('/api/health'));
  const text = await res.text();
  const body = JSON.parse(text);
  assert.equal(res.status, 200, text);
  assert.equal(body.ok, true);
  for (const f of ['canadabuys', 'ted', 'worldbank']) assert.equal(body.feeds[f].ok, true, f + ': ' + JSON.stringify(body.feeds[f].problems));
  assert.equal(body.feeds.sam.configured, true);
  assert.equal(body.storage.ok, true);
  assert.ok(!text.includes('SECRET'));
});

console.log(`\n${passed} passed${process.exitCode ? ', some failed' : ''}`);
