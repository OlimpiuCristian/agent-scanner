import React, { useCallback, useEffect, useRef, useState } from 'react';
import SessionTree from './components/SessionTree.jsx';
import GraphView from './components/GraphView.jsx';
import Timeline from './components/Timeline.jsx';
import MessagePanel from './components/MessagePanel.jsx';
import RootPicker from './components/RootPicker.jsx';
import EventExplorer from './components/EventExplorer.jsx';

const POLL_MS = 4000;        // cheap pulse: re-stat known files
const FULL_SCAN_MS = 60000;  // full walk, to discover new sessions
const STORE = 'agentviz.roots';

export default function App() {
  const [roots, setRoots] = useState(() => {
    try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
  });
  const [suggestions, setSuggestions] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [scanning, setScanning] = useState(true);
  const [live, setLive] = useState(true);
  const [newFiles, setNewFiles] = useState(() => new Set());

  const [active, setActive] = useState(null);
  const [graph, setGraph] = useState(null);
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [error, setError] = useState(null);

  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [follow, setFollow] = useState(true);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const explorerToggleRef = useRef(null);

  const seekEvent = useCallback((index) => {
    setPlaying(false);
    setFollow(false);
    followRef.current = false;
    setCursor(index);
  }, []);

  const fpRef = useRef(null);
  const pulseFpRef = useRef(null);
  const activeRef = useRef(null);
  const sessionsRef = useRef([]);
  const followRef = useRef(true);
  activeRef.current = active;
  sessionsRef.current = sessions;
  followRef.current = follow;

  useEffect(() => { localStorage.setItem(STORE, JSON.stringify(roots)); }, [roots]);

  useEffect(() => {
    fetch('/api/roots').then((r) => r.json()).then((d) => setSuggestions(d.roots || [])).catch(() => {});
  }, []);

  /** Reload the index. `quiet` = triggered by the poller, so no spinner. */
  const loadIndex = useCallback(async (quiet) => {
    // nothing is scanned until a folder is chosen
    if (!roots.length) { setSessions([]); setScanning(false); return []; }
    if (!quiet) setScanning(true);
    try {
      const r = await fetch('/api/sessions?roots=' + encodeURIComponent(roots.join(';')));
      const d = await r.json();
      const list = d.sessions || [];

      if (fpRef.current && d.fingerprint !== fpRef.current) {
        const prev = new Map(sessionsRef.current.map((s) => [s.file, s.mtime]));
        const changed = new Set();
        for (const s of list) if (!prev.has(s.file) || prev.get(s.file) !== s.mtime) changed.add(s.file);
        if (changed.size) {
          setNewFiles(changed);
          setTimeout(() => setNewFiles(new Set()), 12000);
        }
      }
      fpRef.current = d.fingerprint;
      sessionsRef.current = list;
      setSessions(list);
      return list;
    } catch (e) {
      setError('Cannot read sessions: ' + e.message);
      return [];
    } finally {
      if (!quiet) setScanning(false);
    }
  }, [roots]);

  /** Reload the open graph after its transcript (or a child transcript) changes. */
  const reloadActive = useCallback(async (list, force = false) => {
    const a = activeRef.current;
    if (!a) return;
    const fresh = list.find((s) => s.file === a.file) || a;
    if (!force && fresh.mtime === a.mtime) return;

    try {
      const suffix = force ? '&force=1' : '';
      const r = await fetch('/api/session?file=' + encodeURIComponent(a.file) + suffix);
      const d = await r.json();
      if (d.error) return;
      setActive(fresh);
      setGraph(d);
      if (followRef.current) setCursor(Math.max(0, d.events.length - 1));
    } catch { /* the next watcher event or poll retries */ }
  }, []);

  const select = useCallback(async (s, startAt = 0) => {
    setActive(s);
    location.hash = encodeURIComponent(s.sessionId || '');
    setPlaying(false);
    setCursor(startAt);
    setGraph(null);
    setLoadingGraph(true);
    setError(null);
    try {
      const r = await fetch('/api/session?file=' + encodeURIComponent(s.file));
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setGraph(d);
    } catch (e) {
      setError('Cannot load session: ' + e.message);
    } finally {
      setLoadingGraph(false);
    }
  }, []);

  // startup: index + session from the URL, or the first one
  useEffect(() => {
    loadIndex().then((list) => {
      if (!list.length) return;
      const [want, at] = decodeURIComponent(location.hash.slice(1)).split('@');
      select(list.find((s) => s.sessionId === want) || list[0], Number(at) || 0);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roots]);

  /*
   * Live updates use a filesystem watcher/SSE for immediate notification. The
   * cheap pulse remains as a cross-platform/reconnect fallback, and the stable
   * full-scan timer discovers files if recursive watching is unavailable.
   */
  useEffect(() => {
    if (!live || !roots.length) return;
    let stop = false;
    let lastFull = Date.now();
    let running = false;
    let eventDebounce = null;
    let reconnect = null;
    let source = null;
    let pendingWatcherRefresh = false;

    const refresh = async ({ fromWatcher = false } = {}) => {
      if (stop) return;
      if (document.hidden) {
        if (fromWatcher) pendingWatcherRefresh = true;
        return;
      }
      if (running) {
        if (fromWatcher) pendingWatcherRefresh = true;
        return;
      }
      running = true;

      let changed = false;
      try {
        if (!fromWatcher) {
          const r = await fetch('/api/pulse?roots=' + encodeURIComponent(roots.join(';')));
          const d = await r.json();
          changed = pulseFpRef.current !== null && d.fingerprint !== pulseFpRef.current;
          pulseFpRef.current = d.fingerprint;
        }

        const dueFull = Date.now() - lastFull > FULL_SCAN_MS;
        if (!fromWatcher && !changed && !dueFull) return;
        if (dueFull || fromWatcher) lastFull = Date.now();

        const list = await loadIndex(true);
        await reloadActive(list, fromWatcher);
      } catch { /* fallback retries on the next interval */ }
      finally {
        running = false;
        if (pendingWatcherRefresh && !stop) {
          pendingWatcherRefresh = false;
          eventDebounce = setTimeout(() => refresh({ fromWatcher: true }), 0);
        }
      }
    };

    const connect = () => {
      if (stop) return;
      source = new EventSource('/api/live?roots=' + encodeURIComponent(roots.join(';')));
      source.addEventListener('change', () => {
        clearTimeout(eventDebounce);
        eventDebounce = setTimeout(() => refresh({ fromWatcher: true }), 100);
      });
      source.onerror = () => {
        source?.close();
        source = null;
        clearTimeout(reconnect);
        reconnect = setTimeout(connect, 3000);
      };
    };

    const onVisible = () => {
      if (document.hidden) return;
      const fromWatcher = pendingWatcherRefresh;
      pendingWatcherRefresh = false;
      refresh({ fromWatcher });
    };
    connect();
    const h = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      source?.close();
      clearTimeout(eventDebounce);
      clearTimeout(reconnect);
      clearInterval(h);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [live, roots, loadIndex, reloadActive]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.closest('input, select, textarea, button, [contenteditable="true"]')) return;
      const n = graph?.events.length || 1;
      if (e.code === 'Space') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.code === 'ArrowRight') { setPlaying(false); setCursor((c) => Math.min(n - 1, Math.floor(c) + 1)); }
      else if (e.code === 'ArrowLeft') { setPlaying(false); setCursor((c) => Math.max(0, Math.floor(c) - 1)); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [graph]);

  const events = graph?.events || [];
  const current = events.length ? events[Math.min(events.length - 1, Math.floor(cursor))] : null;
  const agentCount = (graph?.nodes || []).filter((n) => n.type === 'agent').length;

  return (
    <div className="app">
      <SessionTree
        sessions={sessions}
        activeFile={active?.file}
        onSelect={select}
        loading={scanning}
        newFiles={newFiles}
      />

      <div className="main">
        <RootPicker
          roots={roots}
          suggestions={suggestions}
          onChange={setRoots}
          scanning={scanning}
          live={live}
          setLive={setLive}
          onRescan={() => loadIndex()}
          openInitially={roots.length === 0}
        />

        <header className="header">
          <h2>{graph?.title || active?.title || 'Agent Communication'}</h2>
          <span className="sub">
            {active?.sourceLabel ? active.sourceLabel + ' · ' : ''}
            {active?.project}
            {graph?.gitBranch ? ' · ' + graph.gitBranch : ''}
            {graph ? ` · ${agentCount} agents · ${events.length} events` : ''}
          </span>
          {graph && <button ref={explorerToggleRef} className={'chip' + (explorerOpen ? ' on' : '')}
            aria-expanded={explorerOpen} aria-controls="event-explorer" onClick={() => setExplorerOpen((open) => !open)}>
            Events <span>{events.length}</span>
          </button>}
        </header>

        <MessagePanel current={current} nodes={graph?.nodes} />

        {error && <div className="empty" style={{ color: '#ff6b6b' }}>{error}</div>}
        {!error && loadingGraph && <div className="empty">Building the session graph…</div>}
        {!error && !loadingGraph && !graph && (
          <div className="empty">
            {roots.length === 0
              ? 'Choose a folder to scan from the top bar.'
              : sessions.length === 0
                ? 'No sessions found in the chosen folder.'
                : 'Pick a session on the left.'}
          </div>
        )}
        {!error && !loadingGraph && graph && (
          <div className={'session-workspace' + (explorerOpen ? ' with-explorer' : '')}>
            <GraphView graph={graph} cursor={cursor} />
            <EventExplorer key={active?.file} events={events} nodes={graph.nodes} cursor={cursor}
              onSeek={seekEvent} open={explorerOpen} onClose={() => {
                setExplorerOpen(false);
                explorerToggleRef.current?.focus();
              }} />
          </div>
        )}

        {graph && events.length > 0 && (
          <Timeline
            events={events}
            cursor={cursor} setCursor={setCursor}
            playing={playing} setPlaying={setPlaying}
            speed={speed} setSpeed={setSpeed}
            follow={follow} setFollow={setFollow}
          />
        )}
      </div>
    </div>
  );
}
