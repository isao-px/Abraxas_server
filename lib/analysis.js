// Analyse d'une session : rééchantillonnage à 1 Hz, vent réel, VMG, statistiques et manœuvres.
//
// Les formules du vent réel, de la VMG, du pitch et du roll reprennent celles de
// server/client.js (dashboard du Raspberry), pour que les valeurs affichées ici
// soient cohérentes avec ce que le bateau affichait en direct.
// Tous les réglages sont regroupés dans CONFIG.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const CONFIG = {
  GAP_FILL_S: 4, // trous de mesure comblés par interpolation jusqu'à cette durée
  SMOOTH_HALF_S: 2, // lissage des maximums : moyenne glissante sur 2 × 2 + 1 = 5 s
  SMOOTH_MANOEUVRE_HALF_S: 1, // lissage de la vitesse pendant les manœuvres (3 s)
  MAX_SANE_KN: 40, // au-delà, la vitesse GPS est considérée comme aberrante
  MIN_MOVING_KN: 1, // en dessous, le bateau est considéré à l'arrêt (hors statistiques)
  MIN_DISTANCE_KN: 0.5, // vitesse sous laquelle on ne compte pas de distance (bruit GPS)
  UPWIND_MAX_TWA: 75, // « près » : angle au vent réel ≤ 75°
  DOWNWIND_MIN_TWA: 105, // « portant » : angle au vent réel ≥ 105°
  // Conversion accéléromètre (en g) → angle, identique à client.js :
  //   roll = accel_x × 90        pitch = accel_y × 90 + 90
  PITCH_SCALE: 90,
  PITCH_OFFSET: 90,
  ROLL_SCALE: 90,
  MANOEUVRE: {
    MIN_OFFAXIS_DEG: 20, // le bateau est « établi » à plus de 20° de l'axe du vent
    MIN_RUN_S: 8, // durée minimale d'une amure stable
    MAX_RUN_GAP_S: 3, // micro-coupures tolérées à l'intérieur d'une amure
    MAX_DURATION_S: 40, // durée maximale d'une manœuvre
    ENTRY_WINDOW_S: 5, // vitesse d'entrée : moyenne des 5 s avant la manœuvre
    AFTER_WINDOW_S: 5, // la vitesse minimale est cherchée jusqu'à 5 s après la manœuvre
    RECOVER_FRACTION: 0.9, // « reparti » = 90 % de la vitesse d'entrée retrouvée
    RECOVER_MAX_S: 40,
  },
};

// ---------- Utilitaires ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
const wrap360 = (d) => ((d % 360) + 360) % 360;
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const maxOf = (a) => (a.length ? a.reduce((m, v) => (v > m ? v : m), -Infinity) : null);
const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);
const roundAll = (arr, d) => arr.map((v) => round(v, d));

