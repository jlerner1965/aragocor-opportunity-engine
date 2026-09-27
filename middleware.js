/**
 * Password protection for the whole dashboard (HTTP Basic auth).
 *
 * Set DASHBOARD_PASSWORD in Vercel → Settings → Environment Variables. Anyone
 * with the password can sign in with any username — the username is only used
 * to show who logged an RFP. If the password isn't set the site stays locked
 * (it fails closed) and says what to do.
 *
 * /api/health stays public: it reports only whether each feed is working.
 */

export const config = {
  matcher: ['/((?!api/health|robots\\.txt).*)']
};

const REALM = 'AragoCor Opportunity Engine';

function decodeBasic(header) {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header || '');
  if (!m) return null;
  try {
    const bytes = Uint8Array.from(atob(m[1]), c => c.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    const i = text.indexOf(':');
    return i < 0 ? null : { user: text.slice(0, i), pass: text.slice(i + 1) };
  } catch {
    return null;
  }
}

// Compares without returning early, so response time doesn't reveal how much matched.
function sameText(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export default function middleware(request) {
  const password = process.env.DASHBOARD_PASSWORD || '';
  if (!password) {
    return new Response(
      'This dashboard is locked until a password is set.\n\nIn Vercel, open this project → Settings → Environment Variables, add DASHBOARD_PASSWORD, then redeploy.\n',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
    );
  }
  const creds = decodeBasic(request.headers.get('authorization'));
  if (creds && creds.user.trim() && sameText(creds.pass, password)) return; // continue to the page or function

  return new Response('Sign in with any username and the team password.\n', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}
