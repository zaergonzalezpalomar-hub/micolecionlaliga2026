'use strict';
/* Colección Liga 26/27 — interfaz (JavaScript sin librerías) */
const app = document.getElementById('app');
const state = {
  user: null, checklist: null, coll: {}, standings: null, news: null, images: new Set(), photos: {},
  tab: 'coleccion', group: 'all', q: '', authMode: 'login',
};

/* ---------- Utilidades ---------- */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
}
const norm = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Error'); e.status = r.status; throw e; }
  return j;
}
const fmtDate = iso => iso ? new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

/* ---------- Datos derivados ---------- */
const posClass = p => ({ escudo: 'es', portero: 'gk', defensa: 'df', medio: 'md', delantero: 'fw' }[p] || '');
const teamBySlug = slug => state.checklist.teams.find(t => t.slug === slug);
const groupName = slug => (teamBySlug(slug) || state.checklist.sections.find(s => s.slug === slug) || {}).name || slug;
const qty = id => state.coll[id] || 0;
function crestUrl(slug) {
  const t = teamBySlug(slug);
  if (!t) return null;
  for (const ext of ['png', 'svg', 'webp', 'jpg', 'jpeg']) if (state.images.has(`crest-${slug}.${ext}`)) return `/img/crest-${slug}.${ext}`;
  return t.crest || null;
}
function crest(slug, big) {
  const url = crestUrl(slug);
  const t = teamBySlug(slug);
  const cls = 'crest' + (big ? ' big' : '');
  const ph = () => {
    let hue = 0; for (const c of slug) hue = (hue * 31 + c.charCodeAt(0)) % 360;
    return h('div', { class: cls + ' ph', style: `background:hsl(${hue} 55% 38%)`, text: (t?.name || slug).replace(/^(RC|RCD|Real|Club|Deportivo)\s+/i, '').slice(0, 3).toUpperCase() });
  };
  if (!url) return ph();
  const img = h('img', { class: cls, src: url, alt: t?.name || '', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(ph()));
  return img;
}
function photoFor(id) {
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) if (state.images.has(`${id}.${ext}`)) return `/img/${id}.${ext}`;
  return state.photos[id] || null;
}
function visibleStickers(filterFn) {
  const q = norm(state.q).trim();
  return state.checklist.stickers.filter(s => {
    if (state.group !== 'all' && s.group !== state.group) return false;
    if (q && !(norm(s.name).includes(q) || norm(s.code).includes(q) || norm(groupName(s.team)).includes(q))) return false;
    return filterFn ? filterFn(s) : true;
  });
}
function byGroup(list) {
  const order = [...state.checklist.teams.map(t => t.slug), ...state.checklist.sections.map(s => s.slug)];
  const m = new Map(order.map(g => [g, []]));
  for (const s of list) m.get(s.group).push(s);
  return [...m].filter(([, arr]) => arr.length);
}
const stats = () => {
  const all = state.checklist.stickers;
  const have = all.filter(s => qty(s.id) > 0).length;
  const spare = all.reduce((n, s) => n + Math.max(0, qty(s.id) - 1), 0);
  return { total: all.length, have, missing: all.length - have, spare };
};

/* ---------- Guardado de cantidades ---------- */
const timers = {};
function setQty(id, q) {
  q = Math.max(0, Math.min(99, q));
  if (q === qty(id)) return;
  if (q === 0) delete state.coll[id]; else state.coll[id] = q;
  refreshCards(id);
  clearTimeout(timers[id]);
  timers[id] = setTimeout(async () => {
    try { await api('PUT', '/api/collection', { id, qty: qty(id) }); }
    catch (e) {
      if (e.status === 401) { state.user = null; render(); return; }
      toast('No se pudo guardar. Comprobando…');
      try { state.coll = await api('GET', '/api/collection'); render(); } catch {}
    }
  }, 350);
}