function percentile(a, p) {
  if (!a.length) return null;
  const sorted = [...a].sort((x, y) => x - y);
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
const median = (a) => percentile(a, 0.5);
function std(a) {
  const m = mean(a);
  return m === null ? null : Math.sqrt(mean(a.map((v) => (v - m) ** 2)));
}
function pearson(x, y) {
  if (x.length < 4) return null;
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : null;
}

// Les horodatages du Raspberry sont « naïfs » (heure locale sans fuseau) : on les lit comme du UTC
// pour ne manipuler que des durées. L'heure affichée est donc l'heure murale du Raspberry.
function parseTimestamp(s) {
  const str = String(s).trim().replace(' ', 'T');
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(str);
  return Date.parse(hasZone ? str : `${str}Z`);
}

// Moyenne par tranche d'une seconde (tranche k = instants de k − 0,5 s à k + 0,5 s).
function binMeans(relT, columns, n) {
  const sums = columns.map(() => new Float64Array(n));
  const counts = columns.map(() => new Uint32Array(n));
  for (let i = 0; i < relT.length; i++) {
    const k = Math.round(relT[i]);
    if (k < 0 || k >= n) continue;
    for (let c = 0; c < columns.length; c++) {
      const v = columns[c][i];
      if (isNum(v)) {
        sums[c][k] += v;
        counts[c][k]++;
      }
    }
  }
  return columns.map((_, c) => Array.from(sums[c], (s, k) => (counts[c][k] ? s / counts[c][k] : null)));
}

function fillGaps(a, maxGap) {
  const out = a.slice();
  const n = out.length;
  let i = 0;
  while (i < n) {
    if (out[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && out[j] === null) j++;
    const len = j - i;
    if (i > 0 && j < n && len <= maxGap) {
      const a0 = out[i - 1];
      const a1 = out[j];
      for (let k = i; k < j; k++) out[k] = a0 + ((a1 - a0) * (k - i + 1)) / (len + 1);
    }
    i = j;
  }
  return out;
}

function valueSeries(relT, values, n) {
  return fillGaps(binMeans(relT, [values], n)[0], CONFIG.GAP_FILL_S);
}

// Angles : on moyenne les sinus et cosinus, pas les degrés (359° et 1° doivent donner 0°).
function angleSeries(relT, degrees, n) {
  const s = degrees.map((d) => (isNum(d) ? Math.sin(d * D2R) : null));
  const c = degrees.map((d) => (isNum(d) ? Math.cos(d * D2R) : null));
  const [bs, bc] = binMeans(relT, [s, c], n).map((x) => fillGaps(x, CONFIG.GAP_FILL_S));
  return bs.map((v, i) => (v === null || bc[i] === null ? null : wrap360(Math.atan2(v, bc[i]) * R2D)));
}

function movingAvg(a, half) {
  const n = a.length;
  const ps = new Float64Array(n + 1);
  const pc = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    ps[i + 1] = ps[i] + (a[i] === null ? 0 : a[i]);
    pc[i + 1] = pc[i] + (a[i] === null ? 0 : 1);
  }
  return a.map((v, i) => {
    if (v === null) return null;
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const c = pc[hi + 1] - pc[lo];
    return c ? (ps[hi + 1] - ps[lo]) / c : null;
  });
}

function movingCircMean(deg, half) {
  const s = movingAvg(deg.map((d) => (d === null ? null : Math.sin(d * D2R))), half);
  const c = movingAvg(deg.map((d) => (d === null ? null : Math.cos(d * D2R))), half);
  return s.map((v, i) => (v === null || c[i] === null ? null : wrap180(Math.atan2(v, c[i]) * R2D)));
}

// ---------- Orientation de l'IMU ----------
// Jusqu'à la correction de imu.py (dépôt Abraxas), l'IMU était enregistrée dans l'ordre
// (magnétomètre, accéléromètre, gyroscope) alors que les colonnes s'appellent accel, gyro, mag.
// Les bases déjà enregistrées gardent cet ordre : on ne se fie donc pas aux noms des colonnes.
// On repère donc l'accéléromètre : c'est le seul triplet dont la norme vaut ≈ 1 g.
const TRIPLES = ['accel', 'gyro', 'mag'];

function detectImuLayout(rows) {
  if (!rows.length) return { prefix: 'accel', detected: false, nominal: true, valid: false };
  const step = Math.max(1, Math.floor(rows.length / 1500));
  const scored = TRIPLES.map((p) => {
    const norms = [];
    for (let i = 0; i < rows.length; i += step) {
      const r = rows[i];
      const x = r[`${p}_x`];
      const y = r[`${p}_y`];
      const z = r[`${p}_z`];
      if (isNum(x) && isNum(y) && isNum(z)) norms.push(Math.hypot(x, y, z));
    }
    norms.sort((a, b) => a - b);
    const median = norms.length ? norms[norms.length >> 1] : Infinity;
    return { prefix: p, dist: Math.abs(median - 1) };
  }).sort((a, b) => a.dist - b.dist);

  if (scored[0].dist < 0.4 && scored[1].dist - scored[0].dist > 0.3) {
    return { prefix: scored[0].prefix, detected: true, nominal: scored[0].prefix === 'accel', valid: true };
  }
  // Pas de triplet clairement identifiable : on suppose l'ordre nominal, à condition qu'il soit plausible.
  const accelDist = scored.find((x) => x.prefix === 'accel').dist;
  return { prefix: 'accel', detected: false, nominal: true, valid: accelDist < 0.4 };
}

// ---------- Chargement ----------

function loadRows(db, id) {
  return {
    gps: db
      .prepare('SELECT timestamp, lat, lon, sog_kn, cog, fix_qual FROM gps_data WHERE session_id = ? ORDER BY timestamp')
      .all(id),
    anemo: db.prepare('SELECT timestamp, awa, aws FROM anemo_data WHERE session_id = ? ORDER BY timestamp').all(id),
    imu: db
      .prepare(
        `SELECT timestamp, accel_x, accel_y, accel_z, gyro_x, gyro_y, gyro_z, mag_x, mag_y, mag_z
         FROM imu_data WHERE session_id = ? ORDER BY timestamp`
      )
      .all(id),
  };
}

// ---------- Vent réel (mêmes formules que client.js) ----------
// awa et aws sont ceux de l'anémomètre, sog et cog ceux du GPS (vitesses en nœuds).
// TWA : angle d'où vient le vent par rapport à l'étrave, entre −180° et 180°.
// VMG : positive au près, négative au portant.
function trueWind(awaDeg, aws, cogDeg, sog) {
  const awa = awaDeg * D2R;
  const cog = cogDeg * D2R;
  const x = aws * Math.cos(cog + awa) + sog * Math.cos(cog);
  const y = aws * Math.sin(cog + awa) + sog * Math.sin(cog);
  const tws = Math.hypot(x, y);
  const twd = Math.atan2(y, x);
  const twa = wrap180((twd - cog) * R2D + 180);
  const vmg = sog * Math.cos(twa * D2R);
  return { tws, twa, vmg };
}

// ---------- Manœuvres ----------

function meanInRange(a, from, to) {
  const vals = [];
  for (let i = Math.max(0, from); i <= Math.min(a.length - 1, to); i++) if (a[i] !== null) vals.push(a[i]);
  return mean(vals);
}

function firstReach(a, from, to, level) {
  for (let i = from; i <= Math.min(a.length - 1, to); i++) {
    if (a[i] !== null && a[i] >= level) return i - from;
  }
  return null;
}

function meanAbsInRange(a, from, to) {
  const vals = [];
  for (let i = Math.max(0, from); i <= Math.min(a.length - 1, to); i++) if (a[i] !== null) vals.push(Math.abs(a[i]));
  return mean(vals);
}

function detectManoeuvres(twaS, sog3, roll) {
  const cfg = CONFIG.MANOEUVRE;
  const n = twaS.length;
  const minSin = Math.sin(cfg.MIN_OFFAXIS_DEG * D2R);

  const side = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    if (twaS[i] === null) continue;
    const s = Math.sin(twaS[i] * D2R);
    if (Math.abs(s) >= minSin) side[i] = s > 0 ? 1 : -1;
  }

  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (side[i] === 0) continue;
    if (cur && side[i] === cur.side && i - cur.b <= cfg.MAX_RUN_GAP_S + 1) cur.b = i;
    else {
      cur = { side: side[i], a: i, b: i };
      runs.push(cur);
    }
  }
  const solid = runs.filter((r) => r.b - r.a + 1 >= cfg.MIN_RUN_S);

  const out = [];
  for (let k = 0; k + 1 < solid.length; k++) {
    const r1 = solid[k];
    const r2 = solid[k + 1];
    if (r1.side === r2.side) continue;
    const tS = r1.b;
    const tE = r2.a;
    if (tE - tS > cfg.MAX_DURATION_S) continue;

    let cross = tS;
    let crossAbs = Infinity;
    for (let i = tS; i <= tE; i++) {
      if (twaS[i] === null) continue;
      const a = Math.abs(Math.sin(twaS[i] * D2R));
      if (a < crossAbs) {
        crossAbs = a;
        cross = i;
      }
    }
    if (twaS[cross] === null) continue;
    const type = Math.cos(twaS[cross] * D2R) > 0 ? 'tack' : 'gybe';

    const vIn = meanInRange(sog3, tS - cfg.ENTRY_WINDOW_S, tS);
    if (vIn === null || vIn < CONFIG.MIN_MOVING_KN) continue;

    let vMin = Infinity;
    for (let i = tS; i <= Math.min(n - 1, tE + cfg.AFTER_WINDOW_S); i++) {
      if (sog3[i] !== null && sog3[i] < vMin) vMin = sog3[i];
    }
    if (!Number.isFinite(vMin)) continue;

    out.push({
      type,
      t_start: tS,
      t_end: tE,
      t_cross: cross,
      v_in: round(vIn, 2),
      v_min: round(vMin, 2),
      loss: round(vIn - vMin, 2),
      retention: round(Math.min(1, vMin / vIn), 3),
      recover_s: firstReach(sog3, tE, tE + cfg.RECOVER_MAX_S, cfg.RECOVER_FRACTION * vIn),
      recover95_s: firstReach(sog3, tE, tE + 60, 0.95 * vIn),
      recover_full_s: firstReach(sog3, tE, tE + 60, vIn),
      v_after5: round(sog3[tE + 5] ?? null, 2),
      twa_before: round(meanAbsInRange(twaS, tS - 8, tS), 0),
      twa_after: round(meanAbsInRange(twaS, tE, tE + 8), 0),
      roll_before: round(meanAbsInRange(roll, tS - 10, tS), 1),
    });
  }
  return out;
}

