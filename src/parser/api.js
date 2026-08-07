/**
 * Local API. Runs in the same process as Vite and reads only from the local disk.
 *
 *   GET /api/roots                    auto-detected roots (suggestions only)
 *   GET /api/browse?path=...          a path's subfolders (folder picker)
 *   GET /api/sessions?roots=a;b       the session index (incremental)
 *   GET /api/session?file=...         one session's full graph
 */
import fs from 'node:fs';
import { buildIndex, parseSession, autoRoots, browse, fingerprint, pulse, SOURCE_LIST } from './registry.js';

const sessionCache = new Map(); // file -> {mtime, data}
let indexInFlight = null;

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
        const roots = (url.searchParams.get('roots') || '').split(';').map((s) => s.trim()).filter(Boolean);
        const seen = pulse(roots);
        return json(res, 200, { fingerprint: fingerprint(seen), files: seen.length });
      }

      if (url.pathname === '/api/sessions') {
        const roots = (url.searchParams.get('roots') || '').split(';').map((s) => s.trim()).filter(Boolean);
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

        const hit = sessionCache.get(file);
        if (hit && hit.mtime === st.mtimeMs) return json(res, 200, hit.data);

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
