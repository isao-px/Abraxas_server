// Serveur distant Abraxas — Node.js seul, aucune dépendance à installer.
//   /            liste des sessions
//   /upload      import de la base envoyée depuis le téléphone
//   /session     dashboard d'une session
//
// Variables d'environnement :
//   PORT           port d'écoute (fourni par le Manager Infomaniak)
//   UPLOAD_CODE    code d'accès demandé pour importer une base (obligatoire pour activer l'import)
//   DATA_DIR       dossier des données (base + fichiers reçus), ./data par défaut
//   MAX_UPLOAD_MB  taille maximale d'un envoi, 200 par défaut
//   ANTHROPIC_API_KEY  clé de l'API Anthropic pour les débriefs IA (facultative)
//   ANTHROPIC_MODEL    modèle utilisé pour les débriefs, claude-sonnet-5-5 par défaut
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { db, UPLOAD_DIR, TMP_DIR } from './lib/db.js';
import { importDatabase, ImportError } from './lib/importer.js';
import { getAnalysis, invalidateAnalyses } from './lib/analysis.js';
import { getDebrief, queueDebrief, debriefEnabled, resumeDebriefs } from './lib/debrief.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;
const UPLOAD_CODE = process.env.UPLOAD_CODE || 'test';
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------- Réponses ----------

function sendJson(req, res, status, body, extraHeaders = {}) {
  let payload = Buffer.from(JSON.stringify(body));
  const headers = { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', ...extraHeaders };
  if (payload.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    payload = zlib.gzipSync(payload);
    headers['Content-Encoding'] = 'gzip';
    headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = payload.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : payload);
}

// Refus avant lecture du corps : on ferme la connexion pour ne pas recevoir le fichier inutilement.
const reject = (req, res, status, error) => sendJson(req, res, status, { error }, { Connection: 'close' });

function sendStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Accès refusé');
  if (!path.extname(file)) file += '.html'; // /upload → upload.html
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'Page introuvable');
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ---------- Import ----------

const sameSecret = (a, b) => {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
};

// Renvoie true si le code est valide ; sinon répond lui-même et renvoie false.
async function checkCode(req, res) {
  if (!UPLOAD_CODE) {
    reject(req, res, 503, "L'import est désactivé : la variable UPLOAD_CODE n'est pas définie sur le serveur.");
    return false;
  }
  if (!sameSecret(String(req.headers['x-access-code'] || ''), UPLOAD_CODE)) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // freine les essais répétés
    reject(req, res, 401, "Code d'accès incorrect.");
    return false;
  }
  return true;
}

