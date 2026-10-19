// Génère une base de démonstration au format du Raspberry (sys.db), sans matériel.
//   node scripts/make_demo_db.js [fichier.db] [--nominal]
// Par défaut, l'IMU est enregistré dans l'ordre (mag, accel, gyro) comme le fait db_recording.py
// actuellement ; avec --nominal, dans l'ordre des colonnes (accel, gyro, mag).
// Session 1 : 24 min de navigation avec 4 virements et 3 empannages. Session 2 : IMU seul, 30 s.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

const [, , outArg, ...flags] = process.argv;
const outFile = outArg && !outArg.startsWith('--') ? outArg : 'demo.db';
const nominal = flags.includes('--nominal') || outArg === '--nominal';

fs.rmSync(outFile, { force: true });
const db = new DatabaseSync(outFile);
db.exec(`
CREATE TABLE imu_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME NOT NULL,
  accel_x REAL NOT NULL, accel_y REAL NOT NULL, accel_z REAL NOT NULL,
  gyro_x REAL NOT NULL, gyro_y REAL NOT NULL, gyro_z REAL NOT NULL,
  mag_x REAL NOT NULL, mag_y REAL NOT NULL, mag_z REAL NOT NULL, session_id INTAGER NOT NULL);
CREATE TABLE gps_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME NOT NULL,
  lat REAL NOT NULL, lon REAL NOT NULL, p_lat VARCHAR NOT NULL, p_lon VARCHAR NOT NULL,
  fix_qual REAL, n_satellites INTAGER, alt REAL, alt_geoid REAL,
  sog_kn REAL NOT NULL, sog_kmh REAL, cog REAL NOT NULL, dilution REAL, session_id INTAGER NOT NULL);
CREATE TABLE anemo_data (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME NOT NULL,
  awa INTEGER NOT NULL, aws REAL NOT NULL, session_id INTAGER NOT NULL);
CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, start DATETIME NOT NULL, stop DATETIME, name VARCHAR);
`);

// Générateur pseudo-aléatoire reproductible
let seed = 12345;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = (a) => (rand() * 2 - 1) * a;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;

const startMs = Date.parse('2026-10-17T14:02:11Z'); // heure « naïve » du Raspberry
const iso = (ms) => {
  const d = new Date(ms);
  const micro = String(Math.floor(((ms % 1000) + 1000) % 1000) * 1000 + Math.floor(rand() * 1000)).padStart(6, '0');
  return `${d.toISOString().slice(0, 19)}.${micro}`;
};

