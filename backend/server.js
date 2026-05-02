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

/* ────────────────────────────────────────────────────────────────────────────
   GOFILE TOKEN
   Priority: env var GOFILE_TOKEN → auto guest token
──────────────────────────────────────────────────────────────────────────── */
let cachedToken = process.env.GOFILE_TOKEN || '';

async function getToken() {
  // If token set via env, always use it
  if (process.env.GOFILE_TOKEN) return process.env.GOFILE_TOKEN;

  // Try to get a fresh guest token
  try {
    const r = await axios.post(
      'https://api.gofile.io/accounts',
      {},
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      }
    );
    if (r.data?.status === 'ok' && r.data?.data?.token) {
      cachedToken = r.data.data.token;
      console.log('[KEX] Got fresh guest token');
      return cachedToken;
    }
  } catch (e) {
    console.warn('[KEX] Guest token failed:', e.message);
  }

  // Fall back to cached
  if (cachedToken) return cachedToken;
  throw new Error('No Gofile token available. Set GOFILE_TOKEN in Railway Variables.');
}

/* ────────────────────────────────────────────────────────────────────────────
   RESOLVE GOFILE LINK → direct MKV URL
──────────────────────────────────────────────────────────────────────────── */
async function resolveGofile(shareUrl) {
  const m = shareUrl.match(/gofile\.io\/(?:d|shared)\/([a-zA-Z0-9]+)/);
  if (!m) throw new Error('Invalid gofile.io URL. Must be: https://gofile.io/d/XXXXXX');
  const id = m[1];

  const token = await getToken();
  console.log(`[KEX] Resolving content ID: ${id}`);

  let data;
  try {
    const r = await axios.get(`https://api.gofile.io/contents/${id}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0',
      },
      params: { wt: '4fd6sg89d7s6' },
    });
    data = r.data;
  } catch (e) {
    if (e.response?.status === 401) {
      // Token expired — clear cache and retry once with fresh token
      cachedToken = '';
      const freshToken = await getToken();
      const r2 = await axios.get(`https://api.gofile.io/contents/${id}`, {
        headers: {
          Authorization: `Bearer ${freshToken}`,
          'User-Agent': 'Mozilla/5.0',
        },
        params: { wt: '4fd6sg89d7s6' },
      });
      data = r2.data;
    } else {
      throw e;
    }
  }

  if (data.status !== 'ok') {
    throw new Error(`Gofile API returned: ${data.status}`);
  }

  const content = data.data;
  console.log(`[KEX] Content type: ${content.type}`);

  let files = [];
  if (content.type === 'folder') {
    const children = content.children || content.childs || {};
    files = Object.values(children).filter(c => c.type === 'file');
  } else if (content.type === 'file') {
    files = [content];
  }

  console.log(`[KEX] Files found: ${files.map(f => f.name).join(', ')}`);

  const mkv = files.find(f =>
    f.name?.toLowerCase().endsWith('.mkv') ||
    f.mimetype?.includes('matroska') ||
    f.mimetype?.includes('x-mkv')
  );

  if (!mkv) {
    const names = files.map(f => f.name).join(', ') || 'none';
    throw new Error(`No .mkv file found. Files in link: ${names}`);
  }

  const downloadUrl = mkv.link || mkv.directLink || mkv.downloadPage;
  if (!downloadUrl) {
    throw new Error('Could not get download URL. Try setting GOFILE_TOKEN in Railway Variables.');
  }

  console.log(`[KEX] Found MKV: ${mkv.name}`);
  return { url: downloadUrl, title: mkv.name, size: mkv.size || 0 };
}

/* ────────────────────────────────────────────────────────────────────────────
   FFPROBE — read audio tracks from remote MKV
──────────────────────────────────────────────────────────────────────────── */
function ffprobeUrl(url) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-select_streams', 'a',
      '-i', url,
    ]);
    let out = '';
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => resolve([])); // ffprobe not found — just return empty
    proc.on('close', () => {
      try { resolve(JSON.parse(out).streams || []); }
      catch { resolve([]); }
    });
  });
}

/* ────────────────────────────────────────────────────────────────────────────
   BUILD TRACK LABEL
──────────────────────────────────────────────────────────────────────────── */
const LANG_MAP = {
  jpn: '🇯🇵 Japanese', eng: '🇬🇧 English', fre: '🇫🇷 French',
  ger: '🇩🇪 German',   spa: '🇪🇸 Spanish', ita: '🇮🇹 Italian',
  chi: '🇨🇳 Chinese',  kor: '🇰🇷 Korean',  por: '🇧🇷 Portuguese',
  rus: '🇷🇺 Russian',  ara: '🇸🇦 Arabic',  hin: '🇮🇳 Hindi',
  dut: '🇳🇱 Dutch',    tur: '🇹🇷 Turkish', und: 'Unknown',
};

