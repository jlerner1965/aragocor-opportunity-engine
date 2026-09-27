/**
 * Live checks that each feed still answers in the shape the parsers expect.
 * Used by /api/health (public, summary only) and scripts/check-feeds.mjs
 * (the daily GitHub Action, with raw samples).
 *
 * A feed "works" when it returns records AND the parser can find a title and a
 * deadline in them. A format change upstream shows up here as a named problem
 * instead of the dashboard quietly showing nothing.
 */

import { LABELS, DEFAULT_KEYWORDS, fetchCanadaBuys, fetchTed, fetchWorldBank, fetchSam, isOpen, toTime } from './feeds.js';

function summarise(source, result, now, { detail, probe }) {
  const items = result.items || [];
  const withTitle = items.filter(o => o.title && !/^(Untitled|TED notice|World Bank notice)/.test(o.title)).length;
  const withDeadline = items.filter(o => toTime(o.response_deadline) != null).length;
  const open = items.filter(o => isOpen(o, now)).length;
  const problems = [];
  for (const e of result.errors || []) problems.push(e.message);
  if (!problems.length) {
    if (!result.raw.received) problems.push(`No records came back for the test search (${probe}).`);
    else if (!items.length) problems.push('Records came back but none could be read — the format may have changed.');
    else {
      if (withTitle / items.length < 0.8) problems.push(`Titles missing on ${items.length - withTitle} of ${items.length} records — the title field may have changed.`);
      if (source !== 'canadabuys' && withDeadline / items.length < 0.5) problems.push(`Deadlines missing on ${items.length - withDeadline} of ${items.length} records — the deadline field may have changed.`);
      if (source === 'canadabuys' && withDeadline / items.length < 0.8) problems.push(`Closing dates unreadable on ${items.length - withDeadline} of ${items.length} tenders.`);
    }
  }
  const out = {
    label: LABELS[source],
    ok: problems.length === 0,
    problems,
    probe,
    httpStatus: result.raw.status,
    received: result.raw.received,
    parsed: items.length,
    withDeadline,
    open,
    fields: result.raw.fields
  };
  if (result.raw.columns) out.columns = result.raw.columns;
  if (result.raw.query) out.query = result.raw.query;
  if (result.raw.total != null) out.total = result.raw.total;
  const sample = items.find(o => isOpen(o, now)) || items[0];
  if (sample) out.sample = sample;
  if (detail) {
    out.rawSamples = result.raw.samples;
    out.normalizedSamples = items.slice(0, 3);
  }
  return out;
}

async function timed(fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { result, ms: Date.now() - start };
  } catch (err) {
    return { result: { items: [], errors: [{ message: err && err.message ? err.message : String(err) }], raw: { received: 0, fields: [], samples: [] } }, ms: Date.now() - start };
  }
}

export async function diagnoseFeeds({ now = new Date(), detail = false, includeSam = false } = {}) {
  const checks = {
    // Broad probe words: the point is to prove the format, not to find aragonite buyers.
    canadabuys: { probe: 'all open tenders', run: () => fetchCanadaBuys(DEFAULT_KEYWORDS, now, { all: true }) },
    ted: { probe: '"water"', run: () => fetchTed(['water'], now, { limit: 20, maxPages: 1, titleFilter: false }) },
    worldbank: { probe: '"water"', run: () => fetchWorldBank(['water'], now, { rows: 20 }) }
  };
  if (includeSam && process.env.SAM_API_KEY) {
    checks.sam = { probe: '"limestone" (1 request)', run: () => fetchSam(['limestone'], now, { limit: 5 }) };
  }

  const entries = await Promise.all(Object.entries(checks).map(async ([source, c]) => {
    const { result, ms } = await timed(c.run);
    const summary = summarise(source, result, now, { detail, probe: c.probe });
    if (source === 'canadabuys') {
      summary.matchedKeywords = result.items.filter(o => o.matched_keyword).length;
      summary.openMatched = result.items.filter(o => o.matched_keyword && isOpen(o, now)).length;
    }
    return [source, { ...summary, ms }];
  }));
  const feeds = Object.fromEntries(entries);
  if (!feeds.sam) {
    feeds.sam = {
      label: LABELS.sam,
      ok: !!process.env.SAM_API_KEY,
      configured: !!process.env.SAM_API_KEY,
      problems: process.env.SAM_API_KEY ? [] : ['SAM_API_KEY is not set.'],
      note: 'Not called by this check, to save the key’s daily requests. Sync the dashboard to test it.'
    };
  }
  return feeds;
}
