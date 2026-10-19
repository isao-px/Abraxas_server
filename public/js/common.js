export function fmt(v, d = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  return Number(v).toLocaleString('fr-CH', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function naiveDate(iso) {
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + 'Z');
}

export function fmtClock(ms) {
  return new Date(ms).toISOString().slice(11, 19);
}

export function fmtDate(date) {
  return date.toLocaleDateString('fr-CH', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function fmtElapsed(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + sec;
  return m + ':' + sec;
}

export function fmtDuration(seconds) {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return h + ' h ' + String(m).padStart(2, '0') + ' min';
  if (m > 0) return m + ' min';
  return s + ' s';
}

export async function getJson(url, options) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Erreur ' + response.status);
  return data;
}

export function storedCode() {
  try {
    return localStorage.getItem('abraxas-code') || '';
  } catch (e) {
    return '';
  }
}

function saveCode(code) {
  try {
    if (code) localStorage.setItem('abraxas-code', code);
    else localStorage.removeItem('abraxas-code');
  } catch (e) {}
}

export function fmtSize(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return fmt(bytes / 1024 / 1024 / 1024, 2) + ' Go';
  if (bytes >= 1024 * 1024) return fmt(bytes / 1024 / 1024, 0) + ' Mo';
  return fmt(bytes / 1024, 0) + ' Ko';
}

// Envoi d'un fichier brut avec suivi de progression (fetch ne sait pas suivre l'envoi).
// Résout { status, data } ; rejette seulement si la connexion est coupée.
export function sendFile(url, file, code, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Access-Code', code);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new Error('Connexion interrompue pendant l’envoi. Réessaie.'));
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      resolve({ status: xhr.status, data });
    };
    xhr.send(file);
  });
}

export async function callWithCode(url, method, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let code = storedCode();
    if (!code) {
      code = prompt("Code d'accès") || '';
      if (!code) throw new Error('Code requis.');
    }
    const options = { method, headers: { 'X-Access-Code': code } };
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(url, options);
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      saveCode('');
      if (attempt === 0) continue;
    }
    if (!response.ok) throw new Error(data.error || 'Erreur ' + response.status);
    saveCode(code);
    return data;
  }
}