async function handleUpload(req, res) {
  if (!(await checkCode(req, res))) return;

  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD_BYTES) return reject(req, res, 413, `Fichier trop volumineux (maximum ${MAX_UPLOAD_MB} Mo).`);

  const tmp = path.join(TMP_DIR, `${Date.now()}_${crypto.randomUUID()}.db`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) return cb(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  let stored = null;
  try {
    await pipeline(req, limiter, fs.createWriteStream(tmp));
    if (size === 0) throw new ImportError('Fichier vide.');

    // Le fichier reçu est conservé tel quel, pour pouvoir refaire l'import si l'analyse évolue.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = `${stamp}_${hash.digest('hex').slice(0, 12)}.db`;
    stored = path.join(UPLOAD_DIR, name);
    fs.renameSync(tmp, stored);

    const sessions = importDatabase(stored, name);
    invalidateAnalyses();
    if (debriefEnabled()) {
      for (const s of sessions) if (s.id && s.gps > 0 && (s.status === 'new' || s.status === 'updated')) queueDebrief(s.id);
    }
    sendJson(req, res, 200, { ok: true, file: name, size, sessions });
  } catch (e) {
    if (stored) fs.rmSync(stored, { force: true });
    if (res.headersSent || res.destroyed) return;
    if (e.code === 'TOO_LARGE') return reject(req, res, 413, `Fichier trop volumineux (maximum ${MAX_UPLOAD_MB} Mo).`);
    if (e instanceof ImportError) return sendJson(req, res, 400, { error: e.message });
    console.error("Erreur pendant l'import :", e);
    sendJson(req, res, 500, { error: "Erreur du serveur pendant l'import." });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function readJson(req, maxBytes = 4096) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ImportError('Requête trop volumineuse.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  } catch (e) {
    throw new ImportError('JSON invalide.');
  }
}

// ---------- Lecture ----------

function listSessions() {
  return db
    .prepare(
      `SELECT s.id, s.start, s.stop, s.name, s.imported_at,
              (SELECT COUNT(*) FROM gps_data WHERE session_id = s.id) AS n_gps,
              (SELECT COUNT(*) FROM anemo_data WHERE session_id = s.id) AS n_anemo,
              (SELECT COUNT(*) FROM imu_data WHERE session_id = s.id) AS n_imu,
              (SELECT MAX(timestamp) FROM imu_data WHERE session_id = s.id) AS last_ts
       FROM sessions s ORDER BY s.start DESC`
    )
    .all();
}

// ---------- Routage ----------

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/api/config' && isRead) {
      return sendJson(req, res, 200, { uploadEnabled: Boolean(UPLOAD_CODE), maxUploadMb: MAX_UPLOAD_MB, debriefEnabled: debriefEnabled() });
    }
    if (pathname === '/api/check-code' && isRead) {
      if (await checkCode(req, res)) sendJson(req, res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/upload' && req.method === 'POST') return await handleUpload(req, res);
    if (pathname === '/api/sessions' && isRead) return sendJson(req, res, 200, listSessions());

    const match = pathname.match(/^\/api\/sessions\/(\d+)(\/debrief)?$/);
    if (match) {
      const id = Number(match[1]);
      const exists = () => db.prepare('SELECT id FROM sessions WHERE id = ?').get(id);
      const debrief = () => ({ enabled: debriefEnabled(), ...getDebrief(id) });

      if (match[2] && isRead) {
        if (!exists()) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        return sendJson(req, res, 200, debrief());
      }
      if (match[2] && req.method === 'POST') {
        if (!(await checkCode(req, res))) return;
        if (!exists()) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        if (!debriefEnabled()) return sendJson(req, res, 503, { error: "Débrief IA désactivé : la variable ANTHROPIC_API_KEY n'est pas définie." });
        queueDebrief(id);
        return sendJson(req, res, 202, debrief());
      }
      if (!match[2] && isRead) {
        const analysis = getAnalysis(db, id);
        if (!analysis) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        return sendJson(req, res, 200, { ...analysis, debrief: debrief() });
      }
      if (!match[2] && req.method === 'PATCH') {
        if (!(await checkCode(req, res))) return;
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return sendJson(req, res, 400, { error: e.message });
        }
        if (typeof body.name !== 'string') return sendJson(req, res, 400, { error: 'Nom invalide.' });
        const name = body.name.trim().slice(0, 80) || null;
        const r = db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(name, id);
        if (!r.changes) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        invalidateAnalyses();
        return sendJson(req, res, 200, { ok: true, name });
      }
      if (!match[2] && req.method === 'DELETE') {
        if (!(await checkCode(req, res))) return;
        const r = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        if (!r.changes) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        invalidateAnalyses();
        return sendJson(req, res, 200, { ok: true });
      }
    }
    if (pathname.startsWith('/api/')) return sendJson(req, res, 404, { error: 'Route inconnue.' });

    if (isRead) return sendStatic(req, res, pathname);
    sendText(res, 405, 'Méthode non autorisée');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendText(res, 500, 'Erreur du serveur');
  }
});

server.listen(PORT, () => {
  console.log(`Serveur Abraxas prêt sur le port ${PORT}`);
  resumeDebriefs();
  if (!debriefEnabled()) console.warn("ANTHROPIC_API_KEY n'est pas défini : les débriefs IA sont désactivés.");
  if (!UPLOAD_CODE) console.warn("UPLOAD_CODE n'est pas défini : l'import de bases est désactivé.");
});
