import { getJson } from './common.js';

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
    notice.textContent = "L'import est désactivé : aucun code d'accès n'est configuré sur le serveur (variable UPLOAD_CODE).";
    notice.hidden = false;
    send.disabled = true;
  }
} catch (e) {}

function showResults(sessions) {
  results.textContent = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    const name = s.id ? 'Session ' + s.id : 'Session sans donnée';
    li.append(name + ' : ' + (STATUS_TEXT[s.status] || s.status) + ' ');
    if (s.id) {
      const a = document.createElement('a');
      a.href = '/session?id=' + s.id;
      a.textContent = 'Ouvrir';
      li.append(a);
    }
    results.append(li);
  }
}

function fail(message) {
  status.textContent = message;
  send.disabled = false;
  progress.hidden = true;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = fileInput.files[0];
  if (!file) return;
  const code = codeInput.value;

  send.disabled = true;
  results.textContent = '';
  status.textContent = 'Vérification du code…';
  try {
    await getJson('/api/check-code', { headers: { 'X-Access-Code': code } });
  } catch (e) {
    return fail(e.message);
  }

  try {
    if (remember.checked) localStorage.setItem('abraxas-code', code);
    else localStorage.removeItem('abraxas-code');
  } catch (e) {}

  const xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload');
  xhr.setRequestHeader('Content-Type', 'application/octet-stream');
  xhr.setRequestHeader('X-Access-Code', code);
  progress.hidden = false;
  progress.value = 0;
  status.textContent = 'Envoi en cours…';

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) progress.value = e.loaded / e.total;
  };
  xhr.onerror = () => fail('Connexion interrompue pendant l’envoi. Réessaie.');
  xhr.onload = () => {
    let data = {};
    try {
      data = JSON.parse(xhr.responseText);
    } catch (e) {}
    if (xhr.status !== 200) return fail(data.error || 'Erreur ' + xhr.status);
    status.textContent = 'Base importée.';
    progress.hidden = true;
    send.disabled = false;
    showResults(data.sessions);
  };
  xhr.send(file);
});
