import { fmt, naiveDate, fmtClock, fmtDate, fmtElapsed, fmtDuration, getJson, callWithCode } from './common.js';
import { renderMarkdown } from './md.js';

const $ = (id) => document.getElementById(id);
const READOUT = { sog: 1, cog: 0, awa: 0, aws: 1, twa: 0, tws: 1, vmg: 1, pitch: 1, roll: 1 };
const CHARTS = [
  { key: 'sog', title: 'Vitesse (kn)', color: '#1f5f7a', zero: true },
  { key: 'vmg', title: 'VMG (kn)', color: '#2f7d5b', zero: true },
  { key: 'roll', title: 'Roll (°)', color: '#a86a00', zero: true },
  { key: 'pitch', title: 'Pitch (°)', color: '#6b4c9a', zero: false },
];
const BAND = { tack: 'rgba(31,95,122,0.16)', gybe: 'rgba(168,106,0,0.22)' };
const SVG = 'http://www.w3.org/2000/svg';

let sessionId = 0;
let seek = () => {};

function showMessage(text) {
  $('message').textContent = text;
  $('message').hidden = false;
}

async function main() {
  sessionId = Number(new URLSearchParams(location.search).get('id'));
  if (!Number.isInteger(sessionId) || sessionId <= 0) return showMessage('Session introuvable. Choisis une session dans la liste.');
  let data;
  try {
    data = await getJson('/api/sessions/' + sessionId);
  } catch (e) {
    return showMessage(e.message);
  }
  if (data.meta.empty) return showMessage('Cette session ne contient aucune donnée.');
  $('content').hidden = false;
  $('timebar').hidden = false;
  render(data);
}

// ---------- Cartes ----------

const kn = (v) => (v === null || v === undefined ? null : fmt(v, 1));
const deg = (v) => (v === null || v === undefined ? null : fmt(v, 1));
const pct = (v) => (v === null || v === undefined ? null : fmt(v * 100, 0));
const sec = (v) => (v === null || v === undefined ? null : fmt(v, 0));

function face(cls, label, value, unit, tag) {
  const f = document.createElement('span');
  f.className = 'face ' + cls;
  const l = document.createElement('span');
  l.className = 'label';
  l.textContent = label;
  const v = document.createElement('span');
  v.className = 'value';
  v.append(value === null ? '–' : value);
  if (unit && value !== null) {
    const u = document.createElement('small');
    u.textContent = unit;
    v.append(u);
  }
  f.append(l, v);
  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag';
    t.textContent = tag;
    f.append(t);
  }
  return f;
}

// c : { label, value, unit, tag, alt: { value }, jump, extra }
function card(c) {
  const flippable = c.alt && c.alt.value !== null;
  const el = document.createElement(flippable || c.jump !== undefined ? 'button' : 'div');
  el.className = 'card';
  const inner = document.createElement('span');
  inner.className = 'card-inner';
  inner.append(face('front', c.label, c.value, c.unit, flippable ? '↻ moyenne' + (c.extra ? ' · ' + c.extra : '') : c.extra || ''));
  if (flippable) {
    inner.append(face('back', c.label, c.alt.value, c.unit, '↻ médiane'));
    el.type = 'button';
    el.setAttribute('aria-pressed', 'false');
    el.title = 'Afficher la médiane';
    el.addEventListener('click', () => {
      const on = el.classList.toggle('flipped');
      el.setAttribute('aria-pressed', String(on));
    });
  } else if (c.jump !== undefined) {
    el.type = 'button';
    el.title = 'Aller à cet instant';
    el.addEventListener('click', () => c.jump !== null && seek(c.jump));
  }
  el.append(inner);
  return el;
}

function group(title, cards) {
  const g = document.createElement('div');
  g.className = 'group';
  const h = document.createElement('h2');
  h.textContent = title;
  const grid = document.createElement('div');
  grid.className = 'cards';
  for (const c of cards) grid.append(card(c));
  g.append(h, grid);
  return g;
}

