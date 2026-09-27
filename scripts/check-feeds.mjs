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

const outIndex = process.argv.indexOf('--out');
const outFile = outIndex > 0 ? process.argv[outIndex + 1] : null;

const now = new Date();
const feeds = await diagnoseFeeds({ now, detail: true, includeSam: true });
const report = { checkedAt: now.toISOString(), ok: Object.values(feeds).every(f => f.ok), feeds };

if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

for (const [source, f] of Object.entries(feeds)) {
  const line = f.ok ? 'OK  ' : 'FAIL';
  const counts = f.received != null ? ` received ${f.received}, parsed ${f.parsed}, with deadline ${f.withDeadline}, open ${f.open} (${f.ms} ms)` : '';
  console.log(`${line} ${f.label}:${counts}`);
  for (const p of f.problems || []) console.log(`       - ${p}`);
  if (f.note) console.log(`       ${f.note}`);
}
if (!report.ok) {
  console.error('\nAt least one feed is not readable. See the report for raw samples.');
  process.exit(1);
}