const insertSession = db.prepare('INSERT INTO sessions (start, stop, name) VALUES (?, ?, ?)');
const insGps = db.prepare(
  `INSERT INTO gps_data (timestamp, lat, lon, p_lat, p_lon, fix_qual, n_satellites, alt, alt_geoid, sog_kn, sog_kmh, cog, dilution, session_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insAnemo = db.prepare('INSERT INTO anemo_data (timestamp, awa, aws, session_id) VALUES (?, ?, ?, ?)');
const insImu = db.prepare(
  `INSERT INTO imu_data (timestamp, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, mag_x, mag_y, mag_z, session_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

// ---------- Session 1 : navigation ----------
// Convention de client.js : le vent vient de TWD ; TWA = TWD − cap ; l'angle du vent apparent
// est celui du vent « qui souffle vers » (vitesse du vent réel − vitesse du bateau).
const legs = [-45, 45, -45, 45, 150, -150, 150, -150, -45, 45];
const durations = [150, 160, 160, 150, 140, 140, 140, 120, 150, 150];
const polar = [[0, 1.2], [30, 2.6], [45, 4.6], [60, 5.6], [90, 7.0], [120, 7.0], [150, 5.8], [180, 4.8]];
const polarAt = (twa) => {
  const a = Math.min(180, Math.abs(twa));
  for (let i = 1; i < polar.length; i++) {
    if (a <= polar[i][0]) {
      const [a0, v0] = polar[i - 1];
      const [a1, v1] = polar[i];
      return v0 + ((v1 - v0) * (a - a0)) / (a1 - a0);
    }
  }
  return polar[polar.length - 1][1];
};

const lat0 = 46.29;
const lon0 = 6.2;
let x = 0; // est (m)
let y = 0; // nord (m)
let cog = 315;
let v = 4.5;
let roll = 10;

const insertSessionRows = () => {
  const stop = new Date(startMs + 1440 * 1000).toISOString().slice(0, 19);
  return insertSession.run(new Date(startMs - 3000).toISOString().slice(0, 19) + '.000000', stop, 'Entraînement de démonstration').lastInsertRowid;
};
const sid = Number(insertSessionRows());

db.exec('BEGIN');
const dt = 0.2;
let t = 0;
let legIdx = 0;
let legEnd = durations[0];
let sampleGps = 0;
let sampleAnemo = 0;
while (legIdx < legs.length) {
  const twd = 0 + 6 * Math.sin(t / 90); // vent d'environ 0° qui oscille
  const tws = 12 + 1.5 * Math.sin(t / 40);
  const targetTwa = legs[legIdx];
  const targetCog = wrap360(twd - targetTwa);
  const diff = wrap180(targetCog - cog);
  const turning = Math.abs(diff) > 6;
  cog = wrap360(cog + Math.sign(diff) * Math.min(Math.abs(diff), 11 * dt));

  const twa = wrap180(twd - cog);
  const isTack = Math.abs(targetTwa) < 90;
  let vTarget = polarAt(twa) * (tws / 12) ** 0.8;
  if (turning) vTarget = Math.max(vTarget, polarAt(45) * 0.55) * (isTack ? 1 : 0.82);
  v += ((vTarget - v) / (turning ? 4 : 6)) * dt * (vTarget > v ? 1 : 1.6);

  const ms = v * 0.514444;
  x += ms * Math.sin(cog * D2R) * dt;
  y += ms * Math.cos(cog * D2R) * dt;

  const rollTarget = -Math.sign(twa || 1) * (4 + 10 * Math.sin(Math.abs(twa) * D2R) * (tws / 12));
  roll += (rollTarget - roll) * 0.25 * dt * 5;

  const now = startMs + Math.round(t * 1000);

  // Anémomètre à 1 Hz (vitesse du vent réel − vitesse bateau, dans le repère de client.js)
  if (t >= sampleAnemo) {
    sampleAnemo += 1;
    const wx = tws * Math.cos((twd + 180) * D2R);
    const wy = tws * Math.sin((twd + 180) * D2R);
    const ax = wx - v * Math.cos(cog * D2R);
    const ay = wy - v * Math.sin(cog * D2R);
    const aws = Math.hypot(ax, ay) + noise(0.3);
    const awa = Math.round(wrap360(Math.atan2(ay, ax) * R2D - cog + noise(2)));
    insAnemo.run(iso(now), awa, Math.round(aws * 10) / 10, sid);
  }

  // GPS à 2 Hz
  if (t >= sampleGps) {
    sampleGps += 0.5;
    const lat = lat0 + (y + noise(1.5)) / 111320;
    const lon = lon0 + (x + noise(1.5)) / (111320 * Math.cos(lat0 * D2R));
    const sog = Math.max(0, v + noise(0.12));
    insGps.run(
      iso(now), lat.toFixed(6), lon.toFixed(6), `${Math.floor(lat)} degs, ${((lat % 1) * 60).toFixed(4)} mins`,
      `${Math.floor(lon)} degs, ${((lon % 1) * 60).toFixed(4)} mins`, 1, 8, 372, 48.2,
      Math.round(sog * 100) / 100, Math.round(sog * 1.852 * 100) / 100, Math.round(wrap360(cog + noise(1.5)) * 10) / 10, 1.1, sid
    );
  }

  // IMU à 5 Hz : accélération en g, formules inverses de client.js (roll = ax × 90, pitch = ay × 90 + 90)
  const axg = (roll + noise(1.5)) / 90;
  const pitchDeg = 2.5 + 1.5 * Math.sin(t / 7) + (turning ? 2 : 0) + noise(0.6);
  const ayg = (pitchDeg - 90) / 90;
  const azg = Math.sqrt(Math.max(0, 1 - axg * axg - ayg * ayg));
  const acc = [axg, ayg, azg];
  const gyro = [noise(6), noise(6), (turning ? Math.sign(diff) * 11 : 0) + noise(2)];
  const mag = [8.5 + noise(0.4), 1 + noise(0.4), 35.8 + noise(0.4)];
  const row = nominal ? [...acc, ...gyro, ...mag] : [...mag, ...acc, ...gyro];
  insImu.run(iso(now), ...row, sid);

  t += dt;
  if (t >= legEnd) {
    legIdx++;
    if (legIdx < legs.length) legEnd += durations[legIdx];
  }
}
db.exec('COMMIT');

// ---------- Session 2 : IMU seul ----------
const start2 = startMs + 2 * 3600 * 1000;
const sid2 = Number(insertSession.run(new Date(start2).toISOString().slice(0, 19) + '.000000', new Date(start2 + 35000).toISOString().slice(0, 19), null).lastInsertRowid);
db.exec('BEGIN');
for (let k = 0; k < 150; k++) {
  const ax = noise(0.03);
  const ay = -0.99 + noise(0.01);
  const acc = [ax, ay, Math.sqrt(Math.max(0, 1 - ax * ax - ay * ay))];
  const gyro = [noise(1), noise(1), noise(1)];
  const mag = [8.5 + noise(0.2), 1 + noise(0.2), 35.8 + noise(0.2)];
  insImu.run(iso(start2 + k * 200), ...(nominal ? [...acc, ...gyro, ...mag] : [...mag, ...acc, ...gyro]), sid2);
}
db.exec('COMMIT');

// ---------- Table videos ----------
// Ajoutée par le serveur d'export du Raspberry : instant où la vidéo de la session 1 a commencé.
db.exec('CREATE TABLE videos (session_id INTEGER PRIMARY KEY, start DATETIME NOT NULL)');
db.prepare('INSERT INTO videos (session_id, start) VALUES (?, ?)').run(sid, new Date(startMs + 2400).toISOString().slice(0, 23) + '000');
db.close();
console.log(`Base de démonstration écrite : ${outFile} (${nominal ? 'ordre IMU nominal' : 'ordre IMU mag/accel/gyro'})`);