function renderCards(stats, meta) {
  const t = stats.tack;
  const g = stats.gybe;
  $('stats').append(
    group('Séance', [
      { label: 'Durée totale', value: fmtDuration(meta.duration_s) },
      { label: 'Distance', value: stats.distance_nm === null ? null : fmt(stats.distance_nm, 2), unit: 'nm', extra: stats.distance_km === null ? '' : fmt(stats.distance_km, 1) + ' km' },
    ]),
    group('Vitesse', [
      { label: 'Vitesse max', value: kn(stats.speed_max), unit: 'kn' },
      { label: 'Vitesse moyenne', value: kn(stats.speed_mean), unit: 'kn', alt: { value: kn(stats.speed_median) } },
    ]),
    group('VMG', [
      { label: 'VMG max au près', value: kn(stats.vmg_up_max), unit: 'kn' },
      { label: 'VMG moyenne au près', value: kn(stats.vmg_up_mean), unit: 'kn', alt: { value: kn(stats.vmg_up_median) } },
      { label: 'VMG max au portant', value: kn(stats.vmg_down_max), unit: 'kn' },
      { label: 'VMG moyenne au portant', value: kn(stats.vmg_down_mean), unit: 'kn', alt: { value: kn(stats.vmg_down_median) } },
    ]),
    group('Assiette', [
      { label: 'Pitch moyen', value: deg(stats.pitch_mean), unit: '°', alt: { value: deg(stats.pitch_median) } },
      { label: 'Pitch max', value: deg(stats.pitch_max), unit: '°' },
      { label: 'Roll moyen', value: deg(stats.roll_mean), unit: '°', alt: { value: deg(stats.roll_median) } },
      { label: 'Roll max', value: deg(stats.roll_max), unit: '°' },
    ]),
    group('Manœuvres', [
      { label: 'Vitesse conservée en virement', value: pct(t.retention_mean), unit: '%', alt: { value: pct(t.retention_median) }, extra: t.count + ' virements' },
      { label: 'Vitesse conservée en empannage', value: pct(g.retention_mean), unit: '%', alt: { value: pct(g.retention_median) }, extra: g.count + ' empannages' },
      { label: 'Temps moyen pour repartir', value: sec(stats.recover_mean_s), unit: 's', alt: { value: sec(stats.recover_median_s) } },
      { label: 'Meilleur virement', value: t.best ? pct(t.best.retention) : null, unit: '%', jump: t.best ? t.best.t : null, extra: t.best ? '→ voir' : '' },
      { label: 'Meilleur empannage', value: g.best ? pct(g.best.retention) : null, unit: '%', jump: g.best ? g.best.t : null, extra: g.best ? '→ voir' : '' },
    ])
  );
}

// ---------- Débrief IA ----------

let pollTimer = 0;

function renderDebrief(d) {
  const body = $('debrief-body');
  const foot = $('debrief-foot');
  const btn = $('debrief-btn');
  clearTimeout(pollTimer);
  body.textContent = '';
  foot.textContent = '';
  btn.hidden = !d.enabled;
  btn.disabled = d.status === 'pending';
  btn.textContent = d.text ? 'Régénérer' : 'Générer le débrief';

  if (d.text) body.append(renderMarkdown(d.text));
  if (d.status === 'pending') {
    foot.textContent = 'Rédaction en cours, la page se met à jour toute seule…';
    pollTimer = setTimeout(refreshDebrief, 5000);
  } else if (d.status === 'error') {
    foot.textContent = 'La génération a échoué : ' + (d.error || 'erreur inconnue') + '.';
  } else if (d.text) {
    foot.textContent = 'Généré par ' + d.model + ' le ' + new Date(d.created_at).toLocaleString('fr-CH') + '. Basé sur cette seule séance : les causes proposées sont des hypothèses.';
  } else if (!d.enabled) {
    foot.textContent = "Le débrief IA n'est pas activé sur ce serveur (variable ANTHROPIC_API_KEY).";
  } else {
    foot.textContent = "Aucun débrief pour l'instant (il faut le GPS et l'anémomètre).";
  }
}

