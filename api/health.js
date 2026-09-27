/**
 * GET /api/health — is everything wired up and is each feed still readable?
 *
 * Public on purpose (middleware.js skips it) so it can be checked without the
 * password. It reveals only yes/no configuration flags and public feed data —
 * no keys, no workspace contents. Results are cached for 30 minutes.
 * Add ?detail=1 for raw upstream samples.
 */

import { diagnoseFeeds } from '../lib/diagnose.js';
import { storeConfigured, pipeline } from '../lib/store.js';

export const maxDuration = 60;

const CACHE_MS = 30 * 60 * 1000;
let cached = null;

async function storageStatus() {
  if (!storeConfigured()) return { configured: false, ok: true, note: 'Optional — without it, each browser keeps its own data.' };
  try {
    const [pong] = await pipeline([['PING']]);
    return { configured: true, ok: pong === 'PONG' };
  } catch (err) {
    return { configured: true, ok: false, problem: err && err.message ? err.message : 'unreachable' };
  }
}

export async function GET(request) {
  const detail = new URL(request.url).searchParams.get('detail') === '1';
  const now = Date.now();
  if (!cached || now - cached.at > CACHE_MS || (detail && !cached.detail)) {
    const [feeds, storage] = await Promise.all([diagnoseFeeds({ detail }), storageStatus()]);
    cached = { at: now, detail, feeds, storage };
  }
  const { feeds, storage } = cached;
  const passwordSet = !!process.env.DASHBOARD_PASSWORD;
  const ok = passwordSet && storage.ok && Object.values(feeds).every(f => f.ok);
  const body = {
    ok,
    checkedAt: new Date(cached.at).toISOString(),
    password: { configured: passwordSet },
    storage,
    feeds: detail ? feeds : Object.fromEntries(Object.entries(feeds).map(([k, v]) => {
      const { rawSamples, normalizedSamples, fields, columns, ...rest } = v;
      return [k, rest];
    }))
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: ok ? 200 : 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }
  });
}
