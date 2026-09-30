// Colección Liga 26/27 — servidor sin dependencias externas (solo Node >= 22.5)
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

/* ---------- Secreto de sesión ---------- */
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, 'secret.key');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(f, s, { mode: 0o600 }); } catch {}
  return s;
}
const SECRET = loadSecret();

/* ---------- Checklist ---------- */
function parseChecklist() {
  const lines = fs.readFileSync(path.join(__dirname, 'data', 'checklist.txt'), 'utf8').split(/\r?\n/);
  const teams = [];
  const sections = [];
  const stickers = [];
  let cur = null; // {kind:'team'|'section', slug}
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('# ') && line.includes('|')) {
      const [name, slug, tsdb, espn] = line.slice(2).split('|').map(s => s.trim());
      teams.push({ slug, name, tsdb, crest: espn ? `https://a.espncdn.com/i/teamlogos/soccer/500/${espn}.png` : '' });
      cur = { kind: 'team', slug, name };
      continue;
    }
    if (line.startsWith('@ ')) {
      const [name, slug] = line.slice(2).split('|').map(s => s.trim());
      sections.push({ slug, name });
      cur = { kind: 'section', slug, name };
      continue;
    }
    if (line.startsWith('#') || !cur) continue;
    const p = line.split('|').map(s => s.trim());
    if (cur.kind === 'team') {
      const [code, name, pos, note] = p;
      stickers.push({ id: `${cur.slug}-${code.replace(/\s+/g, '')}`, group: cur.slug, team: cur.slug, code, name, pos, note: note || '' });
    } else {
      const [code, name, team, pos, note] = p;
      stickers.push({ id: `${cur.slug}-${code.replace(/\s+/g, '')}`, group: cur.slug, team, code, name, pos, note: note || '' });
    }
  }
  return { teams, sections, stickers };
}
const CHECKLIST = parseChecklist();
const VALID_IDS = new Set(CHECKLIST.stickers.map(s => s.id));

