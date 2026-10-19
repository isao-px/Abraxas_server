# Abraxas Server

Remote server for [Abraxas](https://github.com/isao-px/Abraxas), a lightweight on-board system that records inshore sailing training sessions (GPS, anemometer, IMU and video) on a Raspberry Pi.

After a session, the files exported by the Raspberry are uploaded from a phone or a computer. The server analyses each session and shows a dashboard to debrief it with the coach.

The web interface is in French.

## Features

- **Import**: upload the database exported by the Raspberry (`abraxas_….db`) and, optionally, the session videos (`session_….mp4`), in one go. Importing is idempotent: a session is identified by its start time, so uploading the same database again (or a more complete one) updates it without creating duplicates. A video can be uploaded before or after its database; it joins its session automatically.
- **Analysis**: every measurement is resampled at 1 Hz; the server computes true wind (TWS, TWA, TWD), VMG, speed statistics, heel and trim, and detects tacks and gybes with speed retention and recovery time.
- **Dashboard** (`/session?id=N`):
  - statistic cards (tap a card with an arrow to switch between mean and median);
  - video synchronised with the time cursor, with playback controls (×1 to ×8). If the video is shorter than the session, starts later, or is missing, the measurements keep playing on their own. A manual sync adjustment (±1 s) is available;
  - map of the track, time series (speed, VMG, TWS, TWD, roll, pitch) with tack and gybe bands;
  - polar plot, with each point coloured by the true wind speed measured at that moment;
  - optional AI debrief written by Claude from the session figures.

## Requirements

- Node.js 22.13 or later (the server uses the built-in `node:sqlite` module). There is nothing to install: the project has no npm dependency.
- For videos: enough disk space in the data folder, and a hosting setup that accepts large uploads (several hundred MB per video is common).

## Configuration

Everything is configured with environment variables.

| Variable | Required | Description |
|---|---|---|
| `UPLOAD_CODE_HASH` | yes, to enable uploads | Hash of the access code asked for when uploading, renaming or deleting. See below. Without it, the server is read-only. |
| `PORT` | no | Listening port (default `8080`). Most hosting providers set it for you. |
| `DATA_DIR` | no | Folder holding the server database, the received files and the videos (default `./data`). |
| `MAX_UPLOAD_MB` | no | Maximum size of an uploaded database (default `200`). |
| `MAX_VIDEO_MB` | no | Maximum size of an uploaded video (default `4096`). |
| `ANTHROPIC_API_KEY` | no | Enables the AI debriefs. Each debrief is a paid API call. |
| `ANTHROPIC_MODEL` | no | Model used for the debriefs (default `claude-sonnet-5-5`). |

### Access code

The server never stores the access code in clear text: `UPLOAD_CODE_HASH` holds a salted [scrypt](https://nodejs.org/api/crypto.html#cryptoscryptpassword-salt-keylen-options-callback) hash of it. To generate the value:

```
node scripts/hash_code.js
```

The script asks for the code twice (without echoing it) and prints a line like `scrypt:<salt>:<hash>`: copy that line into `UPLOAD_CODE_HASH`. To change the code, generate a new hash and restart the server.

The legacy `UPLOAD_CODE` variable (clear-text code) is no longer read: remove it from your configuration.

## Deployment

Any Node.js hosting works. For example, on a managed Node.js host:

- application folder: the folder containing `package.json`;
- start command: `node server.js`;
- environment variables: at least `UPLOAD_CODE_HASH`.

Restart the application after changing a setting.

The `data/` folder contains the server database, every received file and the videos: keep it out of version control and do not overwrite it when updating the code.

## Workflow with the Raspberry

1. Connect to the Abraxas Wi-Fi and open the export page of the Raspberry (port 3001).
2. Download the database and, if wanted, the videos of the sessions.
3. Open `/upload` on this server and send all the files at once.

The database exported by the Raspberry contains a `videos` table with the exact time each video started, taken from the same clock as the measurements: this is what aligns the video with the cursor. For older exports without this table, the server falls back on the creation time stored in the MP4 file (to the second), then on the session start. The ±1 s buttons on the dashboard correct any remaining offset.

Videos are matched to their session through their file name (`session_<n>_<YYYY-MM-DD>_<HH-MM-SS>.mp4`, as named by the Raspberry). A renamed video can still be attached from the session dashboard.

## Local trial

```
node scripts/make_demo_db.js demo.db
node scripts/hash_code.js test
UPLOAD_CODE_HASH='<printed value>' PORT=8080 node server.js
```

Then open http://localhost:8080/upload, enter the code `test` and send `demo.db`.

## Analysis settings

Thresholds (upwind/downwind angles, manoeuvre detection, smoothing, pitch and roll formulas) are grouped in `CONFIG` at the top of `lib/analysis.js`.

## Project layout

```
server.js            HTTP server and API (no framework)
lib/db.js            server database (node:sqlite)
lib/importer.js      import of the Raspberry database
lib/analysis.js      resampling, true wind, statistics, manoeuvres
lib/video.js         video storage, MP4 header reading, synchronisation
lib/auth.js          access-code hashing
lib/debrief.js       AI debriefs (Anthropic API)
public/              web interface
scripts/             demo database and access-code hash generators
```

## License

[MIT](LICENSE)
