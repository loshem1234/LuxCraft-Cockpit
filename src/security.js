// Security: encryption at rest, sessions, 2FA (TOTP), API tokens, headers, CSRF, rate limits, audit log.
const crypto = require('crypto');
const { q, getSecret, setSecret } = require('./db');

// ---------- encryption at rest (AES-256-GCM) ----------
function loadKey() {
  const raw = process.env.ENCRYPTION_KEY || '';
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw) { try { const b = Buffer.from(raw, 'base64'); if (b.length === 32) key = b; } catch {} }
  if (!key) {
    console.error('ENCRYPTION_KEY must be 32 random bytes (64 hex characters). Generate one with:\n  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    process.exit(1);
  }
  return key;
}
const KEY = loadKey();
const VERSION = Buffer.from([1]);
function encrypt(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(String(buf), 'utf8');
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([VERSION, iv, c.getAuthTag(), enc]);
}
function decrypt(blob) {
  if (!blob) return null;
  if (blob[0] !== 1) throw new Error('Unknown encryption version');
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
}
const encryptText = (s) => encrypt(Buffer.from(s, 'utf8')).toString('base64');
const decryptText = (s) => (s ? decrypt(Buffer.from(s, 'base64')).toString('utf8') : null);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- audit ----------
async function audit(event, detail, ip) {
  try { await q('INSERT INTO audit_log (event, detail, ip) VALUES ($1,$2,$3)', [event, detail ? String(detail).slice(0, 500) : null, ip || null]); } catch {}
}

// ---------- TOTP (RFC 6238) ----------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0; let value = 0; const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function totpAt(secretB32, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(buf).digest();
  const o = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1000000).toString().padStart(6, '0');
  return code;
}
let lastTotpCounter = 0; // blocks replay of the same code
function verifyTotp(secretB32, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const now = Math.floor(Date.now() / 30000);
  for (const w of [-1, 0, 1]) {
    if (safeEqual(totpAt(secretB32, now + w), code) && now + w > lastTotpCounter) { lastTotpCounter = now + w; return true; }
  }
  return false;
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
async function twoFactor() {
  const enc = await getSecret('totp');
  return enc ? decryptText(enc) : null;
}
async function useRecoveryCode(code) {
  const enc = await getSecret('recovery');
  if (!enc) return false;
  const hashes = JSON.parse(decryptText(enc));
  const h = sha256(String(code).trim().toUpperCase());
  const i = hashes.indexOf(h);
  if (i < 0) return false;
  hashes.splice(i, 1);
  await setSecret('recovery', encryptText(JSON.stringify(hashes)));
  return true;
}
function makeRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-'));
  return { codes, hashes: codes.map((c) => sha256(c)) };
}

// ---------- sessions ----------
const SESSION_DAYS = 14;
const IDLE_HOURS = 72;
function cookieName(req) { return req.secure ? '__Host-lc_session' : 'lc_session'; }
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}
async function createSession(req, res) {
  const id = crypto.randomBytes(32).toString('base64url');
  await q(`INSERT INTO sessions (id, expires_at, ip, user_agent) VALUES ($1, now() + interval '${SESSION_DAYS} days', $2, $3)`,
    [sha256(id), req.ip, String(req.get('user-agent') || '').slice(0, 200)]);
  res.setHeader('Set-Cookie', `${cookieName(req)}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${req.secure ? '; Secure' : ''}`);
}
async function getSession(req) {
  const id = readCookie(req, cookieName(req)) || readCookie(req, 'lc_session');
  if (!id) return null;
  const { rows } = await q(`SELECT * FROM sessions WHERE id=$1 AND NOT revoked AND expires_at > now() AND last_seen > now() - interval '${IDLE_HOURS} hours'`, [sha256(id)]);
  if (!rows[0]) return null;
  if (Date.now() - new Date(rows[0].last_seen).getTime() > 5 * 60000) q('UPDATE sessions SET last_seen=now() WHERE id=$1', [rows[0].id]).catch(() => {});
  return rows[0];
}
async function destroySession(req, res) {
  const id = readCookie(req, cookieName(req)) || readCookie(req, 'lc_session');
  if (id) await q('UPDATE sessions SET revoked=true WHERE id=$1', [sha256(id)]);
  res.setHeader('Set-Cookie', `${cookieName(req)}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${req.secure ? '; Secure' : ''}`);
}

// ---------- API tokens (for the invoice app and future integrations) ----------
async function createToken(label, scope, origin) {
  const token = `lct_${crypto.randomBytes(24).toString('base64url')}`;
  await q('INSERT INTO api_tokens (label, scope, token_hash, origin) VALUES ($1,$2,$3,$4)', [label, scope, sha256(token), origin || null]);
  return token;
}
async function checkToken(req, scope) {
  const h = req.get('authorization') || '';
  const m = h.match(/^Bearer\s+(lct_[A-Za-z0-9_-]{20,})$/);
  if (!m) return null;
  const { rows } = await q('SELECT * FROM api_tokens WHERE token_hash=$1 AND NOT revoked AND scope=$2', [sha256(m[1]), scope]);
  if (!rows[0]) return null;
  q('UPDATE api_tokens SET last_used=now() WHERE id=$1', [rows[0].id]).catch(() => {});
  return rows[0];
}

// ---------- middleware ----------
function securityHeaders(req, res, next) {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob: data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

// Requests that change data must come from our own page (custom header can't be sent cross-site without CORS).
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-cockpit') !== '1') return res.status(403).json({ error: 'Blocked request' });
  const origin = req.get('origin');
  if (origin && origin !== `${req.protocol}://${req.get('host')}`) return res.status(403).json({ error: 'Blocked cross-site request' });
  next();
}

function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req); const now = Date.now();
    let h = hits.get(k);
    if (!h || now - h.t > windowMs) { h = { n: 0, t: now }; hits.set(k, h); }
    if (++h.n > max) return res.status(429).json({ error: 'Too many requests – slow down a moment.' });
    next();
  };
}

// Check the real file type from its first bytes, not the name the browser sent.
function sniffType(buf, claimed, filename = '') {
  const b = buf.subarray(0, 12);
  if (b.slice(0, 4).toString('latin1') === '%PDF') return 'application/pdf';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
  if (b.slice(4, 12).toString('latin1').includes('ftyphei') || b.slice(4, 12).toString('latin1').includes('ftypmif')) return 'image/heic';
  if (b[0] === 0x50 && b[1] === 0x4b && /\.docx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  // plain text (txt/md/csv/json): no NUL bytes in the first 4KB
  const head = buf.subarray(0, 4096);
  if (!head.includes(0) && /\.(txt|md|csv|json|tsv)$/i.test(filename)) {
    if (/\.csv$/i.test(filename)) return 'text/csv';
    if (/\.md$/i.test(filename)) return 'text/markdown';
    if (/\.json$/i.test(filename)) return 'application/json';
    return 'text/plain';
  }
  return null;
}

module.exports = {
  encrypt, decrypt, encryptText, decryptText, sha256, safeEqual, audit,
  newTotpSecret, verifyTotp, twoFactor, useRecoveryCode, makeRecoveryCodes,
  createSession, getSession, destroySession, createToken, checkToken,
  securityHeaders, csrfGuard, rateLimit, sniffType,
};