/* ---------- Base de datos ---------- */
// Con DATABASE_URL (Postgres de Neon) se usa su API HTTP; si no, un fichero SQLite local.
const DATABASE_URL = process.env.DATABASE_URL || '';
let db;
if (DATABASE_URL) {
  const host = new URL(DATABASE_URL).host;
  const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };
  const run = async (sql, params = []) => {
    const r = await fetch(`https://${host}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': DATABASE_URL, 'Neon-Raw-Text-Output': 'true', 'Neon-Array-Mode': 'true' },
      body: JSON.stringify({ query: toPg(sql), params }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || 'Error de base de datos');
    const names = (j.fields || []).map(f => f.name);
    return (j.rows || []).map(row => (Array.isArray(row) ? Object.fromEntries(row.map((v, i) => [names[i], v])) : row));
  };
  db = { all: run, run };
} else {
  const { DatabaseSync } = require('node:sqlite');
  const sq = new DatabaseSync(path.join(DATA_DIR, 'coleccion.db'));
  db = {
    all: async (sql, params = []) => sq.prepare(sql).all(...params),
    run: async (sql, params = []) => sq.prepare(sql).all(...params),
  };
}
async function initDb() {
  const idType = DATABASE_URL ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT';
  await db.run(`CREATE TABLE IF NOT EXISTS users (id ${idType}, username TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, created_at TEXT NOT NULL)`);
  await db.run(`CREATE TABLE IF NOT EXISTS photos (key TEXT PRIMARY KEY, url TEXT NOT NULL, updated TEXT NOT NULL)`);
  await db.run(`CREATE TABLE IF NOT EXISTS qty (user_id INTEGER NOT NULL, sticker TEXT NOT NULL, qty INTEGER NOT NULL, PRIMARY KEY (user_id, sticker))`);
}

/* ---------- Autenticación ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(pw, salt, 64);
  return salt.toString('hex') + ':' + h.toString('hex');
}
function checkPassword(pw, stored) {
  const [s, h] = stored.split(':');
  const calc = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const real = Buffer.from(h, 'hex');
  return calc.length === real.length && crypto.timingSafeEqual(calc, real);
}
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeToken(uid) {
  const exp = Date.now() + 1000 * 60 * 60 * 24 * 90;
  const v = `${uid}.${exp}`;
  return `${v}.${sign(v)}`;
}
function readToken(req) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
  if (!m) return null;
  const [uid, exp, sig] = m[1].split('.');
  if (!uid || !exp || !sig) return null;
  const good = sign(`${uid}.${exp}`);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
  if (Number(exp) < Date.now()) return null;
  return Number(uid);
}
function setCookie(req, res, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
const attempts = new Map();
function tooMany(key) {
  const now = Date.now();
  const a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, a);
  return a.length >= 10;
}
const noteAttempt = key => attempts.set(key, [...(attempts.get(key) || []), Date.now()]);

/* ---------- Clasificación y noticias (se actualizan solas) ---------- */
function seasonString() {
  const d = new Date();
  const y = d.getUTCFullYear();
  return d.getUTCMonth() >= 6 ? `${y}-${y + 1}` : `${y - 1}-${y}`;
}
const cache = { standings: null, news: null };
async function fetchJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'coleccion-liga/1.0' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function refreshStandings() {
  const j = await fetchJson('https://site.api.espn.com/apis/v2/sports/soccer/esp.1/standings');
  const entries = j.children?.[0]?.standings?.entries || [];
  const rows = entries.map(e => {
    const st = {};
    for (const x of e.stats || []) st[x.name] = x.value;
    return {
      rank: st.rank, team: e.team.displayName, badge: `https://a.espncdn.com/i/teamlogos/soccer/500/${e.team.id}.png`,
      played: st.gamesPlayed, win: st.wins, draw: st.ties, loss: st.losses, gf: st.pointsFor, ga: st.pointsAgainst,
      gd: st.pointDifferential, points: st.points,
    };
  }).filter(r => Number.isFinite(r.rank)).sort((x, y) => x.rank - y.rank);
  if (rows.length) cache.standings = { season: seasonString(), updated: new Date().toISOString(), table: rows };
}
const decode = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/<[^>]+>/g, '').trim();
const safeUrl = u => (/^https?:\/\//i.test(u || '') ? u : '');
function parseRss(xml, source) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const get = tag => { const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(b); return r ? decode(r[1]) : ''; };
    const img = /<(?:media:content|enclosure)[^>]*\burl="([^"]+)"/.exec(b);
    const date = new Date(get('pubDate'));
    const link = safeUrl(get('link'));
    if (!link || isNaN(date)) continue;
    items.push({ title: get('title'), link, date: date.toISOString(), image: safeUrl(img && img[1]), source });
  }
  return items;
}
const FEEDS = [
  ['Marca', 'https://e00-marca.uecdn.es/rss/futbol/primera-division.xml'],
  ['AS', 'https://feeds.as.com/mrss-s/pages/as/site/as.com/section/futbol/subsection/primera/'],
];
async function refreshNews() {
  const results = await Promise.allSettled(FEEDS.map(async ([name, url]) => {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 coleccion-liga' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return parseRss(await r.text(), name);
  }));
  const all = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  if (all.length) {
    all.sort((a, b) => b.date.localeCompare(a.date));
    cache.news = { updated: new Date().toISOString(), items: all.slice(0, 30) };
  }
}
const safely = fn => fn().catch(e => console.error('[actualización]', e.message));
safely(refreshStandings); safely(refreshNews);
setInterval(() => safely(refreshStandings), 30 * 60 * 1000).unref();
setInterval(() => safely(refreshNews), 10 * 60 * 1000).unref();


/* ---------- Fotos de jugadores (de internet, no de Panini) ---------- */
// Se buscan poco a poco (TheSportsDB y, si no hay, Wikipedia) y se guardan en la base de datos.
const photoMap = new Map(); // clave -> url ('' = sin foto encontrada)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = t => norm(t).replace(/\b(fc|cf|cd|ud|rcd|rc|sd|club|de|la|el|real)\b/g, '').replace(/\s+/g, ' ').trim();
const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const ALIASES = { deportivo: ['deportivo a coruna', 'deportivo la coruna', 'deportivo', 'depor'], athletic: ['athletic bilbao', 'athletic club', 'athletic club bilbao'],
  atletico: ['atletico madrid', 'atletico de madrid', 'club atletico de madrid'], racing: ['racing santander', 'racing de santander'] };
