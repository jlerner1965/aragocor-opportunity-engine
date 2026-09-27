/**
 * Shared workspace: the team's stars, notes, logged RFPs, hidden notices,
 * portal check-ins, grade choices and search settings, stored in Redis so they
 * follow you across devices and people.
 *
 *   GET  /api/state            → everything, or { configured: false } without a database
 *   POST /api/state { ops: [] } → apply changes (see OPS below)
 *
 * Optional: without a connected Upstash Redis database the dashboard keeps
 * working and saves in each browser only. Protected by middleware.js like every
 * other path.
 */

import { storeConfigured, pipeline, hashToObject } from '../lib/store.js';

const P = 'oe:ws:';
const K = {
  stars: P + 'stars', notes: P + 'notes', rows: P + 'rows', hidden: P + 'hidden',
  checked: P + 'checked', grades: P + 'grades', settings: P + 'settings'
};
const LIMITS = { ops: 1000, id: 300, note: 20000, row: 60000, settings: 10000, body: 2_000_000 };
const SETTINGS_KEYS = ['keywords', 'sources', 'company', 'email', 'phone'];

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex' }
});

function userFrom(request) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)/i.exec(request.headers.get('authorization') || '');
  if (!m) return '';
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)));
    return text.slice(0, Math.max(0, text.indexOf(':'))).trim().slice(0, 60);
  } catch {
    return '';
  }
}

const safeParse = s => { try { return JSON.parse(s); } catch { return null; } };

export async function GET(request) {
  if (!storeConfigured()) return json({ configured: false, user: userFrom(request) });
  try {
    const [stars, notes, rows, hidden, checked, grades, settings] = await pipeline([
      ['SMEMBERS', K.stars], ['HGETALL', K.notes], ['HGETALL', K.rows], ['SMEMBERS', K.hidden],
      ['HGETALL', K.checked], ['HGETALL', K.grades], ['GET', K.settings]
    ]);
    const rowObjects = {};
    for (const [id, raw] of Object.entries(hashToObject(rows))) {
      const row = safeParse(raw);
      if (row && typeof row === 'object') rowObjects[id] = row;
    }
    return json({
      configured: true,
      user: userFrom(request),
      serverTime: new Date().toISOString(),
      stars: stars || [],
      notes: hashToObject(notes),
      rows: rowObjects,
      hidden: hidden || [],
      checked: hashToObject(checked),
      grades: hashToObject(grades),
      settings: safeParse(settings) || null
    });
  } catch (err) {
    console.error('state GET failed:', err && err.message);
    return json({ configured: true, error: 'Shared storage is unreachable right now.' }, 503);
  }
}

function validId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= LIMITS.id;
}

/** Turns one operation into Redis commands, or returns an error string. */
function commandsFor(op) {
  if (!op || typeof op !== 'object') return 'invalid operation';
  const { id } = op;
  switch (op.op) {
    case 'star':
      if (!validId(id)) return 'invalid id';
      return [[op.on ? 'SADD' : 'SREM', K.stars, id]];
    case 'note': {
      if (!validId(id)) return 'invalid id';
      const text = typeof op.text === 'string' ? op.text : '';
      if (text.length > LIMITS.note) return 'note too long';
      return text.trim() ? [['HSET', K.notes, id, text]] : [['HDEL', K.notes, id]];
    }
    case 'row': {
      if (!validId(id)) return 'invalid id';
      if (op.value == null) return [['HDEL', K.rows, id]];
      if (typeof op.value !== 'object') return 'invalid row';
      const raw = JSON.stringify(op.value);
      if (raw.length > LIMITS.row) return 'row too large';
      return [['HSET', K.rows, id, raw]];
    }
    case 'hide':
      if (!validId(id)) return 'invalid id';
      return [[op.on === false ? 'SREM' : 'SADD', K.hidden, id]];
    case 'unhideAll':
      return [['DEL', K.hidden]];
    case 'checked':
      if (!validId(id)) return 'invalid id';
      return op.at ? [['HSET', K.checked, id, String(op.at).slice(0, 40)]] : [['HDEL', K.checked, id]];
    case 'grade':
      if (!validId(id)) return 'invalid id';
      return op.grade ? [['HSET', K.grades, id, String(op.grade).slice(0, 20)]] : [['HDEL', K.grades, id]];
    case 'forget': // an opportunity has closed: drop everything attached to it
      if (!validId(id)) return 'invalid id';
      return [['SREM', K.stars, id], ['HDEL', K.notes, id], ['HDEL', K.rows, id], ['HDEL', K.grades, id]];
    case 'settings': {
      if (!op.value || typeof op.value !== 'object') return 'invalid settings';
      const clean = {};
      for (const k of SETTINGS_KEYS) if (op.value[k] !== undefined) clean[k] = op.value[k];
      const raw = JSON.stringify(clean);
      if (raw.length > LIMITS.settings) return 'settings too large';
      return [['SET', K.settings, raw]];
    }
    default:
      return `unknown operation "${String(op.op).slice(0, 20)}"`;
  }
}

export async function POST(request) {
  if (!storeConfigured()) return json({ configured: false, error: 'Shared storage isn’t set up.' }, 501);

  // Cross-site protection: JSON only (forces a CORS preflight) and same-origin when the browser says where it's from.
  if (!/^application\/json\b/i.test(request.headers.get('content-type') || '')) return json({ error: 'Send JSON.' }, 415);
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== new URL(request.url).host) return json({ error: 'Cross-site request refused.' }, 403);

  const text = await request.text();
  if (text.length > LIMITS.body) return json({ error: 'Request too large.' }, 413);
  const body = safeParse(text);
  const ops = body && Array.isArray(body.ops) ? body.ops : null;
  if (!ops) return json({ error: 'Expected { ops: [...] }.' }, 400);
  if (ops.length > LIMITS.ops) return json({ error: `At most ${LIMITS.ops} changes per request.` }, 413);

  const commands = [];
  for (let i = 0; i < ops.length; i++) {
    const out = commandsFor(ops[i]);
    if (typeof out === 'string') return json({ error: `Change ${i + 1}: ${out}.` }, 400);
    commands.push(...out);
  }
  try {
    await pipeline(commands, { atomic: true });
    return json({ ok: true, applied: ops.length });
  } catch (err) {
    console.error('state POST failed:', err && err.message);
    return json({ error: 'Shared storage is unreachable right now.' }, 503);
  }
}
