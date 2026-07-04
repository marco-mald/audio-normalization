# Media Manager

Flask-based tool to normalize a local 1080p media library for streaming direct-play (no transcoding). Produces **H.264 8-bit video + AAC 2.0 stereo audio in MKV** — the universal format that every streaming client (Jellyfin, Plex, browser, TV, phone) can hardware-decode without server-side transcoding.

## What it does

- Scans `.mkv` / `.mp4` files recursively from `MEDIA_DIR`
- Classifies each file by what's needed: already OK, audio fix, video re-encode
- Normalizes on demand or in batch: re-encodes video to H.264 CRF18 when needed, creates AAC 2.0 stereo track(s) from surround sources
- Radarr/Sonarr webhooks announce new downloads to Jellyfin immediately (normalization itself is deferred to marcobot's night optimizer)
- Reports real-time ffmpeg progress via job polling

## Dependencies

- Python 3, Flask
- `jellyfin-ffmpeg` at `/usr/lib/jellyfin-ffmpeg/` (provides `ffmpeg` + `ffprobe`)
- `mkvpropedit` (for setting default audio track without remux)
- PM2 (optional, for process management)

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `RADARR_URL` | `http://localhost:7878` | Radarr API base URL |
| `RADARR_API_KEY` | — | Rescan Radarr after a normalize modifies a file |
| `SONARR_URL` | `http://localhost:8989` | Sonarr API base URL |
| `SONARR_API_KEY` | — | Rescan Sonarr after a normalize modifies a file |
| `JELLYFIN_URL` | `http://localhost:8096` | Jellyfin API base URL |
| `JELLYFIN_API_KEY` | — | Library refresh on new downloads (webhook) and after normalize |

`MEDIA_DIR` is hardcoded to `/mnt/ADATA`. `FFPROBE`/`FFMPEG` paths are hardcoded to the jellyfin-ffmpeg binaries.

## Running

```bash
python3 app.py          # dev
pm2 start ecosystem.config.js  # production
```

Serves on `http://0.0.0.0:5000`.

---

## API Reference

All endpoints return JSON. POST bodies are `Content-Type: application/json`.

### File status values

| Status | Meaning | Action needed |
|---|---|---|
| `ok` | H.264 8-bit + AAC 2.0 default — perfect for direct play | None |
| `needs-fix` | Has AAC 2.0 but it's not the default track | Set default (fast, no remux) |
| `no-aac` | Missing AAC 2.0 stereo track | Normalize audio |
| `needs-video` | Video is not H.264 8-bit (HEVC, AV1, 10-bit, etc.) | Re-encode video + fix audio |
| `4k` | Resolution ≥ 1440p — skipped intentionally | None |
| `error` | ffprobe failed or no audio tracks found | Manual check |

### File object schema

```json
{
  "id": "42",
  "name": "Movie Title (2024) - 1080p.mkv",
  "path": "/peliculas/Movie Title (2024)",
  "filepath": "/mnt/ADATA/peliculas/Movie Title (2024)/Movie Title (2024) - 1080p.mkv",
  "status": "no-aac",
  "video": {
    "codec": "hevc",
    "pix_fmt": "yuv420p10le",
    "profile": "Main 10"
  },
  "tracks": [
    {
      "index": 1,
      "codec": "ac3",
      "channels": 6,
      "lang": "eng",
      "title": "English 5.1",
      "is_default": true
    }
  ]
}
```

---

### Scan

#### `POST /api/scan`
Starts an async library scan. Returns immediately.

```json
{ "ok": true }
// or if already running:
{ "error": "scan already running" }
```

#### `GET /api/scan_status`
Poll this after starting a scan.

```json
{
  "running": true,
  "done": false,
  "current": 47,
  "total": 312,
  "last_file": "Movie.mkv",
  "error": null
}
```

When `done: true`, the response also includes `"files": [<file object>, ...]`.

**Typical scan flow:**
```
POST /api/scan → { ok: true }
  loop: GET /api/scan_status
    until done == true → files array available
```

---

### File info

#### `GET /api/file/<fid>`
Re-probes a single file and returns its current state (updated tracks + status). Use after a normalize to see the result.

```json
{ "id": "42", "status": "ok", "tracks": [...], "video": {...}, ... }
```

---

### Normalize (audio + video)

#### `POST /api/normalize`

```json
{
  "file_id": "42",
  "surround_indices": [1, 3]
}
```

- `file_id` — required, file `id` from scan
- `surround_indices` — optional array of stream indices to convert to AAC 2.0; if omitted, auto-selects all ≥6ch tracks

**What it does:**
1. If video codec ≠ h264 or pixel format is 10-bit → re-encodes to H.264 High Profile Level 4.1 CRF18, `slow` preset, `yuv420p` (8-bit)
2. If video is already H.264 8-bit → copies video stream unchanged
3. Creates one AAC 2.0 192k track per selected surround source, with language metadata
4. Keeps all original audio tracks as copies after the AAC tracks
5. Strips subtitles, sets output as `.mkv`
6. MP4 sources are converted to MKV (original deleted after successful remux)

Returns a job ID to poll:

```json
{ "job_id": "job_42_7" }
// errors:
{ "error": "already processing this file" }  // HTTP 409 if file is busy
{ "error": "not found" }
```

---

### Jobs

#### `GET /api/job/<jid>`
Poll job progress. Call every ~800ms until `done: true`.

```json
{
  "log": [
    "Processing: Movie.mkv",
    "Video: HEVC → H.264 CRF18 (slow preset, can take 30-90 min)",
    "Running ffmpeg...",
    "frame=  842 fps= 12 q=28.0 size=  45312kB time=00:00:35.08 speed=0.504x"
  ],
  "done": false,
  "total_duration": 7243.5
}
```

- `total_duration` — source file duration in seconds; use with `time=HH:MM:SS` in log to compute % progress
- `log` — last ~40 lines of ffmpeg stderr + status messages; lines starting with `OK:` indicate success, `ERROR:` indicate failure

#### `POST /api/cancel/<jid>`
Sends SIGTERM to the running ffmpeg process. Temp files are cleaned up automatically.

```json
{ "ok": true }
```

---

### Audio track management

#### `POST /api/set_default`
Sets a specific audio track as default using `mkvpropedit` (no remux, instant).

```json
{ "file_id": "42", "track_index": 3 }
```

Returns `{ "ok": true }` or `{ "ok": false, "error": "..." }`.
Only works on MKV files.

#### `POST /api/delete_track`
Remuxes the file omitting one audio track. Async — returns a job ID to poll like normalize.

```json
{ "file_id": "42", "track_index": 2 }
```

Returns `{ "job_id": "del_42_2_5" }` or an error. Streams ffmpeg progress, same polling pattern as normalize.

---

### System info

#### `GET /api/sysinfo`
CPU load and active job count. Reads `/proc/stat` diff between calls.

```json
{
  "cpu": 73.4,
  "active_jobs": 2,
  "cores": 8
}
```

- `cpu` — percentage 0–100 since last call (call every ~1s for meaningful readings)
- `active_jobs` — number of in-progress normalize/delete jobs in this process

---

### Webhooks (announce new downloads to Jellyfin)

#### `POST /api/webhook/radarr`
Radarr sends this on `Download` events. Classifies the file (logged) and triggers an immediate Jellyfin library refresh for its folder so the media shows up — and availability notifications fire — right away. It does NOT normalize inline anymore: encodes took 30-90 min and blocked the refresh; the night optimizer (marcobot, 01:00-08:00) drains the backlog instead.

Expected Radarr payload structure (standard Radarr webhook body):
```json
{
  "eventType": "Download",
  "movieFile": { "path": "/data/peliculas/Movie/Movie.mkv" }
}
```

Paths starting with `/data/` are mapped to `MEDIA_DIR`.

#### `POST /api/webhook/sonarr`
Same but for Sonarr. Expects:
```json
{
  "eventType": "Download",
  "episodeFile": { "path": "/data/series/Show/S01E01.mkv" }
}
```

When a normalize job (manual or night optimizer) finishes, it still triggers a Radarr/Sonarr rescan and Jellyfin library refresh for the modified file.

---

## MCP usage pattern

```
1. POST /api/scan
2. Poll GET /api/scan_status until done == true → get files[]
3. Filter files where status != "ok" and status != "4k"
4. For each file needing work:
   POST /api/normalize { file_id, surround_indices (optional) }
   → get job_id
   Poll GET /api/job/<job_id> every 800ms
   until done == true
   Check log for "OK:" vs "ERROR:"
5. GET /api/file/<fid> to confirm final status == "ok"
```

### Batch sequential example (curl)

```bash
# Scan
curl -s -X POST http://localhost:5000/api/scan
# Wait for scan
until [ "$(curl -s http://localhost:5000/api/scan_status | python3 -c "import sys,json; print(json.load(sys.stdin)['done'])")" = "True" ]; do sleep 1; done

# Get files needing work
curl -s http://localhost:5000/api/scan_status | python3 -c "
import sys, json
data = json.load(sys.stdin)
for f in data.get('files', []):
    if f['status'] not in ('ok', '4k'):
        print(f['id'], f['name'], f['status'])
"

# Normalize a specific file
JID=$(curl -s -X POST http://localhost:5000/api/normalize \
  -H 'Content-Type: application/json' \
  -d '{"file_id":"42"}' | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")

# Poll until done
until [ "$(curl -s http://localhost:5000/api/job/$JID | python3 -c "import sys,json; print(json.load(sys.stdin)['done'])")" = "True" ]; do sleep 1; done
curl -s http://localhost:5000/api/job/$JID | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['log'][-1])"
```