function summariseManoeuvres(list) {
  const rec = list.map((m) => m.recover_s).filter((v) => v !== null);
  const best = list.reduce((b, m) => (!b || m.retention > b.retention ? m : b), null);
  return {
    count: list.length,
    retention_mean: round(mean(list.map((m) => m.retention)), 3),
    retention_median: round(median(list.map((m) => m.retention)), 3),
    recover_mean_s: round(mean(rec), 1),
    recover_median_s: round(median(rec), 1),
    best: best ? { retention: best.retention, t: best.t_cross } : null,
  };
}

// Courbe polaire : vitesse par tranche d'angle au vent (signé, ou en valeur absolue).
export function binPolar(twa, sog, { width = 10, signed = true, from = 0, to = 180 } = {}) {
  const lo = signed ? -180 : from;
  const hi = signed ? 180 : to;
  const groups = new Map();
  for (let i = 0; i < twa.length; i++) {
    if (twa[i] === null || sog[i] === null || sog[i] < CONFIG.MIN_MOVING_KN) continue;
    const a = signed ? twa[i] : Math.abs(twa[i]);
    if (a < lo || a > hi) continue;
    const k = Math.min(Math.floor((a - lo) / width), Math.ceil((hi - lo) / width) - 1);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(sog[i]);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.length >= 5)
    .map(([k, v]) => ({
      twa: round(lo + (k + 0.5) * width, 1),
      n: v.length,
      mean: round(mean(v), 2),
      median: round(median(v), 2),
      p90: round(percentile(v, 0.9), 2),
    }));
}

