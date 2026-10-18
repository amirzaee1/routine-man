// «روتین من» with Sarah — static site + a small lead proxy.
// The site (index.html + media/) sits next to this file, so the same repo also works on GitHub Pages.
// The browser posts the lead to /api/lead on this server; only this server knows
// PRODUCT_LEAD_INGEST_SECRET and forwards the lead to agenthooshmand's
// POST /api/integrations/product-lead. No dependencies: Node 18+ built-ins only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = HERE;   // only index.html and media/ are served (see serveStatic)
const env = k => (process.env[k] || '').trim();
const PORT = Number(env('PORT')) || 3000;
const SECRET = env('PRODUCT_LEAD_INGEST_SECRET');
const AGENT = env('AGENT_BASE_URL').replace(/\/+$/, '');
// demo unless explicitly turned off AND the server can actually forward
const DEMO = env('DEMO_MODE').toLowerCase() !== 'false' || !SECRET || !AGENT;
const REF_RE = /^T[A-Z0-9]{9}$/;
const DEFAULT_REF = env('DEFAULT_REFERRAL_CODE').toUpperCase();
// other sites allowed to post leads here, e.g. the GitHub Pages copy: https://amirzaee1.github.io
const ALLOWED_ORIGINS = env('ALLOWED_ORIGINS').split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ---------- lead validation (same rules as the endpoint) ---------- */
const toLatin = s => s.replace(/[۰-۹]/g, d => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
function normPhone(raw) {
  let p = toLatin(String(raw || '')).replace(/[\s\-()]/g, '');
  if (p.startsWith('+98')) p = '0' + p.slice(3); else if (p.startsWith('0098')) p = '0' + p.slice(4); else if (p.startsWith('98') && p.length === 12) p = '0' + p.slice(2); else if (p.startsWith('9') && p.length === 10) p = '0' + p;
  return /^09\d{9}$/.test(p) ? p : null;
}
const maskPhone = p => p.slice(0, 4) + '****' + p.slice(-3);   // phone never goes to the logs in full
const maskName = n => n.slice(0, 1) + '…';
const clip = (v, n) => String(v ?? '').trim().slice(0, n);

function buildPayload(b) {
  const phone = normPhone(b.phone);
  const name = clip(b.name, 100);
  const ref = clip(b.referralCode, 20).toUpperCase();
  const referralCode = REF_RE.test(ref) ? ref : (REF_RE.test(DEFAULT_REF) ? DEFAULT_REF : '');
  const summaries = (Array.isArray(b.summaries) ? b.summaries : []).slice(0, 8)
    .map(s => ({ title: clip(s?.title, 60), priority: clip(s?.priority, 200) }))
    .filter(s => s.title || s.priority);
  if (!name || !phone) return { error: 'invalid', status: 400 };
  if (b.contactConsent !== true || b.healthConsent !== true) return { error: 'consent', status: 400 };
  if (!referralCode) return { error: 'no_referrer', status: 422 };
  return { payload: { referralCode, name, phone, sourceLeadId: clip(b.sourceLeadId, 100), summaries, contactConsent: true, healthConsent: true }, viaDefault: referralCode !== ref };
}

async function forward(payload) {
  const r = await fetch(`${AGENT}/api/integrations/product-lead`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-product-ingest-secret': SECRET },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12000),
  });
  let j = {}; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

/* ---------- tiny per-IP rate limit ---------- */
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 10 * 60 * 1000;
  const list = (hits.get(ip) || []).filter(t => now - t < win);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 8;
}

// same origin (behind Liara's proxy the public host may arrive as x-forwarded-host) or one of ALLOWED_ORIGINS
function originOk(req, origin) {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  const hosts = [req.headers.host, ...String(req.headers['x-forwarded-host'] || '').split(',')].map(h => String(h || '').trim()).filter(Boolean);
  let oh = ''; try { oh = new URL(origin).host; } catch (e) {}
  return hosts.includes(oh);
}
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.includes(o)) { res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'Origin'); }
}

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

async function readBody(req, max = 16 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw new Error('too_large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleLead(req, res) {
  const origin = req.headers.origin;
  if (origin && !originOk(req, origin)) return json(res, 403, { ok: false, error: 'origin' });
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (limited(ip)) return json(res, 429, { ok: false, error: 'rate' });
  let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { ok: false, error: 'invalid' }); }
  const built = buildPayload(b || {});
  if (built.error) { log(`[lead] rejected: ${built.error}`); return json(res, built.status, { ok: false, error: built.error }); }
  const p = built.payload;
  const line = `ref=${p.referralCode}${built.viaDefault ? ' (default)' : ''} name=${maskName(p.name)} phone=${maskPhone(p.phone)} id=${p.sourceLeadId} summaries=${JSON.stringify(p.summaries.map(s => `${s.title}: ${s.priority}`))} consent=contact+health`;
  if (DEMO) { log(`[lead][DEMO] ${line}`); return json(res, 200, { ok: true, demo: true }); }
  try {
    let r = await forward(p);
    // referrer not active → default routing (master prompt §26), if a default code is set
    if (r.status === 404 && REF_RE.test(DEFAULT_REF) && p.referralCode !== DEFAULT_REF) {
      log(`[lead] referrer ${p.referralCode} not active → default`);
      r = await forward({ ...p, referralCode: DEFAULT_REF });
    }
    log(`[lead] ${r.status} ${line}${r.body?.duplicate ? ' duplicate' : ''}`);
    if (r.status === 200 && r.body?.success) return json(res, 200, { ok: true });
    if (r.status === 409) return json(res, 200, { ok: true });          // already registered: keep the UI ordinary (§35)
    if (r.status === 400) return json(res, 400, { ok: false, error: 'invalid' });
    if (r.status === 404) return json(res, 422, { ok: false, error: 'no_referrer' });
    return json(res, 502, { ok: false, error: 'upstream' });               // 401/5xx: the browser keeps it and retries
  } catch (e) {
    log(`[lead] forward failed: ${e.name} ${line}`);
    return json(res, 502, { ok: false, error: 'upstream' });
  }
}

/* ---------- static files (with Range for the mp4 clips) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function serveStatic(req, res, urlPath) {
  let rel; try { rel = decodeURIComponent(urlPath); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel));
  // never serve the server's own files (server.mjs, .env, package.json …)
  if (file !== path.join(PUBLIC, 'index.html') && !file.startsWith(path.join(PUBLIC, 'media') + path.sep)) { res.writeHead(404); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const ext = path.extname(file).toLowerCase();
    const head = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=604800',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',          // the ?ref code is not leaked to Google Fonts
    };
    if (ext === '.html') head['content-security-policy'] = CSP;
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : st.size - Number(m[2]);
      let end = m[1] && m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
      if (start < 0) start = 0;
      if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end(); }
      res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...head, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

http.createServer((req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/api/lead') {
    cors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type', 'access-control-max-age': '86400' });
      return res.end();
    }
    if (req.method !== 'POST') return json(res, 405, { ok: false });
    return handleLead(req, res).catch(e => { log('[lead] error', e.name); json(res, 500, { ok: false, error: 'server' }); });
  }
  if (pathname === '/api/health') return json(res, 200, { ok: true, demo: DEMO, forwarding: !DEMO, defaultReferrer: REF_RE.test(DEFAULT_REF) });
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, pathname);
}).listen(PORT, () => log(`routine-sara on :${PORT} · ${DEMO ? 'DEMO_MODE (leads only logged)' : `forwarding to ${AGENT}`}`));
