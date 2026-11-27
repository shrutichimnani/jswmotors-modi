// JSW Motors x Gautam Modi Group: Node.js server (no dependencies).
// Run:  node server.js   (or: npm start)   ->  http://localhost:5173
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 5173;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const ASSETS = path.join(PUBLIC, 'assets');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'registrations.jsonl');

// Clean URLs: no .html in the address bar
const PAGES = {
  '/': 'index.html',
  '/privacy-policy': 'privacy-policy.html',
  '/terms-and-conditions': 'terms-and-conditions.html',
  '/about-us': 'about-us.html',
  '/contact-us': 'contact-us.html',
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function serveFile(req, res, file, cache) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const base = { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
    // Byte ranges, so browsers can seek inside videos (e.g. the Contact hero plays only the film's ending).
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (m && (m[1] || m[2])) {
      let start = m[1] ? parseInt(m[1], 10) : st.size - parseInt(m[2], 10);
      let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
      start = Math.max(0, start); end = Math.min(end, st.size - 1);
      if (start > end) return send(res, 416, '', { 'Content-Range': `bytes */${st.size}` });
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---- Register Interest endpoint ----
const hits = new Map(); // tiny in-memory rate limit: 10 requests / 10 min per IP
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < 600000);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 10;
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function handleRegister(req, res) {
  const ip = req.socket.remoteAddress || 'x';
  if (limited(ip)) return json(res, 429, { ok: false, error: 'Too many requests. Please try again later.' });
  let size = 0; const chunks = [];
  req.on('data', c => {
    size += c.length;
    if (size > 10 * 1024) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    let body;
    const raw = Buffer.concat(chunks).toString('utf8');
    try {
      if ((req.headers['content-type'] || '').includes('application/x-www-form-urlencoded')) {
        const p = new URLSearchParams(raw);
        if (p.get('bot-field')) return json(res, 200, { ok: true }); // honeypot
        body = { name: p.get('name'), mobile: p.get('mobile'), city: p.get('city'), consent: p.get('consent') === 'true' };
      } else body = JSON.parse(raw);
    } catch { return json(res, 400, { ok: false, error: 'Invalid request.' }); }
    const name = clean(body.name, 100);
    const city = clean(body.city, 80);
    const digits = clean(body.mobile, 20).replace(/\D/g, '');
    const mobile = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    if (name.length < 2) return json(res, 422, { ok: false, error: 'Please enter your name.' });
    if (!/^\d{10}$/.test(mobile)) return json(res, 422, { ok: false, error: 'Please enter a valid 10-digit mobile number.' });
    if (city.length < 2) return json(res, 422, { ok: false, error: 'Please enter your city.' });
    if (body.consent !== true) return json(res, 422, { ok: false, error: 'Please accept to receive updates.' });
    const record = { name, mobile, city, consent: true, source: 'jsw-motors-gmg-landing', ts: new Date().toISOString() };
    fs.mkdir(DATA_DIR, { recursive: true }, () => {
      fs.appendFile(DATA_FILE, JSON.stringify(record) + '\n', err => {
        if (err) { console.error('Could not save registration:', err.message); return json(res, 500, { ok: false, error: 'Could not save your details. Please try again.' }); }
        json(res, 200, { ok: true });
      });
    });
  });
}
function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

const server = http.createServer((req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { return send(res, 400, 'Bad request'); }

  if (pathname === '/api/register' || (pathname === '/' && req.method === 'POST')) {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'Method not allowed.' });
    return handleRegister(req, res);
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

  // old .html URLs redirect to the clean ones
  if (pathname === '/index.html') return send(res, 301, '', { Location: '/' });
  if (pathname === '/privacy-policy.html') return send(res, 301, '', { Location: '/privacy-policy' });
  if (pathname === '/terms-and-conditions.html') return send(res, 301, '', { Location: '/terms-and-conditions' });
  if (pathname === '/about-us.html') return send(res, 301, '', { Location: '/about-us' });
  if (pathname === '/contact-us.html') return send(res, 301, '', { Location: '/contact-us' });
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);

  if (PAGES[pathname]) return serveFile(req, res, path.join(PUBLIC, PAGES[pathname]), 'no-cache');

  if (pathname.startsWith('/assets/')) {
    const file = path.normalize(path.join(PUBLIC, pathname));
    if (!file.startsWith(ASSETS + path.sep)) return send(res, 403, 'Forbidden');
    return serveFile(req, res, file, 'public, max-age=86400');
  }
  send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
});

server.listen(PORT, () => console.log('JSW Motors site running at http://localhost:' + PORT));
