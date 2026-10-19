// Serveur distant Abraxas — Node.js seul, aucune dépendance à installer.
//   /            liste des sessions
//   /upload      import de la base et des vidéos envoyées depuis le téléphone
//   /session     dashboard d'une session
//
// Variables d'environnement :
//   PORT              port d'écoute (fourni par l'hébergeur)
//   UPLOAD_CODE_HASH  hash du code d'accès (node scripts/hash_code.js), obligatoire pour activer l'import
//   DATA_DIR          dossier des données (base, fichiers reçus, vidéos), ./data par défaut
//   MAX_UPLOAD_MB     taille maximale d'une base envoyée, 200 par défaut
//   MAX_VIDEO_MB      taille maximale d'une vidéo envoyée, 4096 par défaut
//   ANTHROPIC_API_KEY  clé de l'API Anthropic pour les débriefs IA (facultative)
//   ANTHROPIC_MODEL    modèle utilisé pour les débriefs, claude-sonnet-5-5 par défaut
import './lib/env.js'; // en premier : charge .env avant que les autres modules lisent leurs réglages
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import { db, UPLOAD_DIR, TMP_DIR } from './lib/db.js';
import { parseCodeHash, codeMatches } from './lib/auth.js';
import { videoKey, keyFromFileName, videoPath, videoFileFor, isMp4File, videoInfo } from './lib/video.js';
import { importDatabase, ImportError } from './lib/importer.js';
import { getAnalysis, invalidateAnalyses } from './lib/analysis.js';
import { getDebrief, queueDebrief, debriefEnabled, resumeDebriefs } from './lib/debrief.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT) || 8080;
const CODE_HASH = parseCodeHash(process.env.UPLOAD_CODE_HASH);
const MAX_UPLOAD_BYTES = (Number(process.env.MAX_UPLOAD_MB) || 200) * 1024 * 1024;
const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);
const MAX_VIDEO_BYTES = (Number(process.env.MAX_VIDEO_MB) || 4096) * 1024 * 1024;
const MAX_VIDEO_MB = Math.round(MAX_VIDEO_BYTES / 1024 / 1024);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
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

// Renvoie true si le code est valide ; sinon répond lui-même et renvoie false.
async function checkCode(req, res) {
  if (!CODE_HASH) {
    reject(req, res, 503, "Import désactivé : la variable UPLOAD_CODE_HASH n'est pas ou mal définie sur le serveur.");
    return false;
  }
  if (!(await codeMatches(String(req.headers['x-access-code'] || ''), CODE_HASH))) {
    await new Promise((resolve) => setTimeout(resolve, 1000)); // freine les essais répétés
    reject(req, res, 401, "Code d'accès incorrect.");
    return false;
  }
  return true;
}

// Copie le corps de la requête dans un fichier temporaire, en coupant au-delà de maxBytes.
async function receiveBody(req, tmp, maxBytes) {
  const hash = crypto.createHash('sha256');
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) return cb(Object.assign(new Error('too large'), { code: 'TOO_LARGE' }));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  await pipeline(req, limiter, fs.createWriteStream(tmp));
  if (size === 0) throw new ImportError('Fichier vide.');
  return { size, hash };
}