export { mean, median, percentile, std, pearson, movingAvg };

// ---------- Analyse complète ----------

export function analyseSession(db, id) {
  const session = db.prepare('SELECT id, start, stop, name FROM sessions WHERE id = ?').get(id);
  if (!session) return null;

  const { gps, anemo, imu } = loadRows(db, id);
  const gpsT = gps.map((r) => parseTimestamp(r.timestamp));
  const anemoT = anemo.map((r) => parseTimestamp(r.timestamp));
  const imuT = imu.map((r) => parseTimestamp(r.timestamp));

  const all = [...gpsT, ...anemoT, ...imuT].filter(isNum);
  if (!all.length) return { session, meta: { empty: true, warnings: [] } };

  let first = Infinity;
  let last = -Infinity;
  for (const t of all) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const duration = Math.max(1, Math.ceil((last - first) / 1000));
  const n = duration + 1;
  const rel = (arr) => arr.map((t) => (t - first) / 1000);
  const warnings = [];

  // GPS
  const gpsOk = gps.map((r) => r.fix_qual !== 0 && isNum(r.lat) && isNum(r.lon) && Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180);
  const gpsRel = rel(gpsT);
  const pick = (key) => gps.map((r, i) => (gpsOk[i] ? r[key] : null));
  const sog = valueSeries(gpsRel, pick('sog_kn').map((v) => (isNum(v) && v <= CONFIG.MAX_SANE_KN ? v : null)), n);
  const cog = angleSeries(gpsRel, pick('cog'), n);
  const lat = valueSeries(gpsRel, pick('lat'), n);
  const lon = valueSeries(gpsRel, pick('lon'), n);

  // Vent apparent
  const anemoRel = rel(anemoT);
  const awa = angleSeries(anemoRel, anemo.map((r) => r.awa), n);
  const aws = valueSeries(anemoRel, anemo.map((r) => r.aws), n);

  // IMU
  const layout = detectImuLayout(imu);
  const imuRel = rel(imuT);
  const ax = valueSeries(imuRel, imu.map((r) => r[`${layout.prefix}_x`]), n);
  const ay = valueSeries(imuRel, imu.map((r) => r[`${layout.prefix}_y`]), n);
  const roll = ax.map((v) => (v === null || !layout.valid ? null : v * CONFIG.ROLL_SCALE));
  const pitch = ay.map((v) => (v === null || !layout.valid ? null : v * CONFIG.PITCH_SCALE + CONFIG.PITCH_OFFSET));

  // Vent réel
  const tws = new Array(n).fill(null);
  const twa = new Array(n).fill(null);
  const twd = new Array(n).fill(null);
  const vmg = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (sog[i] !== null && cog[i] !== null && awa[i] !== null && aws[i] !== null) {
      const w = trueWind(awa[i], aws[i], cog[i], sog[i]);
      tws[i] = w.tws;
      twa[i] = w.twa;
      twd[i] = wrap360(cog[i] + w.twa); // direction d'où vient le vent réel, par rapport au nord
      vmg[i] = w.vmg;
    }
  }

  const hasGps = sog.some((v) => v !== null);
  const hasWind = twa.some((v) => v !== null);
  const hasImu = roll.some((v) => v !== null);
  if (!hasGps) warnings.push('Aucune donnée GPS valide : vitesse, distance, carte et VMG indisponibles.');
  if (hasGps && !anemo.length) warnings.push("Aucune donnée d'anémomètre : vent réel et VMG indisponibles.");
  if (!imu.length) warnings.push('Aucune donnée de centrale inertielle : pitch et roll indisponibles.');
  if (imu.length && !layout.valid) warnings.push('Mesures de la centrale inertielle incohérentes (aucun triplet de norme ≈ 1 g) : pitch et roll indisponibles.');
  else if (hasImu && !layout.detected) warnings.push("Orientation de la centrale inertielle non vérifiée : pitch et roll à prendre avec précaution.");

  // ----- Statistiques (maximums sur valeurs lissées) -----
  const half = CONFIG.SMOOTH_HALF_S;
  const sogS = movingAvg(sog, half);
  const twaS = movingCircMean(twa, half);
  const vmgS = sogS.map((v, i) => (v === null || twaS[i] === null ? null : v * Math.cos(twaS[i] * D2R)));
  const rollS = movingAvg(roll, half);
  const pitchS = movingAvg(pitch, half);

  const moving = sog.map((v) => v !== null && v >= CONFIG.MIN_MOVING_KN);
  const statMask = hasGps ? moving : new Array(n).fill(true);

  const upIdx = [];
  const downIdx = [];
  for (let i = 0; i < n; i++) {
    if (!moving[i] || twaS[i] === null || vmgS[i] === null || vmg[i] === null) continue;
    const a = Math.abs(twaS[i]);
    if (a <= CONFIG.UPWIND_MAX_TWA) upIdx.push(i);
    else if (a >= CONFIG.DOWNWIND_MIN_TWA) downIdx.push(i);
  }

  let distanceNm = 0;
  for (let i = 0; i < n; i++) if (sog[i] !== null && sog[i] >= CONFIG.MIN_DISTANCE_KN) distanceNm += sog[i] / 3600;

  const pitchVals = pitch.filter((v, i) => v !== null && statMask[i]);
  const rollAbs = roll.filter((v, i) => v !== null && statMask[i]).map(Math.abs);
  const rollSAbs = rollS.filter((v, i) => v !== null && statMask[i]).map(Math.abs);
  const pitchSVals = pitchS.filter((v, i) => v !== null && statMask[i]);

  const manoeuvres = hasWind ? detectManoeuvres(twaS, movingAvg(sog, CONFIG.SMOOTH_MANOEUVRE_HALF_S), roll) : [];
  const tacks = manoeuvres.filter((m) => m.type === 'tack');
  const gybes = manoeuvres.filter((m) => m.type === 'gybe');
  const allRecover = manoeuvres.map((m) => m.recover_s).filter((v) => v !== null);

  const stats = {
    speed_max: round(maxOf(sogS.filter((v) => v !== null)), 2),
    duration_s: duration,
    speed_mean: round(mean(sog.filter((v, i) => v !== null && moving[i])), 2),
    speed_median: round(median(sog.filter((v, i) => v !== null && moving[i])), 2),
    distance_nm: hasGps ? round(distanceNm, 3) : null,
    distance_km: hasGps ? round(distanceNm * 1.852, 3) : null,
    vmg_up_max: round(maxOf(upIdx.map((i) => vmgS[i])), 2),
    vmg_up_mean: round(mean(upIdx.map((i) => vmg[i])), 2),
    vmg_up_median: round(median(upIdx.map((i) => vmg[i])), 2),
    vmg_down_max: round(maxOf(downIdx.map((i) => -vmgS[i])), 2),
    vmg_down_mean: round(mean(downIdx.map((i) => -vmg[i])), 2),
    vmg_down_median: round(median(downIdx.map((i) => -vmg[i])), 2),
    pitch_mean: round(mean(pitchVals), 1),
    pitch_median: round(median(pitchVals), 1),
    pitch_max: round(maxOf(pitchSVals), 1),
    roll_mean: round(mean(rollAbs), 1),
    roll_median: round(median(rollAbs), 1),
    roll_max: round(maxOf(rollSAbs), 1),
    tack: summariseManoeuvres(tacks),
    gybe: summariseManoeuvres(gybes),
    recover_mean_s: round(mean(allRecover), 1),
    recover_median_s: round(median(allRecover), 1),
  };

  return {
    session,
    meta: {
      empty: false,
      t0: new Date(first).toISOString().slice(0, 19), // heure murale du Raspberry
      t0_ms: first, // même instant, à la milliseconde (synchronisation de la vidéo)
      dt: 1,
      n,
      duration_s: duration,
      has_gps: hasGps,
      has_wind: hasWind,
      has_imu: hasImu,
      imu_layout: layout,
      warnings,
    },
    series: {
      sog: roundAll(sog, 2),
      cog: roundAll(cog, 1),
      lat: roundAll(lat, 6),
      lon: roundAll(lon, 6),
      awa: roundAll(awa.map((v) => (v === null ? null : wrap180(v))), 1),
      aws: roundAll(aws, 1),
      twa: roundAll(twa, 1),
      tws: roundAll(tws, 1),
      twd: twd.map((v) => (v === null ? null : Math.round(v) % 360)),
      vmg: roundAll(vmg, 2),
      pitch: roundAll(pitch, 1),
      roll: roundAll(roll, 1),
    },
    stats,
    manoeuvres,
    polar: binPolar(twa, sog),
  };
}

// ---------- Cache ----------
const cache = new Map();

export function getAnalysis(db, id) {
  if (cache.has(id)) return cache.get(id);
  const result = analyseSession(db, id);
  if (result) {
    cache.set(id, result);
    if (cache.size > 20) cache.delete(cache.keys().next().value);
  }
  return result;
}

export function invalidateAnalyses() {
  cache.clear();
}