async function refreshDebrief() {
  try {
    renderDebrief(await getJson('/api/sessions/' + sessionId + '/debrief'));
  } catch (e) {
    pollTimer = setTimeout(refreshDebrief, 10000);
  }
}

$('debrief-btn').addEventListener('click', async () => {
  $('debrief-btn').disabled = true;
  try {
    renderDebrief(await callWithCode('/api/sessions/' + sessionId + '/debrief', 'POST'));
  } catch (e) {
    $('debrief-foot').textContent = e.message;
    $('debrief-btn').disabled = false;
  }
});

// ---------- Polaire ----------

function el(name, attrs, parent) {
  const e = document.createElementNS(SVG, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.append(e);
  return e;
}

function renderPolar(series, bins) {
  const holder = $('polar');
  const size = 400;
  const c = size / 2;
  const radius = 170;
  const speeds = series.sog.filter((v) => v !== null);
  if (speeds.length === 0 || series.twa.every((v) => v === null)) {
    holder.textContent = 'Pas de données de vent et de vitesse.';
    return () => {};
  }
  const vmax = Math.max(...speeds, ...bins.map((b) => b.p90));
  const step = vmax > 12 ? 2 : 1;
  const top = Math.ceil(vmax / step) * step;
  const pos = (twa, speed) => {
    const a = (twa * Math.PI) / 180;
    const r = (speed / top) * radius;
    return [c + r * Math.sin(a), c - r * Math.cos(a)];
  };

  const svg = el('svg', { viewBox: '0 0 ' + size + ' ' + size, role: 'img', 'aria-label': 'Courbe polaire : vitesse selon l’angle au vent' });
  for (let v = step; v <= top; v += step) {
    el('circle', { cx: c, cy: c, r: (v / top) * radius, fill: 'none', stroke: 'rgba(20,20,19,0.15)' }, svg);
    const t = el('text', { x: c + 4, y: c - (v / top) * radius - 2, 'font-size': 10, fill: 'rgba(20,20,19,0.6)' }, svg);
    t.textContent = v + ' kn';
  }
  for (let a = 0; a < 180; a += 30) {
    const [x1, y1] = pos(a, top);
    const [x2, y2] = pos(a + 180, top);
    el('line', { x1, y1, x2, y2, stroke: 'rgba(20,20,19,0.15)' }, svg);
  }
  for (let a = -150; a <= 180; a += 30) {
    const [x, y] = pos(a, top * 1.1);
    const t = el('text', { x, y, 'font-size': 11, 'text-anchor': 'middle', 'dominant-baseline': 'middle', fill: 'rgba(20,20,19,0.7)' }, svg);
    t.textContent = Math.abs(a) + '°';
  }
  const t0 = el('text', { x: c, y: 14, 'font-size': 11, 'text-anchor': 'middle', fill: 'rgba(20,20,19,0.7)' }, svg);
  t0.textContent = '0°';

  let dots = '';
  const stride = Math.max(1, Math.floor(speeds.length / 3000));
  for (let i = 0; i < series.sog.length; i += stride) {
    if (series.sog[i] === null || series.twa[i] === null || series.sog[i] < 1) continue;
    const [x, y] = pos(series.twa[i], series.sog[i]);
    dots += 'M' + x.toFixed(1) + ' ' + y.toFixed(1) + 'h0';
  }
  el('path', { d: dots, stroke: 'rgba(20,20,19,0.3)', 'stroke-width': 3, 'stroke-linecap': 'round', fill: 'none' }, svg);

  for (const [key, color, width, dash] of [['p90', '#a86a00', 1.5, '4 3'], ['mean', '#1f5f7a', 3, '']]) {
    for (const side of [1, -1]) {
      const pts = bins
        .filter((b) => Math.sign(b.twa) === side)
        .map((b) => pos(b.twa, b[key]).map((v) => v.toFixed(1)).join(','))
        .join(' ');
      if (pts) el('polyline', { points: pts, fill: 'none', stroke: color, 'stroke-width': width, 'stroke-dasharray': dash, 'stroke-linejoin': 'round' }, svg);
    }
  }

  const marker = el('circle', { r: 7, fill: '#f0eee6', stroke: '#141413', 'stroke-width': 3, visibility: 'hidden' }, svg);
  holder.append(svg);
  return (i) => {
    if (series.twa[i] === null || series.sog[i] === null) return marker.setAttribute('visibility', 'hidden');
    const [x, y] = pos(series.twa[i], series.sog[i]);
    marker.setAttribute('cx', x);
    marker.setAttribute('cy', y);
    marker.setAttribute('visibility', 'visible');
  };
}

// ---------- Page ----------

function render(data) {
  const { session, meta, series, stats, manoeuvres, polar, debrief } = data;
  const n = meta.n;
  const t0 = naiveDate(meta.t0).getTime();
  const end = new Date(t0 + meta.duration_s * 1000);

  const name = session.name || 'Session ' + session.id;
  $('title').textContent = name;
  document.title = 'Abraxas – ' + name;
  $('subtitle').textContent = fmtDate(new Date(t0)) + ', ' + fmtClock(t0).slice(0, 5) + ' à ' + fmtClock(end.getTime()).slice(0, 5) + ' (' + fmtDuration(meta.duration_s) + ')';

  for (const w of meta.warnings) {
    const p = document.createElement('p');
    p.className = 'notice';
    p.textContent = w;
    $('warnings').append(p);
  }

  renderCards(stats, meta);
  renderDebrief(debrief);
  renderManoeuvres(manoeuvres);
  const movePolar = renderPolar(series, polar);

  const xs = Array.from({ length: n }, (_, i) => i);
  let cursor = 0;
  const plots = [];
  let pending = false;

  function redraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      for (const u of plots) u.redraw(false);
    });
  }

  const latFill = fillForward(series.lat);
  const lonFill = fillForward(series.lon);
  const hasTrack = meta.has_gps && latFill[0] !== null;
  let marker = null;
  if (hasTrack) {
    const map = L.map('map');
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    const points = [];
    for (let i = 0; i < n; i++) if (series.lat[i] !== null && series.lon[i] !== null) points.push([series.lat[i], series.lon[i]]);
    L.polyline(points, { color: '#1f5f7a', weight: 3 }).addTo(map);
    map.fitBounds(points, { padding: [20, 20] });
    marker = L.circleMarker([latFill[0], lonFill[0]], { radius: 8, color: '#141413', weight: 3, fillColor: '#f0eee6', fillOpacity: 1 }).addTo(map);
  } else {
    $('map').textContent = 'Pas de données GPS pour cette session.';
    $('map').style.padding = '16px';
  }

  for (const c of CHARTS) {
    const figure = document.createElement('figure');
    const caption = document.createElement('figcaption');
    caption.textContent = c.title;
    figure.append(caption);
    $('charts').append(figure);
    if (!series[c.key].some((v) => v !== null)) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Pas de données.';
      figure.append(empty);
      continue;
    }
    const holder = document.createElement('div');
    holder.className = 'chart';
    figure.append(holder);
    plots.push(makeChart(holder, c, xs, series[c.key], manoeuvres, () => cursor, (t) => seek(t)));
  }

  const slider = $('slider');
  slider.max = n - 1;

  seek = (t) => {
    cursor = Math.max(0, Math.min(n - 1, Math.round(t)));
    slider.value = cursor;
    $('clock').textContent = fmtClock(t0 + cursor * 1000);
    $('elapsed').textContent = fmtElapsed(cursor);
    for (const key in READOUT) $('r-' + key).textContent = fmt(series[key][cursor], READOUT[key]);
    if (marker) {
      marker.setLatLng([latFill[cursor], lonFill[cursor]]);
      $('position').textContent = fmt(latFill[cursor], 5) + ', ' + fmt(lonFill[cursor], 5);
    }
    movePolar(cursor);
    redraw();
  };
  slider.addEventListener('input', () => seek(Number(slider.value)));
  seek(0);
}