function teamMatch(strTeam, team) {
  const c = clean(strTeam);
  return !!c && (c === clean(team.tsdb) || c === clean(team.name) || (ALIASES[team.slug] || []).map(clean).includes(c));
}
const anyTeamMatch = strTeam => CHECKLIST.teams.some(t => teamMatch(strTeam, t));
const photoKey = s => `${s.team}|${norm(s.name)}`;
const imgOf = p => p.strCutout || p.strThumb || p.strRender || '';
async function tsdbPhoto(s) {
  const j = await fetchJson(`https://www.thesportsdb.com/api/v1/json/3/searchplayers.php?p=${encodeURIComponent(s.name)}`);
  const c = (j.player || []).filter(p => (!p.strSport || p.strSport === 'Soccer') && imgOf(p));
  const team = CHECKLIST.teams.find(t => t.slug === s.team);
  const toks = norm(s.name).split(' ').filter(t => t.length > 1);
  const nameOk = p => toks.every(t => norm(p.strPlayer).includes(t));
  let hit = team && c.find(p => teamMatch(p.strTeam, team) && nameOk(p));
  if (!hit) hit = c.find(p => anyTeamMatch(p.strTeam) && nameOk(p));
  if (!hit && toks.length >= 2) { const cand = c.filter(nameOk); if (cand.length === 1) hit = cand[0]; }
  return hit ? imgOf(hit) + '/small' : '';
}
async function wikiPhoto(s) {
  const team = CHECKLIST.teams.find(t => t.slug === s.team);
  const q = `${s.name} ${team ? team.name : ''} futbolista`;
  const j = await fetchJson(`https://es.wikipedia.org/w/api.php?action=query&format=json&generator=search&gsrsearch=${encodeURIComponent(q)}&gsrlimit=3&prop=pageimages%7Cextracts&piprop=thumbnail&pithumbsize=320&exintro=1&explaintext=1&exchars=400&redirects=1`);
  const pages = Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index);
  const toks = norm(s.name).split(' ').filter(t => t.length > 2);
  for (const p of pages) {
    if (!p.thumbnail?.source || !toks.every(t => norm(p.title).includes(t)) || !/futbol|football/.test(norm(p.extract))) continue;
    return safeUrl(p.thumbnail.source);
  }
  return '';
}
async function loadPhotos() {
  for (const r of await db.all('SELECT key, url FROM photos')) photoMap.set(r.key, r.url);
  // Fotos ya comprobadas que vienen con la web (TheSportsDB y Wikipedia). Tienen prioridad.
  try {
    const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'photos.json'), 'utf8'));
    for (const [k, url] of Object.entries(seed)) {
      const i = k.indexOf('|');
      if (url && /^https:\/\//.test(url)) photoMap.set(`${k.slice(0, i)}|${norm(k.slice(i + 1))}`, url);
    }
  } catch (e) { console.error('[fotos] sin data/photos.json:', e.message); }
}
let photoBusy = false;
async function photoPass() {
  if (photoBusy) return;
  photoBusy = true;
  try {
    const seen = new Set();
    for (const s of CHECKLIST.stickers) {
      const k = photoKey(s);
      if (s.pos === 'escudo' || seen.has(k) || photoMap.has(k)) continue;
      seen.add(k);
      let url = '', failed = 0;
      try { url = await tsdbPhoto(s); } catch (e) { failed++; }
      if (!url) { try { url = await wikiPhoto(s); } catch (e) { failed++; } }
      if (!url && failed) { await sleep(20000); continue; } // fallo de red: no se guarda como "sin foto"
      photoMap.set(k, url);
      await db.run('INSERT INTO photos (key, url, updated) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET url = excluded.url, updated = excluded.updated', [k, url, new Date().toISOString()]);
      await sleep(PHOTO_DELAY);
    }
  } catch (e) { console.error('[fotos]', e.message); }
  photoBusy = false;
}
const PHOTO_DELAY = Number(process.env.PHOTO_DELAY_MS || 2300);

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 20000) { reject(new Error('grande')); req.destroy(); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const validUser = u => typeof u === 'string' && /^[a-zA-Z0-9_.-]{3,20}$/.test(u);
const validPass = p => typeof p === 'string' && p.length >= 6 && p.length <= 100;

async function api(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;

  if (method === 'GET' && p === '/api/checklist') return json(res, 200, CHECKLIST);
  if (method === 'GET' && p === '/api/standings') return json(res, 200, cache.standings || { season: seasonString(), updated: null, table: [] });
  if (method === 'GET' && p === '/api/photos') {
    const out = {};
    for (const st of CHECKLIST.stickers) { const u = photoMap.get(photoKey(st)); if (u) out[st.id] = u; }
    return json(res, 200, out);
  }
  if (method === 'GET' && p === '/api/images') {
    let files = [];
    try { files = fs.readdirSync(path.join(PUBLIC_DIR, 'img')).filter(f => /\.(png|jpe?g|webp|svg)$/i.test(f)); } catch {}
    return json(res, 200, files);
  }
  if (method === 'GET' && p === '/api/news') return json(res, 200, cache.news || { updated: null, items: [] });

  if (method !== 'GET' && !(req.headers['content-type'] || '').startsWith('application/json')) return json(res, 415, { error: 'Formato no válido' });

  if (method === 'POST' && (p === '/api/register' || p === '/api/login')) {
    const body = await readBody(req);
    const username = String(body.username || '').trim();
    const password = body.password;
    const key = `${ip}:${username.toLowerCase()}`;
    if (tooMany(key) || tooMany(ip)) return json(res, 429, { error: 'Demasiados intentos, espera unos minutos.' });
    if (p === '/api/register') {
      if (!validUser(username)) return json(res, 400, { error: 'Usuario: 3-20 caracteres (letras, números, _ . -).' });
      if (!validPass(password)) return json(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
      const exists = await db.all('SELECT id FROM users WHERE lower(username) = lower(?)', [username]);
      if (exists.length) { noteAttempt(ip); return json(res, 409, { error: 'Ese usuario ya existe.' }); }
      const rows = await db.all('INSERT INTO users (username, pass, created_at) VALUES (?, ?, ?) RETURNING id', [username, hashPassword(password), new Date().toISOString()]);
      const id = Number(rows[0].id);
      setCookie(req, res, makeToken(id), 60 * 60 * 24 * 90);
      return json(res, 201, { username });
    }
    const rows = await db.all('SELECT id, username, pass FROM users WHERE lower(username) = lower(?)', [username]);
    if (!rows.length || typeof password !== 'string' || !checkPassword(password, rows[0].pass)) {
      noteAttempt(key); noteAttempt(ip);
      return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
    }
    setCookie(req, res, makeToken(Number(rows[0].id)), 60 * 60 * 24 * 90);
    return json(res, 200, { username: rows[0].username });
  }
  if (method === 'POST' && p === '/api/logout') { setCookie(req, res, '', 0); return json(res, 200, { ok: true }); }

  const uid = readToken(req);
  if (p === '/api/me' && method === 'GET') {
    if (!uid) return json(res, 200, { user: null });
    const r = await db.all('SELECT username FROM users WHERE id = ?', [uid]);
    return json(res, 200, { user: r.length ? r[0].username : null });
  }
  if (!uid) return json(res, 401, { error: 'Inicia sesión' });

  if (method === 'GET' && p === '/api/collection') {
    const rows = await db.all('SELECT sticker, qty FROM qty WHERE user_id = ? AND qty > 0', [uid]);
    const out = {};
    for (const r of rows) out[r.sticker] = Number(r.qty);
    return json(res, 200, out);
  }
  if (method === 'PUT' && p === '/api/collection') {
    const b = await readBody(req);
    const q = Math.floor(Number(b.qty));
    if (!VALID_IDS.has(b.id) || !Number.isFinite(q) || q < 0 || q > 99) return json(res, 400, { error: 'Datos no válidos' });
    await db.run('INSERT INTO qty (user_id, sticker, qty) VALUES (?, ?, ?) ON CONFLICT (user_id, sticker) DO UPDATE SET qty = excluded.qty', [uid, b.id, q]);
    return json(res, 200, { id: b.id, qty: q });
  }
  return json(res, 404, { error: 'No encontrado' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No encontrado'); }
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
      res.end(buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Error del servidor' });
  }
});

initDb().then(loadPhotos).then(() => { photoPass(); setInterval(photoPass, 30 * 60 * 1000).unref(); }).then(() => server.listen(PORT, () => console.log(`Colección Liga 26/27 en http://localhost:${PORT} (${CHECKLIST.stickers.length} cromos)`)))
  .catch(e => { console.error('No se pudo iniciar la base de datos:', e); process.exit(1); });
