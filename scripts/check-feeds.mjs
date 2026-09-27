#!/usr/bin/env node
/**
 * Live feed check — calls the real CanadaBuys, EU TED and World Bank services
 * (and SAM.gov, once, if SAM_API_KEY is set) and confirms the parsers can still
 * read them. Run daily by .github/workflows/feed-check.yml; exits non-zero when a
 * feed is broken so GitHub emails the repository owner.
 *
 *   node scripts/check-feeds.mjs [--out report.json]
 */

import fs from 'node:fs';
import { diagnoseFeeds } from '../lib/diagnose.js';
import { USER_AGENT, CANADABUYS_URL, DEFAULT_KEYWORDS, fetchCanadaBuys, fetchTed, fetchWorldBank, isOpen } from '../lib/feeds.js';

const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null;

const now = new Date();
const feeds = await diagnoseFeeds({ now, detail: true, includeSam: true });
// SAM.gov is optional here: without the SAM_API_KEY repository secret it is skipped, not failed.
const report = { checkedAt: now.toISOString(), ok: Object.values(feeds).every(f => f.ok || f.configured === false), feeds };

// The same searches the dashboard runs, with AragoCor's default keywords, so the report
// shows real current matches and proves the multi-keyword queries are accepted.
report.keywordSearch = { keywords: DEFAULT_KEYWORDS };
for (const [source, run] of Object.entries({
  canadabuys: () => fetchCanadaBuys(DEFAULT_KEYWORDS, now),
  ted: () => fetchTed(DEFAULT_KEYWORDS, now, { limit: 100, maxPages: 2 }),
  worldbank: () => fetchWorldBank(DEFAULT_KEYWORDS, now, { rows: 50 })
})) {
  try {
    const r = await run();
    const open = r.items.filter(o => isOpen(o, now));
    report.keywordSearch[source] = {
      ok: r.errors.length === 0,
      errors: r.errors.map(e => e.message),
      query: r.raw && r.raw.query,
      received: r.raw && r.raw.received,
      titleMatched: r.raw && r.raw.titleMatched,
      open: open.length,
      examples: open.slice(0, 8).map(o => ({ title: o.title.slice(0, 140), buyer: o.buyer, deadline: o.response_deadline, matched: o.matched_keyword, url: o.url }))
    };
    if (r.errors.length) report.ok = false;
  } catch (err) {
    report.keywordSearch[source] = { ok: false, errors: [String(err && err.message)] };
    report.ok = false;
  }
}

// If CanadaBuys refuses the request, record how it answers different kinds of request.
if (feeds.canadabuys && !feeds.canadabuys.ok) {
  const variants = {
    engine: { 'User-Agent': USER_AGENT, Accept: 'text/csv,*/*' },
    browser: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-CA,en;q=0.9' },
    bare: {}
  };
  const urls = {
    open: CANADABUYS_URL,
    new: 'https://canadabuys.canada.ca/opendata/pub/newTenderNotice-nouvelAvisAppelOffres.csv',
    portal: 'https://open.canada.ca/data/en/api/3/action/package_show?id=6abd20d4-7a1c-4b38-baa2-9525d0bb2fd2'
  };
  report.canadabuysProbe = [];
  for (const [u, url] of Object.entries(urls)) {
    for (const [v, headers] of Object.entries(variants)) {
      try {
        const res = await fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
        const text = (await res.text()).slice(0, 300);
        report.canadabuysProbe.push({ url: u, variant: v, status: res.status, server: res.headers.get('server'), location: res.headers.get('location'), contentType: res.headers.get('content-type'), body: text });
      } catch (err) {
        report.canadabuysProbe.push({ url: u, variant: v, error: String(err && err.message) });
      }
    }
  }
}



for (const [source, f] of Object.entries(feeds)) {
  const line = f.ok ? 'OK  ' : f.configured === false ? 'SKIP' : 'FAIL';
  const counts = f.received != null ? ` received ${f.received}, parsed ${f.parsed}, with deadline ${f.withDeadline}, open ${f.open} (${f.ms} ms)` : '';
  console.log(`${line} ${f.label}:${counts}`);
  for (const p of f.problems || []) console.log(`       - ${p}`);
  if (f.note) console.log(`       ${f.note}`);
}
if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
for (const [source, k] of Object.entries(report.keywordSearch)) {
  if (source === 'keywords') continue;
  console.log(`${k.ok ? 'OK  ' : 'FAIL'} keyword search on ${source}: ${k.open ?? 0} open${k.errors && k.errors.length ? ' — ' + k.errors.join('; ') : ''}`);
}
if (!report.ok) {
  console.error('\nAt least one feed is not readable. See the report for raw samples.');
  process.exit(1);
}
