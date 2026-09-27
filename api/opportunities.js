/**
 * GET /api/opportunities?keywords=a,b&sources=sam,ted
 *
 * Open procurement notices from the live feeds, normalised to one shape.
 * Each source is cached (in Redis when connected, otherwise in memory) so that
 * repeated syncs don't spend the SAM.gov key's daily request allowance.
 *
 * Environment variables:
 *   SAM_API_KEY    required for SAM.gov   From SAM.gov → Account Details → Public API Key
 *   RFP_KEYWORDS   optional               Comma-separated keywords; when set they override
 *                                         whatever the page sends
 */

import { SOURCES, LABELS, DEFAULT_KEYWORDS, MAX_KEYWORDS, parseList, loadSource } from '../lib/feeds.js';

export const maxDuration = 60;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' }
});

export async function GET(request) {
  const params = new URL(request.url).searchParams;
  const locked = parseList(process.env.RFP_KEYWORDS || process.env.SAM_KEYWORDS, MAX_KEYWORDS);
  const requested = parseList(params.get('keywords'), MAX_KEYWORDS);
  const keywords = locked.length ? locked : requested.length ? requested : DEFAULT_KEYWORDS;
  const asked = parseList(params.get('sources'), 10).filter(s => SOURCES.includes(s));
  const sources = asked.length ? asked : SOURCES;
  const refresh = params.get('refresh') === '1';

  const now = new Date();
  const results = await Promise.all(sources.map(async source => {
    // SAM.gov is never force-refreshed: its daily allowance is too small.
    const r = await loadSource(source, keywords, now, { refresh: refresh && source !== 'sam' });
    return { source, ...r };
  }));

  const opportunities = [];
  const summary = {};
  const errors = [];
  for (const r of results) {
    opportunities.push(...r.items);
    summary[r.source] = {
      label: LABELS[r.source],
      count: r.items.length,
      ok: r.errors.length === 0,
      error: r.errors.length ? r.errors[0].message : '',
      updatedAt: new Date(r.fetchedAt).toISOString(),
      cached: !!r.cached,
      stale: !!r.stale
    };
    for (const e of r.errors) errors.push({ source: r.source, ...e });
  }

  return json({ fetchedAt: now.toISOString(), keywords, keywordsLocked: locked.length > 0, sources: summary, opportunities, errors });
}
