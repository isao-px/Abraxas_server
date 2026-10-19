// Vidéos des sessions.
// Une vidéo est rangée sous le nom dérivé du début de sa session (data/videos/2026-10-17T14-02-08.mp4) :
// elle peut donc arriver avant ou après la base, et retrouve sa session dès que les deux sont là.
import fs from 'node:fs';
import path from 'node:path';
import { VIDEO_DIR } from './db.js';

// « 2026-10-17T14:02:08.000000 » → « 2026-10-17T14-02-08 »
export function videoKey(start) {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(start || '').trim());
  return m ? `${m[1]}T${m[2]}-${m[3]}-${m[4]}` : null;
}

// Nom donné par le Raspberry : session_<id>_<AAAA-MM-JJ>_<HH-MM-SS>.mp4 (éventuellement « (1) » ajouté par le navigateur).
export function keyFromFileName(name) {
  const m = /(\d{4}-\d{2}-\d{2})[_T ](\d{2})[-:](\d{2})[-:](\d{2})/.exec(String(name || ''));
  return m ? `${m[1]}T${m[2]}-${m[3]}-${m[4]}` : null;
}

export function videoPath(key) {
  return path.join(VIDEO_DIR, `${key}.mp4`);
}

export function videoFileFor(start) {
  const key = videoKey(start);
  if (!key) return null;
  const file = videoPath(key);
  return fs.existsSync(file) ? file : null;
}

export function isMp4File(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    return head.toString('latin1', 4, 8) === 'ftyp';
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- Lecture de l'en-tête MP4 (boîte mvhd) ----------
// ffmpeg y écrit creation_time (seconde entière, convertie en UTC avec le fuseau du Raspberry) et la durée.

const MP4_EPOCH_OFFSET = 2082844800; // secondes entre 1904-01-01 et 1970-01-01

function readBoxes(fd, from, to, wanted) {
  const head = Buffer.alloc(16);
  let pos = from;
  while (pos + 8 <= to) {
    if (fs.readSync(fd, head, 0, 16, pos) < 8) return null;
    let size = head.readUInt32BE(0);
    const type = head.toString('latin1', 4, 8);
    let headerSize = 8;
    if (size === 1) {
      size = Number(head.readBigUInt64BE(8));
      headerSize = 16;
    } else if (size === 0) {
      size = to - pos;
    }
    if (size < headerSize) return null;
    if (type === wanted) return { start: pos + headerSize, end: Math.min(to, pos + size) };
    pos += size;
  }
  return null;
}

const infoCache = new Map();

export function readMp4Info(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (e) {
    return null;
  }
  const cached = infoCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return cached.info;

  let info = { size: stat.size, creation_ms: null, duration_s: null };
  const fd = fs.openSync(file, 'r');
  try {
    const moov = readBoxes(fd, 0, stat.size, 'moov');
    const mvhd = moov && readBoxes(fd, moov.start, moov.end, 'mvhd');
    if (mvhd) {
      const b = Buffer.alloc(32);
      fs.readSync(fd, b, 0, 32, mvhd.start);
      const version = b.readUInt8(0);
      let creation;
      let timescale;
      let duration;
      if (version === 1) {
        creation = Number(b.readBigUInt64BE(4));
        timescale = b.readUInt32BE(20);
        duration = Number(b.readBigUInt64BE(24));
      } else {
        creation = b.readUInt32BE(4);
        timescale = b.readUInt32BE(12);
        duration = b.readUInt32BE(16);
      }
      if (creation > MP4_EPOCH_OFFSET) info.creation_ms = (creation - MP4_EPOCH_OFFSET) * 1000;
      // MP4 fragmenté : la durée n'est pas dans mvhd (0), le navigateur la trouvera lui-même.
      if (timescale > 0 && duration > 0) info.duration_s = duration / timescale;
    }
  } catch (e) {
    // En-tête illisible : la vidéo reste utilisable, seule la synchronisation automatique est perdue.
  } finally {
    fs.closeSync(fd);
  }
  infoCache.set(file, { mtime: stat.mtimeMs, size: stat.size, info });
  return info;
}

// Horodatage « naïf » du Raspberry lu comme de l'UTC, comme dans analysis.js.
function parseNaive(s) {
  const str = String(s).trim().replace(' ', 'T');
  return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/i.test(str) ? str : `${str}Z`);
}

// Position de la vidéo sur la frise de l'analyse : à l'instant t (secondes depuis t0_ms),
// le dashboard affiche l'image video_time = t − offset_s + shift_s.
export function videoInfo(session, t0Ms) {
  const file = videoFileFor(session.start);
  if (!file) return null;
  const info = readMp4Info(file) || {};
  let start = null;
  let source = 'session';

  if (session.video_start && Number.isFinite(parseNaive(session.video_start))) {
    // Fichier start.txt du Raspberry : même horloge que les mesures, synchronisation précise.
    start = parseNaive(session.video_start);
    source = 'raspberry';
  } else if (info.creation_ms !== null && info.creation_ms !== undefined && Number.isFinite(t0Ms)) {
    // creation_time est en UTC alors que les mesures sont à l'heure locale du Raspberry :
    // on retire le décalage horaire, arrondi au quart d'heure (la vidéo démarre quelques secondes après la session).
    const quarter = 15 * 60 * 1000;
    const zone = Math.round((info.creation_ms - t0Ms) / quarter) * quarter;
    start = info.creation_ms - zone;
    source = 'mp4';
  } else {
    start = parseNaive(session.start);
  }

  return {
    url: `/api/sessions/${session.id}/video`,
    size: info.size ?? null,
    duration_s: info.duration_s ?? null,
    offset_s: Number.isFinite(start) && Number.isFinite(t0Ms) ? Math.round(start - t0Ms) / 1000 : 0,
    shift_s: session.video_shift || 0,
    source,
  };
}
