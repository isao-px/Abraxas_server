// Base de données du serveur : les sessions importées depuis le Raspberry.
// Utilise le module SQLite intégré à Node.js (node:sqlite) : aucune dépendance native à compiler.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const VIDEO_DIR = path.join(DATA_DIR, 'videos');
for (const dir of [DATA_DIR, UPLOAD_DIR, TMP_DIR, VIDEO_DIR]) fs.mkdirSync(dir, { recursive: true });

// Les envois interrompus laissent des fichiers temporaires : on repart propre à chaque démarrage.
for (const f of fs.readdirSync(TMP_DIR)) fs.rmSync(path.join(TMP_DIR, f), { force: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'abraxas.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start TEXT NOT NULL UNIQUE,      -- clé naturelle : une session = un horodatage de début
    stop TEXT,
    name TEXT,
    imported_at TEXT NOT NULL,
    source_file TEXT,
    video_start TEXT,                -- début de la vidéo selon le Raspberry (table videos de sys.db)
    video_shift REAL NOT NULL DEFAULT 0  -- réglage manuel de la synchronisation, en secondes
);

CREATE TABLE IF NOT EXISTS gps_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    lat REAL, lon REAL,
    fix_qual REAL, n_satellites INTEGER,
    alt REAL,
    sog_kn REAL, sog_kmh REAL, cog REAL,
    dilution REAL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS anemo_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    awa REAL,
    aws REAL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS imu_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    accel_x REAL, accel_y REAL, accel_z REAL,
    gyro_x REAL, gyro_y REAL, gyro_z REAL,
    mag_x REAL, mag_y REAL, mag_z REAL,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS debriefs (
    session_id INTEGER PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL,            -- pending, ready ou error
    text TEXT,
    model TEXT,
    error TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_gps_session ON gps_data (session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_anemo_session ON anemo_data (session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_imu_session ON imu_data (session_id, timestamp);
`);

// Bases créées avant l'arrivée des vidéos : on ajoute les colonnes manquantes.
const sessionCols = new Set(db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name));
if (!sessionCols.has('video_start')) db.exec('ALTER TABLE sessions ADD COLUMN video_start TEXT');
if (!sessionCols.has('video_shift')) db.exec('ALTER TABLE sessions ADD COLUMN video_shift REAL NOT NULL DEFAULT 0');
