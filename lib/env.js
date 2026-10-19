// Réglages lus dans le fichier .env à la racine du projet, pour les hébergeurs sans gestion des variables
// d'environnement. Ce module doit être importé en premier : lib/db.js lit DATA_DIR dès son chargement.
// Une variable déjà définie (et non vide) dans l'environnement garde sa valeur : le fichier ne l'écrase pas.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const KNOWN = ['UPLOAD_CODE_HASH', 'PORT', 'DATA_DIR', 'MAX_UPLOAD_MB', 'MAX_VIDEO_MB', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file)) {
  // Le BOM ajouté par certains éditeurs Windows rendrait la première variable illisible.
  const content = fs.readFileSync(file, 'utf-8').replace(/^﻿/, '');
  const values = parseEnv(content);
  const loaded = [];
  for (const [key, value] of Object.entries(values)) {
    // Une variable vide fournie par l'hébergeur ne doit pas masquer la valeur du fichier.
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      loaded.push(key);
    }
  }
  console.log(`Réglages chargés depuis .env : ${loaded.join(', ') || 'aucun'}`);

  // Erreurs fréquentes : ligne restée commentée, ou séparateur « : » au lieu de « = ».
  for (const line of content.split(/\r?\n/)) {
    const m = /^\s*#\s*([A-Z_]+)\s*=\s*\S/.exec(line) || /^\s*([A-Z_]+)\s*:/.exec(line);
    if (m && KNOWN.includes(m[1]) && !(m[1] in values)) {
      console.warn(`.env : la ligne ${m[1]} est ignorée (retire le « # » au début, et écris NOM=valeur).`);
    }
  }
}
