import { fmtDate, fmtDuration, naiveDate, fmtClock, getJson, callWithCode } from './common.js';

const list = document.getElementById('list');
const message = document.getElementById('message');

function title(s) {
  return s.name || 'Session ' + s.id;
}

function row(s) {
  const start = naiveDate(s.start);
  const end = naiveDate(s.stop || s.last_ts || s.start);

  const link = document.createElement('a');
  link.className = 'session-row';
  link.href = '/session?id=' + s.id;

  const main = document.createElement('span');
  main.className = 'session-main';
  const name = document.createElement('strong');
  name.textContent = title(s);
  const when = document.createElement('span');
  when.textContent = fmtDate(start) + ', ' + fmtClock(start).slice(0, 5);
  main.append(name, when);

  const meta = document.createElement('span');
  meta.className = 'session-meta';
  const notes = [fmtDuration((end - start) / 1000)];
  if (s.n_gps === 0) notes.push('sans GPS');
  if (s.n_anemo === 0) notes.push('sans vent');
  if (s.has_video) notes.push('vidéo');
  meta.textContent = notes.join(' · ');

  link.append(main, meta);
  return link;
}

function button(text, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'small';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

async function act(task) {
  message.hidden = true;
  try {
    await task();
    await load();
  } catch (e) {
    message.textContent = e.message;
    message.hidden = false;
  }
}

function item(s) {
  const wrap = document.createElement('div');
  wrap.className = 'session-item';
  const actions = document.createElement('div');
  actions.className = 'session-actions';
  actions.append(
    button('Renommer', () => {
      const name = prompt('Nouveau nom (vide pour retirer le nom)', s.name || '');
      if (name === null) return;
      act(() => callWithCode('/api/sessions/' + s.id, 'PATCH', { name }));
    }),
    button('Supprimer', () => {
      if (!confirm('Supprimer « ' + title(s) + ' » ? Ses données sont effacées du serveur.')) return;
      act(() => callWithCode('/api/sessions/' + s.id, 'DELETE'));
    })
  );
  wrap.append(row(s), actions);
  return wrap;
}

async function load() {
  try {
    const sessions = await getJson('/api/sessions');
    list.textContent = '';
    if (sessions.length === 0) {
      const empty = document.createElement('p');
      empty.append('Aucune session pour le moment. ');
      const a = document.createElement('a');
      a.href = '/upload';
      a.textContent = 'Importe une base de données.';
      empty.append(a);
      list.append(empty);
    }
    for (const s of sessions) list.append(item(s));
  } catch (e) {
    list.textContent = 'Impossible de charger les sessions : ' + e.message;
  }
}

load();
