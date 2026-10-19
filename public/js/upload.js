import { getJson, sendFile, fmtSize } from './common.js';

const form = document.getElementById('form');
const fileInput = document.getElementById('file');
const codeInput = document.getElementById('code');
const remember = document.getElementById('remember');
const send = document.getElementById('send');
const progress = document.getElementById('progress');
const status = document.getElementById('status');
const results = document.getElementById('results');
const notice = document.getElementById('notice');

const STATUS_TEXT = {
  new: 'ajoutée',
  updated: 'mise à jour',
  unchanged: 'déjà présente',
  empty: 'vide, ignorée',
};

try {
  codeInput.value = localStorage.getItem('abraxas-code') || '';
} catch (e) {}

try {
  const config = await getJson('/api/config');
  if (!config.uploadEnabled) {
    notice.textContent = "L'import est désactivé : aucun code d'accès n'est configuré sur le serveur (variable UPLOAD_CODE_HASH).";
    notice.hidden = false;
    send.disabled = true;
  }
} catch (e) {}

const isVideo = (file) => /\.mp4$/i.test(file.name) || file.type === 'video/mp4';

function line(text, link) {
  const li = document.createElement('li');
  li.append(text + ' ');
  if (link) {
    const a = document.createElement('a');
    a.href = link;
    a.textContent = 'Ouvrir';
    li.append(a);
  }
  results.append(li);
}

function showDbResults(file, sessions) {
  for (const s of sessions) {
    const name = s.id ? 'Session ' + s.id : 'Session sans donnée';
    line(name + ' : ' + (STATUS_TEXT[s.status] || s.status) + (s.video ? ', avec vidéo' : ''), s.id ? '/session?id=' + s.id : null);
  }
}

function showVideoResult(file, data) {
  if (data.session) {
    line('Vidéo ' + file.name + ' : ajoutée à « ' + (data.session.name || 'Session ' + data.session.id) + ' ».', '/session?id=' + data.session.id);
  } else {
    line('Vidéo ' + file.name + ' : reçue, elle rejoindra sa session quand la base qui la contient sera importée.');
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  // La base d'abord : les vidéos trouvent ainsi leur session dès leur arrivée.
  const files = [...fileInput.files].sort((a, b) => isVideo(a) - isVideo(b));
  if (files.length === 0) return;
  const code = codeInput.value;

  send.disabled = true;
  results.textContent = '';
  status.textContent = 'Vérification du code…';
  try {
    await getJson('/api/check-code', { headers: { 'X-Access-Code': code } });
  } catch (e) {
    status.textContent = e.message;
    send.disabled = false;
    return;
  }

  try {
    if (remember.checked) localStorage.setItem('abraxas-code', code);
    else localStorage.removeItem('abraxas-code');
  } catch (e) {}

  progress.hidden = false;
  let failures = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const video = isVideo(file);
    const prefix = files.length > 1 ? 'Fichier ' + (i + 1) + ' sur ' + files.length + ' : ' : '';
    status.textContent = prefix + file.name + ' (' + fmtSize(file.size) + ') en cours d’envoi…';
    progress.value = 0;
    try {
      const { status: httpStatus, data } = await sendFile(video ? '/api/videos' : '/api/upload', file, code, (p) => (progress.value = p));
      if (httpStatus !== 200) {
        failures++;
        line(file.name + ' : ' + (data.error || 'erreur ' + httpStatus));
      } else if (video) {
        showVideoResult(file, data);
      } else {
        showDbResults(file, data.sessions);
      }
    } catch (e) {
      failures++;
      line(file.name + ' : ' + e.message);
    }
  }
  progress.hidden = true;
  send.disabled = false;
  if (failures === 0) status.textContent = files.length > 1 ? 'Tous les fichiers ont été importés.' : 'Fichier importé.';
  else status.textContent = failures + ' fichier' + (failures > 1 ? 's' : '') + ' en échec, voir ci-dessous.';
});