function buildTrack(s, i) {
  const lang    = (s.tags?.language || s.tags?.LANGUAGE || 'und').toLowerCase().slice(0, 3);
  const title   = s.tags?.title || s.tags?.TITLE || null;
  const ch      = s.channels || 2;
  const chLabel = ch === 6 ? '5.1' : ch === 8 ? '7.1' : `${ch}ch`;
  const codec   = (s.codec_name || 'aac').toLowerCase();
  const langLabel = LANG_MAP[lang] || lang.toUpperCase();
  const label   = title ? `${title} · ${chLabel}` : `${langLabel} · ${chLabel}`;
  return { index: i, streamIndex: s.index, label, codec, language: lang, channels: ch };
}

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/health
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    token: process.env.GOFILE_TOKEN ? 'SET ✅' : 'NOT SET ⚠️',
  });
});

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/resolve?url=
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const { url: mkvUrl, title, size } = await resolveGofile(url);

    let audioTracks = [];
    try {
      const streams = await ffprobeUrl(mkvUrl);
      audioTracks   = streams.map(buildTrack);
      console.log(`[KEX] Audio tracks: ${audioTracks.length}`);
    } catch (e) {
      console.warn('[KEX] ffprobe failed:', e.message);
    }

    res.json({ title, videoUrl: mkvUrl, size, audioTracks });

  } catch (err) {
    console.error('[KEX] /api/resolve error:', err.message);

    let msg = err.message;
    if (err.response?.status === 401) {
      msg = '401 Unauthorized — GOFILE_TOKEN is invalid or expired. Go to gofile.io → Profile → API Token → copy it → add to Railway Variables as GOFILE_TOKEN.';
    } else if (err.response?.status === 404) {
      msg = '404 — Link not found or expired.';
    }

    res.status(500).json({ error: msg });
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/audio?url=&track=&seek=
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/audio', (req, res) => {
  const { url, track, seek } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  const trackIdx = Math.max(0, parseInt(track) || 0);
  const seekSec  = Math.max(0, parseFloat(seek)  || 0);

  const args = [
    '-ss',  String(seekSec),
    '-i',   url,
    '-map', `0:a:${trackIdx}`,
    '-c:a', 'libopus',
    '-b:a', '192k',
    '-vn',
    '-f',   'ogg',
    'pipe:1',
  ];

  res.setHeader('Content-Type',      'audio/ogg; codecs=opus');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control',     'no-cache, no-store');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ff.stdout.pipe(res);
  ff.stderr.on('data', d => { if (process.env.DEBUG_FFMPEG) process.stderr.write(d); });
  ff.on('error', err => {
    if (!res.headersSent) res.status(500).send('FFmpeg error: ' + err.message);
  });

  const cleanup = () => { try { ff.kill('SIGKILL'); } catch {} };
  req.on('close',   cleanup);
  req.on('aborted', cleanup);
  res.on('close',   cleanup);
});

/* ────────────────────────────────────────────────────────────────────────────
   ROUTE: GET /api/proxy?url=
──────────────────────────────────────────────────────────────────────────── */
app.get('/api/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing ?url=');

  try {
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (req.headers.range) headers['Range'] = req.headers.range;

    const upstream = await axios.get(url, {
      responseType: 'stream',
      headers,
      validateStatus: s => s < 500,
    });

    for (const h of ['content-type','content-length','content-range','accept-ranges','last-modified','etag']) {
      if (upstream.headers[h]) res.setHeader(h, upstream.headers[h]);
    }
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(upstream.status);
    upstream.data.pipe(res);

  } catch (err) {
    if (!res.headersSent) res.status(502).send('Proxy error: ' + err.message);
  }
});

/* ────────────────────────────────────────────────────────────────────────────
   START
──────────────────────────────────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n✅  KEX Player  →  http://localhost:${PORT}`);
  console.log(`    GOFILE_TOKEN: ${process.env.GOFILE_TOKEN ? 'SET ✅' : 'NOT SET ⚠️'}`);
  console.log(`    FFmpeg audio-track extraction: ENABLED`);
  console.log(`    Gofile proxy + range support:  ENABLED\n`);
});