function fillForward(values) {
  const first = values.find((v) => v !== null);
  let last = null;
  return values.map((v) => {
    if (v !== null) last = v;
    return last === null ? (first === undefined ? null : first) : last;
  });
}

function makeChart(holder, c, xs, ys, manoeuvres, getCursor, setTime) {
  const stroke = '#141413';
  const grid = 'rgba(20,20,19,0.1)';
  const opts = {
    width: holder.clientWidth || 300,
    height: 150,
    legend: { show: false },
    cursor: { show: false },
    scales: {
      x: { time: false },
      y: c.zero ? { range: (u, min, max) => [Math.min(min, 0), Math.max(max, 0)] } : {},
    },
    axes: [
      {
        stroke,
        grid: { stroke: grid },
        splits: (u, i, min, max) => {
          const steps = [10, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
          const step = steps.find((s) => (max - min) / s <= 6) || 7200;
          const out = [];
          for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
          return out;
        },
        values: (u, splits) => splits.map(fmtElapsed),
      },
      { stroke, grid: { stroke: grid }, size: 46 },
    ],
    series: [{}, { stroke: c.color, width: 1.8, spanGaps: false, points: { show: false } }],
    hooks: {
      drawClear: [
        (u) => {
          const { top, height } = u.bbox;
          for (const m of manoeuvres) {
            const x1 = u.valToPos(m.t_start, 'x', true);
            const x2 = u.valToPos(m.t_end, 'x', true);
            u.ctx.fillStyle = BAND[m.type];
            u.ctx.fillRect(x1, top, Math.max(x2 - x1, 3), height);
          }
        },
      ],
      draw: [
        (u) => {
          const { top, height } = u.bbox;
          const x = Math.round(u.valToPos(getCursor(), 'x', true));
          u.ctx.save();
          u.ctx.strokeStyle = stroke;
          u.ctx.lineWidth = 2;
          u.ctx.beginPath();
          u.ctx.moveTo(x, top);
          u.ctx.lineTo(x, top + height);
          u.ctx.stroke();
          u.ctx.restore();
        },
      ],
    },
  };

  const u = new uPlot(opts, [xs, ys], holder);
  new ResizeObserver(() => u.setSize({ width: holder.clientWidth, height: 150 })).observe(holder);

  let dragging = false;
  const jump = (e) => setTime(u.posToVal(e.clientX - u.over.getBoundingClientRect().left, 'x'));
  u.over.style.touchAction = 'pan-y';
  u.over.addEventListener('pointerdown', (e) => {
    dragging = true;
    u.over.setPointerCapture(e.pointerId);
    jump(e);
  });
  u.over.addEventListener('pointermove', (e) => {
    if (dragging) jump(e);
  });
  u.over.addEventListener('pointerup', () => (dragging = false));
  u.over.addEventListener('pointercancel', () => (dragging = false));
  return u;
}

function renderManoeuvres(list) {
  const box = $('manoeuvres');
  if (list.length === 0) {
    box.textContent = 'Aucune manœuvre détectée (il faut le GPS et l’anémomètre).';
    return;
  }
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  for (const h of ['Début', 'Type', 'Avant', 'Mini', 'Conservée', 'Repart en']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.append(th);
  }
  const body = table.createTBody();
  for (const m of list) {
    const tr = body.insertRow();
    const cells = [fmtElapsed(m.t_start), m.type === 'tack' ? 'Virement' : 'Empannage', fmt(m.v_in, 1) + ' kn', fmt(m.v_min, 1) + ' kn', fmt(m.retention * 100, 0) + ' %', m.recover_s === null ? '–' : m.recover_s + ' s'];
    for (const text of cells) tr.insertCell().textContent = text;
    tr.addEventListener('click', () => seek(m.t_cross));
  }
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  wrap.append(table);
  box.append(wrap);
}

main();
