import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Top bar: which folders get scanned.
 * Nothing is scanned automatically — you pick the folders and they are remembered.
 * Detected paths only show up as suggestions inside the browser, still needing confirmation.
 */
export default function RootPicker({ roots, suggestions, onChange, scanning, live, setLive, onRescan, openInitially }) {
  const [open, setOpen] = useState(!!openInitially);
  const [dir, setDir] = useState(null);
  const [manual, setManual] = useState('');
  const barRef = useRef(null);
  const [anchor, setAnchor] = useState({ top: 40, left: 16 });

  useEffect(() => {
    if (open && !dir) load(roots[0] || null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  /**
   * The bar scrolls horizontally, and a scroll container clips absolutely
   * positioned children — so the panel is fixed and anchored by measurement.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = barRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: Math.round(r.bottom + 4), left: Math.round(r.left + 8) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  async function load(p) {
    try {
      const r = await fetch('/api/browse' + (p ? '?path=' + encodeURIComponent(p) : ''));
      const d = await r.json();
      if (!d.error) { setDir(d); setManual(d.path); }
    } catch { /* ignore */ }
  }

  const add = (p) => {
    if (!p) return;
    onChange([...new Set([...roots, p])]);
    setOpen(false);
  };

  return (
    <div className="rootbar" ref={barRef}>
      <span className="rb-label">Scanning</span>

      {roots.length === 0 && <span className="rb-none">no folder selected</span>}

      {roots.map((r) => (
        <button key={r} className="chip on" onClick={() => onChange(roots.filter((x) => x !== r))} title={'click to remove\n' + r}>
          {shorten(r)} <span className="x">✕</span>
        </button>
      ))}

      <button className={roots.length ? '' : 'primary'} onClick={() => setOpen(!open)}>
        {open ? 'Close' : '📁 Choose folder…'}
      </button>
      <button onClick={onRescan} disabled={scanning || !roots.length}>{scanning ? 'Scanning…' : '↻ Rescan'}</button>

      <label className="live" title="periodically check for new commands">
        <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
        Live
      </label>

      {open && (
        <div className="browser" style={{ top: anchor.top, left: anchor.left }}>
          <div className="br-head">
            <button onClick={() => dir?.parent && load(dir.parent)} disabled={!dir?.parent} title="parent folder">↑</button>
            <input
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && load(manual)}
              placeholder="type a path and press Enter"
              spellCheck={false}
            />
            <button className="primary" onClick={() => add(dir?.path || manual)}>
              Scan this folder
            </button>
          </div>

          {suggestions?.length > 0 && (
            <div className="br-sugg">
              <span>suggestions:</span>
              {suggestions.map((s) => (
                <button key={s.root} className="chip" onClick={() => load(s.root)} title={s.root}>
                  {s.label}
                </button>
              ))}
            </div>
          )}

          <div className="br-list">
            {(dir?.entries || []).map((e) => (
              <div key={e.path} className="br-item">
                <span className="br-name" onClick={() => load(e.path)} title="open">📁 {e.name}</span>
                <button className="br-pick" onClick={() => add(e.path)} title={'scan ' + e.path}>scan</button>
              </div>
            ))}
            {dir && !dir.entries.length && <div className="br-empty">(no subfolders)</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function shorten(p) {
  const parts = String(p).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length <= 2 ? p : '…/' + parts.slice(-2).join('/');
}
