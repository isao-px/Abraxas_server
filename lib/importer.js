// Import d'une base SQLite envoyée depuis le Raspberry (sys.db).
// L'import est idempotent : une session est identifiée par son horodatage de début.
// Renvoyer la même base (ou une version plus complète) met à jour sans créer de doublon.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { db } from './db.js';

export class ImportError extends Error {}

const MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

export function isSqliteFile(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    return head.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

const count = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = ?`).get(id).n;
const countSrc = (table, id) => db.prepare(`SELECT COUNT(*) AS n FROM src.${table} WHERE session_id = ?`).get(id).n;

export function importDatabase(file, sourceName) {
  if (!isSqliteFile(file)) throw new ImportError("Ce fichier n'est pas une base SQLite.");

  // Vérification de la structure (en lecture seule, sur le fichier envoyé).
  let anemoCols;
  try {
    const probe = new DatabaseSync(file, { readOnly: true });
    try {
      const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
      for (const t of ['sessions', 'gps_data', 'anemo_data', 'imu_data']) {
        if (!tables.has(t)) throw new ImportError(`Base incomplète : la table « ${t} » est absente.`);
      }
      anemoCols = probe.prepare('PRAGMA table_info(anemo_data)').all().map((c) => c.name);
    } finally {
      probe.close();
    }
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(`Base illisible : ${e.message}`);
  }

  // Anciennes bases : l'anémomètre s'appelait direct / force avant awa / aws.
  const awaCol = anemoCols.includes('awa') ? 'awa' : anemoCols.includes('direct') ? 'direct' : null;
  const awsCol = anemoCols.includes('aws') ? 'aws' : anemoCols.includes('force') ? 'force' : null;
  if (!awaCol || !awsCol) throw new ImportError('Table anemo_data : colonnes awa/aws introuvables.');

  const results = [];
  db.prepare('ATTACH DATABASE ? AS src').run(file);
  try {
    const sessions = db.prepare('SELECT id, start, stop, name FROM src.sessions ORDER BY id').all();
    db.exec('BEGIN');
    try {
      for (const s of sessions) {
        const n = {
          gps: countSrc('gps_data', s.id),
          anemo: countSrc('anemo_data', s.id),
          imu: countSrc('imu_data', s.id),
        };
        if (n.gps + n.anemo + n.imu === 0) {
          results.push({ start: s.start, status: 'empty', ...n });
          continue;
        }

        const existing = db.prepare('SELECT id FROM sessions WHERE start = ?').get(s.start);
        const now = new Date().toISOString();
        let id;
        let status;

        if (existing) {
          id = existing.id;
          const same = count('gps_data', id) === n.gps && count('anemo_data', id) === n.anemo && count('imu_data', id) === n.imu;
          db.prepare('UPDATE sessions SET stop = ?, name = COALESCE(?, name) WHERE id = ?').run(s.stop ?? null, s.name ?? null, id);
          if (same) {
            results.push({ id, start: s.start, status: 'unchanged', ...n });
            continue;
          }
          for (const t of ['gps_data', 'anemo_data', 'imu_data']) {
            db.prepare(`DELETE FROM ${t} WHERE session_id = ?`).run(id);
          }
          db.prepare('UPDATE sessions SET imported_at = ?, source_file = ? WHERE id = ?').run(now, sourceName, id);
          status = 'updated';
        } else {
          const r = db
            .prepare('INSERT INTO sessions (start, stop, name, imported_at, source_file) VALUES (?, ?, ?, ?, ?)')
            .run(s.start, s.stop ?? null, s.name ?? null, now, sourceName);
          id = Number(r.lastInsertRowid);
          status = 'new';
        }

        db.prepare(
          `INSERT INTO gps_data (timestamp, lat, lon, fix_qual, n_satellites, alt, sog_kn, sog_kmh, cog, dilution, session_id)
           SELECT timestamp, lat, lon, fix_qual, n_satellites, alt, sog_kn, sog_kmh, cog, dilution, ?
           FROM src.gps_data WHERE session_id = ? ORDER BY id`
        ).run(id, s.id);

        db.prepare(
          `INSERT INTO anemo_data (timestamp, awa, aws, session_id)
           SELECT timestamp, ${awaCol}, ${awsCol}, ? FROM src.anemo_data WHERE session_id = ? ORDER BY id`
        ).run(id, s.id);

        db.prepare(
          `INSERT INTO imu_data (timestamp, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, mag_x, mag_y, mag_z, session_id)
           SELECT timestamp, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, mag_x, mag_y, mag_z, ?
           FROM src.imu_data WHERE session_id = ? ORDER BY id`
        ).run(id, s.id);

        results.push({ id, start: s.start, status, ...n });
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e instanceof ImportError ? e : new ImportError(`Import impossible : ${e.message}`);
    }
  } finally {
    db.exec('DETACH DATABASE src');
  }
  return results;
}