/* ---------- Tarjetas ---------- */
function stateClass(id) { const q = qty(id); return q === 0 ? 'none' : q > 1 ? 'have rep' : 'have'; }
function refreshCards(id) {
  for (const el of document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`)) {
    const out = el.querySelector('output');
    if (out) out.textContent = qty(id);
    if (el.classList.contains('card')) {
      el.classList.remove('none', 'have', 'rep');
      el.classList.add(...stateClass(id).split(' '));
      const flag = el.querySelector('.flag');
      if (flag) flag.textContent = qty(id) > 1 ? `+${qty(id) - 1} repe` : '✓';
      flag.hidden = qty(id) === 0;
    }
  }
  updateProgress();
  if (state.tab === 'repetidos' || state.tab === 'faltan') renderTab();
}
function card(s) {
  const photo = photoFor(s.id);
  const art = h('div', { class: 'art' + (photo ? ' withphoto' : '') }, h('span', { class: 'code', text: s.code }), s.note && /ed/.test(s.note) ? h('span', { class: 'ed', text: s.note.replace(/\s/g, '') }) : null,
    crest(s.team, s.pos === 'escudo' && !photo));
  if (photo) {
    const img = h('img', { class: 'photo' + (/\/cutout\/|\/render\//.test(photo) ? ' cut' : ''), src: photo, alt: s.name, loading: 'lazy', referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => { if (img.src.endsWith('/small')) img.src = img.src.slice(0, -6); else img.remove(); }, { once: false });
    art.append(img);
    art.classList.add('hasimg');
  }
  const flag = h('span', { class: 'flag' });
  const el = h('article', { class: `card ${posClass(s.pos)} ${stateClass(s.id)}`, 'data-id': s.id },
    art, flag,
    h('div', { class: 'info' }, h('div', { class: 'nm', text: s.name }), h('div', { class: 'ps', text: s.pos === 'escudo' ? 'Escudo' : s.pos + (s.group !== s.team || s.group === 'x' ? ` · ${groupName(s.team)}` : '') })),
    h('div', { class: 'ctl' },
      h('button', { 'aria-label': 'Quitar uno', onclick: () => setQty(s.id, qty(s.id) - 1), text: '−' }),
      h('output', { text: qty(s.id) }),
      h('button', { class: 'plus', 'aria-label': 'Añadir uno', onclick: () => setQty(s.id, qty(s.id) + 1), text: '+' })));
  flag.textContent = qty(s.id) > 1 ? `+${qty(s.id) - 1} repe` : '✓'; flag.hidden = qty(s.id) === 0;
  return el;
}
function groupHeader(slug, list, extra) {
  const isTeam = !!teamBySlug(slug);
  const have = list.filter(s => qty(s.id) > 0).length;
  return h('h3', {}, isTeam ? crest(slug) : null, groupName(slug), h('small', { text: extra || `${have}/${list.length}` }));
}

/* ---------- Vistas ---------- */
function updateProgress() {
  const st = stats();
  const el = document.getElementById('progress');
  if (!el) return;
  const pct = Math.round((st.have / st.total) * 100);
  el.querySelector('strong').textContent = `${st.have} / ${st.total}`;
  el.querySelector('small').textContent = `${pct}% completado · ${st.missing} faltan · ${st.spare} repetidos`;
  el.querySelector('.bar i').style.width = pct + '%';
  const nav = document.querySelectorAll('.nav .count');
  if (nav.length) { nav[0].textContent = st.spare; nav[1].textContent = st.missing; }
}
function filters(withChips) {
  const wrap = h('div', {});
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Buscar jugador, número o equipo…', value: state.q, 'aria-label': 'Buscar' });
  search.addEventListener('input', () => { state.q = search.value; renderBody(); });
  const bar = h('div', { class: 'toolbar' }, search);
  if (!withChips) {
    const sel = h('select', { class: 'btn', 'aria-label': 'Filtrar por equipo' }, h('option', { value: 'all', text: 'Todos los equipos' }),
      ...state.checklist.teams.map(t => h('option', { value: t.slug, text: t.name })), ...state.checklist.sections.map(s => h('option', { value: s.slug, text: s.name })));
    sel.value = state.group;
    sel.addEventListener('change', () => { state.group = sel.value; renderBody(); });
    bar.append(sel);
  }
  wrap.append(bar);
  if (withChips) {
    const chips = h('div', { class: 'chips' }, h('button', { class: 'chip sp' + (state.group === 'all' ? ' on' : ''), onclick: () => { state.group = 'all'; renderTab(); }, text: 'Todos' }));
    for (const t of state.checklist.teams) chips.append(h('button', { class: 'chip' + (state.group === t.slug ? ' on' : ''), title: t.name, onclick: () => { state.group = t.slug; renderTab(); } }, crest(t.slug), h('small', { text: t.name.replace(/^(RC|RCD|Real|Club|FC|CF)\s+/i, '') })));
    for (const s of state.checklist.sections) chips.append(h('button', { class: 'chip sp' + (state.group === s.slug ? ' on' : ''), onclick: () => { state.group = s.slug; renderTab(); }, text: s.name }));
    wrap.append(chips);
  }
  return wrap;
}
function renderColeccion(root) {
  root.append(h('div', { class: 'progress', id: 'progress' }, h('div', { class: 'row' }, h('strong'), h('small')), h('div', { class: 'bar' }, h('i'))));
  root.append(filters(true), h('div', { id: 'body' }),
    h('p', { class: 'note credits', text: 'Imágenes de internet (no de Panini): fotos de jugadores de TheSportsDB y Wikimedia Commons (licencias libres; autores en cada archivo), escudos de ESPN.' }));
  updateProgress();
  renderBody();
}
function renderBody() {
  const body = document.getElementById('body');
  if (!body) return;
  body.replaceChildren();
  if (state.tab === 'coleccion') {
    const groups = byGroup(visibleStickers());
    if (!groups.length) return body.append(h('div', { class: 'empty', text: 'No hay cromos que coincidan con la búsqueda.' }));
    for (const [slug, list] of groups) body.append(h('section', { class: 'group' }, groupHeader(slug, state.checklist.stickers.filter(s => s.group === slug)), h('div', { class: 'grid' }, list.map(card))));
  } else {
    const isRep = state.tab === 'repetidos';
    const list = visibleStickers(s => (isRep ? qty(s.id) > 1 : qty(s.id) === 0));
    if (!list.length) return body.append(h('div', { class: 'empty', text: isRep ? 'Todavía no tienes repetidos.' : (state.q || state.group !== 'all' ? 'No hay cromos que coincidan.' : '¡Colección completa! 🎉') }));
    const total = isRep ? list.reduce((n, s) => n + qty(s.id) - 1, 0) : list.length;
    body.append(h('div', { class: 'toolbar' }, h('button', { class: 'btn accent', onclick: () => copyList(list, isRep), text: isRep ? `Copiar lista de repetidos (${total})` : `Copiar lista de faltas (${total})` })));
    for (const [slug, arr] of byGroup(list)) {
      body.append(h('section', { class: 'group' }, groupHeader(slug, arr, isRep ? `${arr.reduce((n, s) => n + qty(s.id) - 1, 0)} repes` : `${arr.length} faltan`),
        h('div', { class: 'list' }, arr.map(s => h('div', { class: 'item', 'data-id': s.id },
          h('span', { class: 'tag', text: s.code }),
          h('div', { class: 'txt' }, h('b', { text: s.name }), h('small', { text: (s.pos === 'escudo' ? 'Escudo' : s.pos) + (teamBySlug(s.group) ? '' : ' · ' + groupName(s.team)) })),
          isRep ? [h('span', { class: 'extra', text: `+${qty(s.id) - 1}` }), h('button', { 'aria-label': 'Quitar uno', onclick: () => setQty(s.id, qty(s.id) - 1), text: '−' })]
                : h('button', { 'aria-label': 'Ya lo tengo', title: 'Ya lo tengo', onclick: () => setQty(s.id, 1), text: '+' }))))));
    }
  }
}
function copyList(list, isRep) {
  const lines = [isRep ? 'Mis repetidos (Liga 26/27):' : 'Me faltan (Liga 26/27):'];
  for (const [slug, arr] of byGroup(list)) {
    const items = arr.map(s => `${s.code} ${s.name}${teamBySlug(s.group) ? '' : ' (' + groupName(s.team) + ')'}${isRep && qty(s.id) > 2 ? ` x${qty(s.id) - 1}` : ''}`);
    lines.push(`${groupName(slug)}: ${items.join(', ')}`);
  }
  const text = lines.join('\n');
  const done = () => toast('Lista copiada');
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  else fallbackCopy(text, done);
}
function fallbackCopy(text, cb) {
  const ta = h('textarea', { style: 'position:fixed;opacity:0' }); ta.value = text; document.body.append(ta); ta.select();
  try { document.execCommand('copy'); cb(); } catch { toast('No se pudo copiar'); }
  ta.remove();
}

function renderLiga(root) {
  const st = state.standings, nw = state.news;
  const rows = st?.table || [];
  const table = rows.length ? h('table', {},
    h('thead', {}, h('tr', {}, ['#', 'Equipo', 'PJ', 'G', 'E', 'P', 'DG', 'Pts'].map((t, i) => h('th', { class: [3, 4, 5].includes(i) ? 'opt' : '', text: t })))),
    h('tbody', {}, rows.map(r => h('tr', { class: r.rank <= 4 ? 'top4' : r.rank <= 6 ? 'eu' : r.rank > rows.length - 3 ? 'rel' : '' },
      h('td', { text: r.rank }),
      h('td', { class: 't' }, h('div', {}, r.badge ? h('img', { src: r.badge, alt: '', loading: 'lazy' }) : null, r.team)),
      h('td', { text: r.played }), h('td', { class: 'opt', text: r.win }), h('td', { class: 'opt', text: r.draw }), h('td', { class: 'opt', text: r.loss }),
      h('td', { text: r.gd > 0 ? '+' + r.gd : r.gd }), h('td', { class: 'pts', text: r.points })))))
    : h('div', { class: 'empty', text: 'La clasificación aún no está disponible. Se reintenta sola cada pocos minutos.' });
  const news = nw?.items?.length ? h('div', { class: 'news' }, nw.items.map(n => h('a', { class: 'new', href: n.link, target: '_blank', rel: 'noopener noreferrer' },
    n.image ? h('img', { src: n.image, alt: '', loading: 'lazy' }) : null,
    h('div', {}, h('b', { text: n.title }), h('small', { text: `${n.source} · ${fmtDate(n.date)}` })))))
    : h('div', { class: 'empty', text: 'Las noticias aún no están disponibles. Se reintenta sola cada pocos minutos.' });
  root.append(h('div', { class: 'two' },
    h('section', { class: 'panel' }, h('h2', {}, `Clasificación ${st?.season || ''}`, h('small', { text: 'Actualizada: ' + fmtDate(st?.updated) })), table,
      rows.length ? h('p', { class: 'note', text: 'Verde: Champions · Azul: Europa · Rojo: descenso.' }) : null),
    h('section', { class: 'panel' }, h('h2', {}, 'Últimas noticias', h('small', { text: 'Actualizadas: ' + fmtDate(nw?.updated) })), news)));
}

/* ---------- Acceso ---------- */
function renderAuth() {
  const login = state.authMode === 'login';
  const err = h('p', { class: 'err' });
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, maxlength: 20, autocapitalize: 'none' });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: login ? 'current-password' : 'new-password', required: true, minlength: 6 });
  const btn = h('button', { class: 'primary', type: 'submit', text: login ? 'Entrar' : 'Crear cuenta' });
  const form = h('form', {}, h('label', { class: 'field' }, h('span', { text: 'Usuario' }), user), h('label', { class: 'field' }, h('span', { text: 'Contraseña' + (login ? '' : ' (mínimo 6 caracteres)') }), pass), btn, err);
  form.addEventListener('submit', async ev => {
    ev.preventDefault(); err.textContent = ''; btn.disabled = true;
    try {
      await api('POST', login ? '/api/login' : '/api/register', { username: user.value.trim(), password: pass.value });
      await boot();
    } catch (e) { err.textContent = e.message; btn.disabled = false; }
  });
  app.replaceChildren(h('div', { class: 'auth' },
    h('h2', { text: 'Colección Liga 26/27' }), h('p', { text: 'Controla tus cromos, repetidos y faltas desde el móvil o el PC.' }),
    h('div', { class: 'tabs' },
      h('button', { class: login ? 'on' : '', type: 'button', onclick: () => { state.authMode = 'login'; renderAuth(); }, text: 'Entrar' }),
      h('button', { class: login ? '' : 'on', type: 'button', onclick: () => { state.authMode = 'register'; renderAuth(); }, text: 'Registrarme' })),
    form));
  user.focus();
}

/* ---------- Estructura general ---------- */
function render() {
  if (!state.user) return renderAuth();
  const st = stats();
  const tabs = [['coleccion', 'Colección'], ['repetidos', 'Repetidos', st.spare], ['faltan', 'Faltan', st.missing], ['liga', 'Liga']];
  const nav = h('nav', { class: 'nav' }, tabs.map(([id, label, n]) => h('button', { class: state.tab === id ? 'on' : '', onclick: () => { if (state.tab !== id) { state.tab = id; state.q = ''; if (id !== 'coleccion' && id !== 'liga') state.group = 'all'; render(); scrollTo(0, 0); } } },
    label, n != null ? h('span', { class: 'count', text: n }) : null)));
  const top = h('header', { class: 'top' }, h('h1', {}, 'Liga ', h('span', { text: '26/27' })), h('span', { class: 'who', text: state.user }),
    h('button', { onclick: async () => { await api('POST', '/api/logout', {}).catch(() => {}); state.user = null; state.coll = {}; render(); }, text: 'Salir' }));
  app.replaceChildren(top, nav, h('main', { id: 'main' }));
  renderTab();
}
function renderTab() {
  const main = document.getElementById('main');
  if (!main) return;
  const y = scrollY;
  main.replaceChildren();
  if (state.tab === 'coleccion') renderColeccion(main);
  else if (state.tab === 'liga') renderLiga(main);
  else { main.append(filters(false), h('div', { id: 'body' })); renderBody(); }
  document.querySelectorAll('.nav button').forEach((b, i) => b.classList.toggle('on', ['coleccion', 'repetidos', 'faltan', 'liga'][i] === state.tab));
  updateProgress();
  scrollTo(0, y);
}

/* ---------- Carga inicial y actualizaciones automáticas ---------- */
async function loadLive() {
  const [s, n, ph] = await Promise.allSettled([api('GET', '/api/standings'), api('GET', '/api/news'), api('GET', '/api/photos')]);
  if (s.status === 'fulfilled') state.standings = s.value;
  if (n.status === 'fulfilled') state.news = n.value;
  let newPhotos = false;
  if (ph.status === 'fulfilled') { newPhotos = Object.keys(ph.value).length !== Object.keys(state.photos).length; state.photos = ph.value; }
  if (state.user && (state.tab === 'liga' || (newPhotos && state.tab === 'coleccion'))) {
    if (document.activeElement?.tagName === 'INPUT') return; // no interrumpir mientras se escribe
    renderTab();
  }
}
async function boot() {
  try {
    const [me, cl, img, ph] = await Promise.all([api('GET', '/api/me'), state.checklist || api('GET', '/api/checklist'), api('GET', '/api/images').catch(() => []), api('GET', '/api/photos').catch(() => ({}))]);
    state.checklist = cl; state.images = new Set(img); state.user = me.user; state.photos = ph;
    state.coll = me.user ? await api('GET', '/api/collection') : {};
  } catch (e) { app.replaceChildren(h('div', { class: 'auth' }, h('h2', { text: 'Sin conexión' }), h('p', { text: 'No se pudo cargar la web. Reintenta en unos segundos.' }))); return; }
  render();
  loadLive();
}
boot();
setInterval(loadLive, 2 * 60 * 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.user) loadLive(); });
