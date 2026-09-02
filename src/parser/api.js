/**
 * Local API. Runs in the same process as Vite and reads only from the local disk.
 *
 *   GET /api/roots                    auto-detected roots (suggestions only)
 *   GET /api/browse?path=...          a path's subfolders (folder picker)
 *   GET /api/sessions?roots=a;b       the session index (incremental)
 *   GET /api/session?file=...         one session's full graph
 *   GET /api/live?roots=a;b           filesystem changes as server-sent events
 */
import fs from 'node:fs';
import { buildIndex, parseSession, autoRoots, browse, fingerprint, pulse, SOURCE_LIST } from './registry.js';

const sessionCache = new Map(); // file -> {mtime, data}
let indexInFlight = null;

function rootsFrom(url) {
  return (url.searchParams.get('roots') || '').split(';').map((s) => s.trim()).filter(Boolean);
}

/**
 * Watches the selected folders and tells the browser as soon as a transcript
 * changes. Recursive fs.watch is available on Windows/macOS; when it is not,
 * the browser's polling fallback continues to provide updates.
 */
function live(req, res, roots) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const watchers = [];
  let debounce = null;
  let closed = false;

  const send = (event, data) => {
    if (!closed && !res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  for (const root of roots) {
    try {
      const watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        const relative = filename ? String(filename) : '';
        // Transcript writes are JSON/JSONL. Directory rename notifications can
        // be ignored because creation of the transcript itself follows them.
        if (relative && !/\.jsonl?$/i.test(relative)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => send('change', { eventType, root, file: relative }), 180);
      });
      // A watcher can fail after it was created (for example when a removable
      // drive disappears). Do not let that take down the local API process.
      watcher.on('error', () => {});
      watchers.push(watcher);
    } catch {
      // Some platforms/filesystems do not support recursive watching. The
      // client deliberately keeps its cheap 4-second pulse as a fallback.
    }
  }

  send('ready', { watching: watchers.length, requested: roots.length });
  const keepAlive = setInterval(() => {
    if (!closed && !res.writableEnded) res.write(': keep-alive\n\n');
  }, 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearTimeout(debounce);
    clearInterval(keepAlive);
    for (const watcher of watchers) watcher.close();
  };
  res.on('close', cleanup);
}

function json(res, code, body) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

export function apiMiddleware() {
  return async (req, res, next) => {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return next();

    try {
      if (url.pathname === '/api/roots') {
        return json(res, 200, { roots: autoRoots(), sources: SOURCE_LIST });
      }

      if (url.pathname === '/api/browse') {
        return json(res, 200, browse(url.searchParams.get('path')));
      }

      if (url.pathname === '/api/pulse') {
        const roots = rootsFrom(url);
        const seen = pulse(roots);
        return json(res, 200, { fingerprint: fingerprint(seen), files: seen.length });
      }

      if (url.pathname === '/api/live') {
        const roots = rootsFrom(url);
        if (!roots.length) return json(res, 400, { error: 'missing roots parameter' });
        live(req, res, roots);
        return;
      }

      if (url.pathname === '/api/sessions') {
        const roots = rootsFrom(url);
        const fast = url.searchParams.get('deep') !== '1';
        // only one scan at a time; the poller attaches to the one in flight
        if (!indexInFlight) {
          indexInFlight = buildIndex(roots, { fast }).finally(() => { indexInFlight = null; });
        }
        const r = await indexInFlight;
        return json(res, 200, { ...r, fingerprint: fingerprint(r.sessions) });
      }

      if (url.pathname === '/api/session') {
        const file = url.searchParams.get('file');
        if (!file) return json(res, 400, { error: 'missing file parameter' });

        let st;
        try { st = fs.statSync(file); } catch { return json(res, 404, { error: 'session does not exist' }); }

        const force = url.searchParams.get('force') === '1';
        const hit = sessionCache.get(file);
        if (!force && hit && hit.mtime === st.mtimeMs) return json(res, 200, hit.data);

        const data = await parseSession(file);
        data.mtime = st.mtimeMs;
        sessionCache.set(file, { mtime: st.mtimeMs, data });
        if (sessionCache.size > 12) sessionCache.delete(sessionCache.keys().next().value);
        return json(res, 200, data);
      }

      return json(res, 404, { error: 'unknown route' });
    } catch (err) {
      return json(res, 500, { error: String(err?.message || err) });
    }
  };
}
