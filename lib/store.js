/**
 * Minimal client for Upstash Redis over its REST API (no npm dependency).
 *
 * Optional: when no database is connected, `store.configured` is false and every
 * caller falls back to browser-only storage and in-memory caching. Add one in
 * Vercel → Storage → Upstash for Redis (free tier) and connect it to the project;
 * Vercel then sets the variables below automatically.
 *
 *   KV_REST_API_URL / KV_REST_API_TOKEN              (Vercel's Upstash integration)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (Upstash console)
 */

const TIMEOUT_MS = 8000;

function credentials() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

export function storeConfigured() {
  return credentials() !== null;
}

/**
 * Runs several Redis commands in one round trip.
 * @param {Array<Array<string|number>>} commands e.g. [["SADD","k","v"],["HGETALL","h"]]
 * @param {{atomic?: boolean}} [options] atomic uses MULTI/EXEC
 * @returns {Promise<any[]>} one result per command; throws if any command errors
 */
export async function pipeline(commands, { atomic = false } = {}) {
  const creds = credentials();
  if (!creds) throw new Error('Storage is not configured');
  if (!commands.length) return [];
  const res = await fetch(`${creds.url}/${atomic ? 'multi-exec' : 'pipeline'}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands.map(c => c.map(String))),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!res.ok) throw new Error(`Storage returned ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(body && body.error ? `Storage error: ${body.error}` : 'Unexpected storage response');
  return body.map((item, i) => {
    if (item && item.error) throw new Error(`Storage error on ${commands[i][0]}: ${item.error}`);
    return item ? item.result : null;
  });
}

/** Redis HGETALL comes back as [field, value, field, value…] over REST; normalise to an object. */
export function hashToObject(result) {
  if (!result) return {};
  if (Array.isArray(result)) {
    const out = {};
    for (let i = 0; i + 1 < result.length; i += 2) out[result[i]] = result[i + 1];
    return out;
  }
  return typeof result === 'object' ? result : {};
}

/** Cached JSON value with expiry. Returns null on a miss or when storage is unavailable. */
export async function getJson(key) {
  if (!storeConfigured()) return null;
  try {
    const [raw] = await pipeline([['GET', key]]);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function setJson(key, value, ttlSeconds) {
  if (!storeConfigured()) return false;
  try {
    await pipeline([['SET', key, JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSeconds))]]);
    return true;
  } catch {
    return false;
  }
}
