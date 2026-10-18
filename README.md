# Serveur distant Abraxas

Serveur Node.js (sans dépendance à installer) qui reçoit la base du Raspberry depuis le téléphone, analyse les sessions et affiche un dashboard.

- `/` : liste des sessions
- `/upload` : import de la base téléchargée depuis le Raspberry
- `/session?id=N` : dashboard d'une session (statistiques, graphiques, carte, curseur de temps)

## Déploiement sur Infomaniak

Dans l'onglet Node.js du site :

- Dossier de l'application : `distant_server` (là où se trouve `package.json`)
- Commande de démarrage : `node server.js`
- Version de Node.js : 25 (22.13 minimum, à cause du module `node:sqlite`)
- Variable d'environnement `UPLOAD_CODE` : le code demandé sur la page d'import (sans lui, l'import est désactivé)
- Pour les débriefs IA : `ANTHROPIC_API_KEY` (clé de l'API Anthropic, console.anthropic.com) et, si tu veux changer de modèle, `ANTHROPIC_MODEL` (`claude-sonnet-5-5` par défaut)
- Facultatif : `DATA_DIR` (dossier de la base et des fichiers reçus, `./data` par défaut) et `MAX_UPLOAD_MB` (200 par défaut)

Sans `ANTHROPIC_API_KEY`, tout fonctionne sauf les débriefs. Ils sont générés automatiquement à l'import d'une session (nouvelle ou modifiée) et peuvent être régénérés depuis le dashboard. Chaque génération est un appel payant à l'API : il faut un compte Anthropic avec du crédit.

Renommer et supprimer une session demandent le même code que l'import (`UPLOAD_CODE`). Une session supprimée revient si tu réimportes une base qui la contient encore.

Le port est lu dans la variable `PORT` fournie par le Manager. Après un changement de réglages, redémarre l'application.

Le dossier `data/` contient la base du serveur et tous les fichiers reçus : il ne doit pas être écrasé lors d'une mise à jour du code.

## Essai en local

```
node scripts/make_demo_db.js demo.db
UPLOAD_CODE=test PORT=8080 node server.js
```

Puis ouvre http://localhost:8080/upload et envoie `demo.db`.

## Réglages de l'analyse

Les seuils (près/portant, détection des manœuvres, lissage, formules pitch/roll) sont regroupés dans `CONFIG` au début de `lib/analysis.js`.
