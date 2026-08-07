import React, { useEffect, useRef } from 'react';
import { styleOf } from '../kinds.js';

/** Current message, pinned at the top: agent name above, 5 lines with scroll. */
export default function MessagePanel({ current, nodes }) {
  const bodyRef = useRef(null);

  // every new message is read from the top
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [current]);

  if (!current) return null;
  const st = styleOf(current.kind);

  return (
    <div className="msgbar" style={{ borderLeftColor: st.color }}>
      <div className="mb-head">
        <i style={{ background: st.color }} />
        <b>{labelOf(nodes, current.from)}</b>
        <span className="arrow">→</span>
        <span className="to">{labelOf(nodes, current.to)}</span>
        <span className="kindtag" style={{ color: st.color, borderColor: st.color }}>
          {st.label}
        </span>
        {current.tool && <span className="tool">{current.tool}</span>}
        <span className="t">{fmtTime(current.ts)}</span>
      </div>
      <pre className="mb-body" ref={bodyRef}>
        {current.detail || current.label}
      </pre>
    </div>
  );
}

function labelOf(nodes, id) {
  const n = (nodes || []).find((x) => x.id === id);
  return n ? n.label : id;
}

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}
