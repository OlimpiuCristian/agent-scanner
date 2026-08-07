import React, { useCallback, useEffect, useRef, useState } from 'react';
import SessionTree from './components/SessionTree.jsx';
import GraphView from './components/GraphView.jsx';
import Timeline from './components/Timeline.jsx';
import MessagePanel from './components/MessagePanel.jsx';
import RootPicker from './components/RootPicker.jsx';

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

  const fpRef = useRef(null);
  const pulseFpRef = useRef(null);
  const activeRef = useRef(null);
  const graphRef = useRef(null);
  const cursorRef = useRef(0);
  activeRef.current = active;
  graphRef.current = graph;
  cursorRef.current = cursor;

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
        const prev = new Map(sessions.map((s) => [s.file, s.mtime]));
        const changed = new Set();
        for (const s of list) if (!prev.has(s.file) || prev.get(s.file) !== s.mtime) changed.add(s.file);
        if (changed.size) {
          setNewFiles(changed);
          setTimeout(() => setNewFiles(new Set()), 12000);
        }
      }
      fpRef.current = d.fingerprint;
      setSessions(list);
      return list;
    } catch (e) {
      setError('Cannot read sessions: ' + e.message);
      return [];
    } finally {
      if (!quiet) setScanning(false);
    }
  }, [roots, sessions]);

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
   * Poller. The cheap pulse only re-stats known files; a full rescan walks the
   * folders and is far slower, so it runs on a much longer interval and is what
   * discovers brand-new sessions.
   */
  useEffect(() => {
    if (!live || !roots.length) return;
    let stop = false;
    let lastFull = Date.now();

    const tick = async () => {
      if (stop || document.hidden) return;

      let changed = false;
      try {
        const r = await fetch('/api/pulse?roots=' + encodeURIComponent(roots.join(';')));
        const d = await r.json();
        changed = pulseFpRef.current !== null && d.fingerprint !== pulseFpRef.current;
        pulseFpRef.current = d.fingerprint;
      } catch { return; }

      const dueFull = Date.now() - lastFull > FULL_SCAN_MS;
      if (!changed && !dueFull) return;
      if (dueFull) lastFull = Date.now();

      const list = await loadIndex(true);
      const a = activeRef.current;
      if (!a) return;
      const fresh = list.find((s) => s.file === a.file);
      if (!fresh || fresh.mtime === a.mtime) return;

      // the open session changed: reload the graph, keeping the position
      try {
        const r = await fetch('/api/session?file=' + encodeURIComponent(a.file));
        const d = await r.json();
        if (d.error) return;
        const old = graphRef.current?.events.length || 0;
        setActive(fresh);
        setGraph(d);
        // if we were caught up with the end, stay caught up
        if (follow && cursorRef.current >= old - 1.5) setCursor(Math.max(0, d.events.length - 1));
      } catch { /* ignore */ }
    };
    const h = setInterval(tick, POLL_MS);
    return () => { stop = true; clearInterval(h); };
  }, [live, follow, roots, loadIndex]);

  useEffect(() => {
    const onKey = (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
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
        {!error && !loadingGraph && graph && <GraphView graph={graph} cursor={cursor} />}

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
