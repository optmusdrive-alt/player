/**
 * KEX Player Backend
 * ─────────────────────────────────────────────
 * Single .mkv from gofile.io → extract video + all embedded audio tracks
 * using FFprobe (metadata) + FFmpeg (live audio stream per track).
 *
 * Endpoints:
 *   GET /api/resolve?url=<gofile_url>
 *       → { title, videoUrl, size, audioTracks: [{index, label, codec, language, channels}] }
 *
 *   GET /api/audio?url=<direct_mkv_url>&track=<0|1|2…>&seek=<seconds>
 *       → streams the chosen audio track as Ogg/Opus in real-time via FFmpeg
 *
 *   GET /api/proxy?url=<direct_url>
 *       → transparent byte-range proxy for the MKV video (CORS + seeking)
 */

'use strict';
const express   = require('express');
const axios     = require('axios');
const cors      = require('cors');
const path      = require('path');
const { spawn } = require('child_process');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

/* ────────────────────────────────────────────────────────────────────────────
   UTILITY: get / refresh a Gofile guest token
──────────────────────────────────────────────────────────────────────────── */
const GOFILE_TOKEN = process.env.GOFILE_TOKEN || '';

async function getToken() {
  if (GOFILE_TOKEN) return GOFILE_TOKEN;
  const r = await axios.post('https://api.gofile.io/accounts', {}, {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.data.status !== 'ok') throw new Error('Gofile guest-token failed');
  return r.data.data.token;
}

/* ────────────────────────────────────────────────────────────────────────────
   UTILITY: resolve gofile share URL → direct .mkv download link
──────────────────────────────────────────────────────────────────────────── */
async function resolveGofile(shareUrl) {
  const m = shareUrl.match(/gofile\.io\/d\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error('Not a valid gofile.io/d/<id> URL');
  const id    = m[1];
  const token = await getToken();

  const { data } = await axios.get(
    `https://api.gofile.io/contents/${id}?wt=4fd6sg89d7s6`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (data.status !== 'ok') throw new Error('Gofile API: ' + data.status);

  const content = data.data;
  const files   = content.type === 'folder'
    ? Object.values(content.children || {}).filter(c => c.type === 'file')
    : content.type === 'file' ? [content] : [];

  const mkv = files.find(f =>
    f.name.toLowerCase().endsWith('.mkv') ||
    (f.mimetype && f.mimetype.includes('matroska'))
  );
  if (!mkv) {
    const names = files.map(f => f.name).join(', ') || 'none';
    throw new Error(`No .mkv found. Files in link: ${names}`);
  }
  return { url: mkv.link, title: mkv.name, size: mkv.size };
}

/* ────────────────────────────────────────────────────────────────────────────
   UTILITY: ffprobe a remote MKV URL → return all audio stream metadata
──────────────────────────────────────────────────────────────────────────── */
function ffprobe(url) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      '-i', url,
    ]);
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('error', e  => reject(new Error('ffprobe not found – install FFmpeg: https://ffmpeg.org/download.html\n' + e.message)));
    proc.on('close', () => {
      try {
        const streams = JSON.parse(out).streams || [];
        resolve(streams);
      } catch {
        reject(new Error('ffprobe parse error. stderr: ' + err.slice(0, 400)));
      }
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   UTILITY: turn a raw ffprobe stream object → human-readable track info
──────────────────────────────────────────────────────────────────────────── */
const LANG_MAP = {
  jpn:'🇯🇵 Japanese', eng:'🇬🇧 English', fre:'🇫🇷 French',
  ger:'🇩🇪 German',   spa:'🇪🇸 Spanish', ita:'🇮🇹 Italian',
  chi:'🇨🇳 Chinese',  kor:'🇰🇷 Korean',  por:'🇧🇷 Portuguese',
  rus:'🇷🇺 Russian',  ara:'🇸🇦 Arabic',  hin:'🇮🇳 Hindi',
  dut:'🇳🇱 Dutch',    tur:'🇹🇷 Turkish', und:'Unknown',
};

function buildTrack(s, audioIndex) {
  const lang  = (s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase().slice(0, 3);
  const title = s.tags?.title || s.tags?.TITLE || null;
  const ch    = s.channels || 2;
  const chLabel = ch === 6 ? '5.1' : ch === 8 ? '7.1' : `${ch}ch`;
  const codec = (s.codec_name || 'aac').toLowerCase();

  const langLabel = LANG_MAP[lang] || lang.toUpperCase();
  const label = title
    ? `${title} · ${chLabel}`
    : `${langLabel} · ${chLabel}`;

  return {
    index:       audioIndex,      // 0-based audio track index (for FFmpeg -map 0:a:<n>)
    streamIndex: s.index,         // raw stream index inside MKV container
    label,
    codec,
    language:    lang,
    channels:    ch,
    channelLayout: s.channel_layout || '',
    sampleRate:  s.sample_rate   || '48000',
    bitrate:     s.bit_rate      || null,
  };
}

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/resolve?url=<gofile_share_url>
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    // 1. Get direct MKV link from Gofile
    const { url: mkvUrl, title, size } = await resolveGofile(url);

    // 2. Probe the remote MKV (only reads header, very fast)
    let audioTracks = [];
    try {
      const streams = await ffprobe(mkvUrl);
      audioTracks   = streams.map((s, i) => buildTrack(s, i));
    } catch (probeErr) {
      console.warn('[KEX] ffprobe failed:', probeErr.message);
      // Continue – video will still play with its default embedded audio
    }

    res.json({ title, videoUrl: mkvUrl, size, audioTracks });

  } catch (err) {
    console.error('[KEX] /api/resolve:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/audio?url=<mkv_url>&track=<n>&seek=<sec>

   FFmpeg reads the remote MKV over HTTP, picks the Nth audio stream,
   re-encodes to Ogg/Opus, and pipes it directly to the browser.
   The browser <audio> element plays it in sync with the <video>.
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/audio', (req, res) => {
  const { url, track, seek } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const trackIdx = Math.max(0, parseInt(track) || 0);
  const seekSec  = Math.max(0, parseFloat(seek) || 0);

  // FFmpeg args
  const args = [
    '-ss', String(seekSec),          // seek before input (fast)
    '-i',  url,                       // remote MKV (HTTP)
    '-map', `0:a:${trackIdx}`,        // pick the Nth audio stream
    '-c:a', 'libopus',               // encode to Opus (best browser support for Ogg)
    '-b:a', '192k',                  // quality
    '-vn',                            // no video in output
    '-f',  'ogg',                    // Ogg container
    'pipe:1',                         // stream to stdout
  ];

  res.setHeader('Content-Type', 'audio/ogg; codecs=opus');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');              // Nginx: disable buffering
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ff.stdout.pipe(res);

  ff.stderr.on('data', d => {
    if (process.env.DEBUG_FFMPEG) process.stderr.write(d);
  });

  ff.on('error', err => {
    console.error('[KEX] FFmpeg spawn error:', err.message);
    if (!res.headersSent)
      res.status(500).send('FFmpeg not found. Install FFmpeg: https://ffmpeg.org/download.html');
  });

  ff.on('close', code => {
    if (code !== 0 && code !== null)
      console.warn(`[KEX] FFmpeg exited with code ${code}`);
  });

  // Kill FFmpeg cleanly when the client disconnects / seeks / switches track
  const cleanup = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close',   cleanup);
  req.on('aborted', cleanup);
  res.on('close',   cleanup);
});

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/proxy?url=<direct_url>

   Transparent byte-range proxy.
   Required because Gofile direct links block cross-origin Range requests,
   so the video element can't seek without this proxy.
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  try {
    const upHeaders = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) upHeaders['Range'] = req.headers.range;

    const upstream = await axios.get(url, {
      responseType: 'stream',
      headers: upHeaders,
      validateStatus: s => s < 500,
    });

    // Forward headers that matter for streaming / seeking
    for (const h of ['content-type','content-length','content-range','accept-ranges','last-modified','etag']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(upstream.status);
    upstream.data.pipe(res);

  } catch (err) {
    console.error('[KEX] /api/proxy:', err.message);
    if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   Fallback → serve the frontend SPA
──────────────────────────────────────────────────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`\n✅  KEX Player  →  http://localhost:${PORT}`);
  console.log(`    FFmpeg audio-track extraction: ENABLED`);
  console.log(`    Gofile proxy + range support:  ENABLED\n`);
});
