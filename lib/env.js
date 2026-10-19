// Réglages lus dans le fichier .env à la racine du projet, pour les hébergeurs sans gestion des variables
// d'environnement. Ce module doit être importé en premier : lib/db.js lit DATA_DIR dès son chargement.
// Une variable déjà définie dans l'environnement garde sa valeur (le fichier ne l'écrase pas).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (fs.existsSync(file)) {
  process.loadEnvFile(file);
  console.log('Réglages chargés depuis .env');
}
