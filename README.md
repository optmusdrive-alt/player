# KEX Player v3
### Single MKV · Embedded Audio Track Extraction via FFmpeg

---

## How It Works

```
User pastes gofile.io link
        ↓
Backend calls Gofile API → gets direct .mkv download URL
        ↓
Backend runs ffprobe on the remote MKV → reads all embedded audio tracks (no full download)
        ↓
Frontend shows track chips: "🇯🇵 Japanese · AAC 5.1", "🇬🇧 English · AC3 2ch", etc.
        ↓
User clicks a track chip
        ↓
Backend spawns FFmpeg → pipes that audio track live as Ogg/Opus stream
        ↓
Frontend <audio> plays in sync with <video> (seeking, speed, volume all synced)
```

---

## Project Structure

```
kex-v3/
├── backend/
│   ├── server.js          ← Express API + FFmpeg audio streaming
│   └── package.json
└── frontend/
    └── index.html         ← KEX Player UI (served by Express)
```

---

## Prerequisites

### 1. Node.js 18+
```bash
node --version   # must be >= 18
```

### 2. FFmpeg (REQUIRED)
FFmpeg must be installed and available in your PATH.

**macOS:**
```bash
brew install ffmpeg
```

**Ubuntu / Debian:**
```bash
sudo apt update && sudo apt install -y ffmpeg
```

**Windows:**
- Download from https://ffmpeg.org/download.html
- Add the `bin/` folder to your system PATH
- Verify: `ffmpeg -version`

**Verify install:**
```bash
ffmpeg -version
ffprobe -version
```

---

## Local Development

```bash
cd kex-v3/backend
npm install
npm start
```

Open → **http://localhost:3001**

For auto-reload during development:
```bash
npm run dev
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Server port |
| `GOFILE_TOKEN` | *(auto)* | Your Gofile API token. If blank, a guest token is auto-created. |
| `DEBUG_FFMPEG` | *(off)* | Set to `1` to print FFmpeg stderr logs |

Create a `.env` file in `backend/` (optional):
```
PORT=3001
GOFILE_TOKEN=your_token_here
DEBUG_FFMPEG=0
```

To load `.env` automatically, add to the top of `server.js`:
```js
require('dotenv').config();
```
And install: `npm install dotenv`

---

## API Reference

### `GET /api/resolve?url=<gofile_url>`
Resolves the Gofile link and probes the MKV for audio tracks.

**Response:**
```json
{
  "title": "anime_episode_01.mkv",
  "videoUrl": "https://store1.gofile.io/download/...",
  "size": 1073741824,
  "audioTracks": [
    {
      "index": 0,
      "streamIndex": 1,
      "label": "🇯🇵 Japanese · 2ch",
      "codec": "aac",
      "language": "jpn",
      "channels": 2
    },
    {
      "index": 1,
      "streamIndex": 2,
      "label": "🇬🇧 English · 5.1",
      "codec": "ac3",
      "language": "eng",
      "channels": 6
    }
  ]
}
```

---

### `GET /api/audio?url=<mkv_url>&track=<n>&seek=<seconds>`
Streams the Nth audio track from the MKV as live Ogg/Opus via FFmpeg.

- `track` = 0-based audio track index (from `/api/resolve`)
- `seek` = start position in seconds (syncs with video position)
- Response: `audio/ogg; codecs=opus` (chunked stream)

FFmpeg is killed automatically when the browser disconnects or switches tracks.

---

### `GET /api/proxy?url=<direct_url>`
Transparent byte-range proxy for the MKV video file.
Required because Gofile direct links block cross-origin Range requests,
which the browser needs for video seeking.

---

## Deployment

### Option A — Railway *(easiest, free tier)*

1. Push your `kex-v3/` folder to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**
3. Select your repo
4. In **Settings**:
   - Root Directory: `backend`
   - Start Command: `node server.js`
5. Under **Variables**, add:
   ```
   PORT=3001
   ```
6. Railway auto-installs FFmpeg on its build images ✅
7. Click **Deploy** — you get a public HTTPS URL in ~2 minutes

---

### Option B — Render *(free tier)*

1. Push to GitHub
2. [render.com](https://render.com) → **New Web Service**
3. Settings:
   - Root Directory: `backend`
   - Build Command: `npm install`
   - Start Command: `node server.js`
4. **FFmpeg on Render** — add a `render.yaml` to your repo root:
```yaml
services:
  - type: web
    name: kex-player
    env: node
    rootDir: backend
    buildCommand: |
      apt-get update -y && apt-get install -y ffmpeg
      npm install
    startCommand: node server.js
    envVars:
      - key: PORT
        value: 10000
```

---

### Option C — VPS (Ubuntu) with Nginx + PM2

```bash
# 1. Install Node, FFmpeg
sudo apt update
sudo apt install -y nodejs npm ffmpeg

# 2. Clone your project
git clone <your-repo> kex-v3
cd kex-v3/backend && npm install

# 3. Run with PM2
npm install -g pm2
pm2 start server.js --name kex-player
pm2 save && pm2 startup

# 4. Nginx reverse proxy
sudo nano /etc/nginx/sites-available/kex
```

Nginx config:
```nginx
server {
    listen 80;
    server_name yourdomain.com;

    # Disable buffering — critical for live audio streaming
    proxy_buffering off;
    proxy_request_buffering off;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;

        # Needed for chunked audio stream
        chunked_transfer_encoding on;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/kex /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# HTTPS with Let's Encrypt
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com
```

---

### Option D — Docker

Create `backend/Dockerfile`:
```dockerfile
FROM node:20-alpine

# Install FFmpeg
RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .

EXPOSE 3001
CMD ["node", "server.js"]
```

```bash
# Build
docker build -t kex-player ./backend

# Run
docker run -p 3001:3001 \
  -e GOFILE_TOKEN=your_token \
  kex-player
```

With Docker Compose (`docker-compose.yml`):
```yaml
version: '3.8'
services:
  kex:
    build: ./backend
    ports:
      - "3001:3001"
    environment:
      - PORT=3001
      - GOFILE_TOKEN=${GOFILE_TOKEN}
    restart: unless-stopped
```

```bash
docker-compose up -d
```

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `M` | Toggle mute |
| `F` | Toggle fullscreen |
| `←` / `→` | Seek ±5 seconds |
| `↑` / `↓` | Volume ±10% |

---

## Notes

- **ffprobe only reads the MKV header** to detect tracks — it does NOT download the full file
- **Audio switching** mutes the video element and plays the FFmpeg-extracted stream via a second `<audio>` element, kept in sync on seek and speed change
- **The "Embedded (default)" option** uses the browser's native audio from the video element — no FFmpeg needed
- If your MKV has only 1 audio track, the track panel still shows and you can switch between "embedded" and "extracted" (same audio, useful for testing)
- Gofile guest tokens are auto-created and cached per request; for private files set `GOFILE_TOKEN` in your env
