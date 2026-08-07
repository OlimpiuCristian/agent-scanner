import React, { useMemo, useState } from 'react';

const SOURCE_COLOR = { claude: '#d97757', codex: '#10a37f', copilot: '#6e40c9' };

/** Tree: source -> project/workspace -> session. */
export default function SessionTree({ sessions, activeFile, onSelect, loading, newFiles }) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());

  const tree = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = needle
      ? sessions.filter((s) =>
          (s.title || '').toLowerCase().includes(needle) ||
          (s.project || '').toLowerCase().includes(needle) ||
          (s.source || '').toLowerCase().includes(needle) ||
          (s.subagents || []).some((a) => String(a).toLowerCase().includes(needle)))
      : sessions;

    const bySource = new Map();
    for (const s of list) {
      const src = s.source || 'unknown';
      if (!bySource.has(src)) bySource.set(src, new Map());
      const byProj = bySource.get(src);
      const proj = s.project || 'unknown';
      if (!byProj.has(proj)) byProj.set(proj, []);
      byProj.get(proj).push(s);
    }
    return [...bySource.entries()].map(([src, projs]) => ({
      src,
      label: (projs.values().next().value?.[0]?.sourceLabel) || src,
      count: [...projs.values()].reduce((a, b) => a + b.length, 0),
      projects: [...projs.entries()]
        .map(([p, list]) => ({ project: p, list: list.sort((a, b) => (b.end || '').localeCompare(a.end || '')) }))
        .sort((a, b) => (b.list[0].end || '').localeCompare(a.list[0].end || '')),
    // sources are ordered by most recent activity, not by count:
    // otherwise a source with many old sessions buries today's work
    })).sort((a, b) => (b.projects[0]?.list[0]?.end || '').localeCompare(a.projects[0]?.list[0]?.end || ''));
  }, [sessions, q]);

  const toggle = (key) => setCollapsed((c) => {
    const n = new Set(c);
    n.has(key) ? n.delete(key) : n.add(key);
    return n;
  });

  return (
    <aside className="sidebar">
      <input
        className="search"
        placeholder="search session, project, agent…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="session-list">
        {!tree.length && (
          <div className="tree-empty">{loading ? 'Scanning…' : 'No sessions found.'}</div>
        )}

        {tree.map((s) => {
          const sKey = 'S' + s.src;
          const sOpen = !collapsed.has(sKey);
          return (
            <div key={s.src} className="tree-src">
              <div className="tree-row lvl0" onClick={() => toggle(sKey)}>
                <span className="caret">{sOpen ? '▾' : '▸'}</span>
                <i className="dot" style={{ background: SOURCE_COLOR[s.src] || '#888' }} />
                <span className="name">{s.label}</span>
                <span className="cnt">{s.count}</span>
              </div>

              {sOpen && s.projects.map((p) => {
                const pKey = sKey + '/' + p.project;
                const pOpen = !collapsed.has(pKey);
                return (
                  <div key={p.project}>
                    <div className="tree-row lvl1" onClick={() => toggle(pKey)} title={p.project}>
                      <span className="caret">{pOpen ? '▾' : '▸'}</span>
                      <span className="name">{shortProject(p.project)}</span>
                      <span className="cnt">{p.list.length}</span>
                    </div>

                    {pOpen && p.list.map((ss) => (
                      <div
                        key={ss.file}
                        className={'tree-row lvl2 session' + (ss.file === activeFile ? ' active' : '') + (newFiles?.has(ss.file) ? ' fresh' : '')}
                        onClick={() => onSelect(ss)}
                        title={ss.title}
                      >
                        <div className="t">{ss.title}</div>
                        <div className="m">
                          <span>{fmtDate(ss.end || ss.start)}</span>
                          <span>{ss.messages} msg</span>
                          {ss.tools > 0 && <span>{ss.tools} tool</span>}
                          {ss.subagents?.length > 0 && <span className="badge">{ss.subagents.length} sub</span>}
                          {newFiles?.has(ss.file) && <span className="badge live">new</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function shortProject(p) {
  const s = String(p).replace(/\\/g, '/');
  const parts = s.split('/').filter(Boolean);
  return parts.length <= 2 ? s : '…/' + parts.slice(-2).join('/');
}

function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString([], { day: '2-digit', month: 'short', year: '2-digit' });
}