async function handleUpload(req, res) {
  if (!(await checkCode(req, res))) return;

  const declared = Number(req.headers['content-length']);
  if (declared > MAX_UPLOAD_BYTES) return reject(req, res, 413, `Fichier trop volumineux (maximum ${MAX_UPLOAD_MB} Mo).`);

  const tmp = path.join(TMP_DIR, `${Date.now()}_${crypto.randomUUID()}.db`);
  let stored = null;
  try {
    const { size, hash } = await receiveBody(req, tmp, MAX_UPLOAD_BYTES);

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

const findSessionByKey = (key) =>
  db.prepare('SELECT id, start, name FROM sessions').all().find((s) => videoKey(s.start) === key) || null;

// Vidéo d'une session. La session est désignée par ?session=<id> (envoi depuis le dashboard)
// ou retrouvée grâce au nom donné par le Raspberry : session_<n>_<AAAA-MM-JJ>_<HH-MM-SS>.mp4.
// Si la base n'a pas encore été importée, la vidéo est gardée et rejoindra sa session à l'import.
async function handleVideoUpload(req, res, url) {
  if (!(await checkCode(req, res))) return;

  let fileName = '';
  try {
    fileName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
  } catch (e) {}
  let key;
  let session = null;
  const forced = url.searchParams.get('session');
  if (forced) {
    session = db.prepare('SELECT id, start, name FROM sessions WHERE id = ?').get(Number(forced)) || null;
    if (!session) return reject(req, res, 404, 'Session introuvable.');
    key = videoKey(session.start);
    if (!key) return reject(req, res, 400, 'Début de session illisible.');
  } else {
    key = keyFromFileName(fileName);
    if (!key) {
      return reject(
        req,
        res,
        400,
        `Nom de vidéo non reconnu (« ${fileName || 'sans nom'} ») : il doit être au format session_3_2026-10-17_14-02-08.mp4. Sinon, la vidéo peut être ajoutée depuis le dashboard de la session.`
      );
    }
    session = findSessionByKey(key);
  }

  const declared = Number(req.headers['content-length']);
  if (declared > MAX_VIDEO_BYTES) return reject(req, res, 413, `Vidéo trop volumineuse (maximum ${MAX_VIDEO_MB} Mo).`);

  const tmp = path.join(TMP_DIR, `${Date.now()}_${crypto.randomUUID()}.mp4`);
  try {
    const { size } = await receiveBody(req, tmp, MAX_VIDEO_BYTES);
    if (!isMp4File(tmp)) throw new ImportError("Ce fichier n'est pas une vidéo MP4.");
    fs.renameSync(tmp, videoPath(key));
    sendJson(req, res, 200, { ok: true, file: fileName, size, session: session && { id: session.id, start: session.start, name: session.name } });
  } catch (e) {
    if (res.headersSent || res.destroyed) return;
    if (e.code === 'TOO_LARGE') return reject(req, res, 413, `Vidéo trop volumineuse (maximum ${MAX_VIDEO_MB} Mo).`);
    if (e instanceof ImportError) return sendJson(req, res, 400, { error: e.message });
    console.error("Erreur pendant l'envoi de la vidéo :", e);
    sendJson(req, res, 500, { error: "Erreur du serveur pendant l'envoi de la vidéo." });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Envoi de la vidéo avec les requêtes partielles (Range) : indispensable pour se déplacer dans la vidéo.
function sendVideo(req, res, file) {
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return sendJson(req, res, 404, { error: 'Aucune vidéo pour cette session.' });
    const headers = { 'Content-Type': MIME['.mp4'], 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, stat.size - Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  });
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
  const rows = db
    .prepare(
      `SELECT s.id, s.start, s.stop, s.name, s.imported_at,
              (SELECT COUNT(*) FROM gps_data WHERE session_id = s.id) AS n_gps,
              (SELECT COUNT(*) FROM anemo_data WHERE session_id = s.id) AS n_anemo,
              (SELECT COUNT(*) FROM imu_data WHERE session_id = s.id) AS n_imu,
              (SELECT MAX(timestamp) FROM imu_data WHERE session_id = s.id) AS last_ts
       FROM sessions s ORDER BY s.start DESC`
    )
    .all();
  return rows.map((r) => ({ ...r, has_video: Boolean(videoFileFor(r.start)) }));
}

// ---------- Routage ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const isRead = req.method === 'GET' || req.method === 'HEAD';

    if (pathname === '/api/config' && isRead) {
      return sendJson(req, res, 200, { uploadEnabled: Boolean(CODE_HASH), maxUploadMb: MAX_UPLOAD_MB, maxVideoMb: MAX_VIDEO_MB, debriefEnabled: debriefEnabled() });
    }
    if (pathname === '/api/check-code' && isRead) {
      if (await checkCode(req, res)) sendJson(req, res, 200, { ok: true });
      return;
    }
    if (pathname === '/api/upload' && req.method === 'POST') return await handleUpload(req, res);
    if (pathname === '/api/videos' && req.method === 'POST') return await handleVideoUpload(req, res, url);
    if (pathname === '/api/sessions' && isRead) return sendJson(req, res, 200, listSessions());

    const videoMatch = pathname.match(/^\/api\/sessions\/(\d+)\/video$/);
    if (videoMatch && (isRead || req.method === 'DELETE')) {
      if (req.method === 'DELETE' && !(await checkCode(req, res))) return;
      const session = db.prepare('SELECT id, start FROM sessions WHERE id = ?').get(Number(videoMatch[1]));
      const file = session && videoFileFor(session.start);
      if (!file) return sendJson(req, res, 404, { error: 'Aucune vidéo pour cette session.' });
      if (isRead) return sendVideo(req, res, file);
      fs.rmSync(file, { force: true });
      return sendJson(req, res, 200, { ok: true });
    }

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
        if (!debriefEnabled()) return sendJson(req, res, 503, { error: "Débrief IA désactivé" });
        queueDebrief(id);
        return sendJson(req, res, 202, debrief());
      }
      if (!match[2] && isRead) {
        const analysis = getAnalysis(db, id);
        if (!analysis) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        const row = db.prepare('SELECT id, start, video_start, video_shift FROM sessions WHERE id = ?').get(id);
        return sendJson(req, res, 200, { ...analysis, debrief: debrief(), video: videoInfo(row, analysis.meta.t0_ms) });
      }
      if (!match[2] && req.method === 'PATCH') {
        if (!(await checkCode(req, res))) return;
        let body;
        try {
          body = await readJson(req);
        } catch (e) {
          return sendJson(req, res, 400, { error: e.message });
        }
        if (!exists()) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        const out = { ok: true };
        if ('name' in body) {
          if (typeof body.name !== 'string') return sendJson(req, res, 400, { error: 'Nom invalide.' });
          out.name = body.name.trim().slice(0, 80) || null;
        }
        // Réglage manuel de la synchronisation vidéo, en secondes ajoutées au temps de la vidéo.
        if ('video_shift' in body) {
          const shift = typeof body.video_shift === 'number' ? body.video_shift : NaN;
          if (!Number.isFinite(shift) || Math.abs(shift) > 3600) return sendJson(req, res, 400, { error: 'Décalage vidéo invalide.' });
          out.video_shift = Math.round(shift * 10) / 10;
        }
        if (!('name' in out) && !('video_shift' in out)) return sendJson(req, res, 400, { error: 'Rien à modifier.' });
        if ('name' in out) db.prepare('UPDATE sessions SET name = ? WHERE id = ?').run(out.name, id);
        if ('video_shift' in out) db.prepare('UPDATE sessions SET video_shift = ? WHERE id = ?').run(out.video_shift, id);
        invalidateAnalyses();
        return sendJson(req, res, 200, out);
      }
      if (!match[2] && req.method === 'DELETE') {
        if (!(await checkCode(req, res))) return;
        const row = db.prepare('SELECT start FROM sessions WHERE id = ?').get(id);
        const r = db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
        if (!r.changes) return sendJson(req, res, 404, { error: 'Session introuvable.' });
        const video = videoFileFor(row.start);
        if (video) fs.rmSync(video, { force: true });
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
  if (!CODE_HASH) {
    console.warn(
      process.env.UPLOAD_CODE_HASH
        ? "UPLOAD_CODE_HASH est mal formé (attendu : scrypt:<sel>:<hash>, voir scripts/hash_code.js) : l'import est désactivé."
        : "UPLOAD_CODE_HASH n'est pas défini : l'import est désactivé."
    );
  }
  if (process.env.UPLOAD_CODE) console.warn("UPLOAD_CODE_HASH indéfini. UPLOAD_CODE est obsolète");
});
