import React, { useEffect, useMemo, useRef, useState } from 'react';
import { KIND_STYLE, styleOf } from '../kinds.js';

const TRAIL = 1.0;
const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DEG = Math.PI / 180;

/** Cuts a name down to the room it has; 0.56·fs is the average glyph width here. */
const fit = (text, fs, room) => {
  const max = Math.max(5, Math.floor(room / (fs * 0.56)));
  return text.length <= max ? text : text.slice(0, max - 1) + '…';
};

/**
 * Radial layout: the main agent holds the middle, You and the sub-agents ride a
 * ring around it, each with its own capabilities fanned out on the far side.
 *
 * Every size is derived from the room one slot of the ring actually gets, so the
 * drawing shrinks instead of spilling: 4 sub-agents get fat circles, 40 get small
 * ones, and both fit the viewport at 100% — nothing scrolls.
 */
function layout(nodes, w, h) {
  const pos = {};
  const agents = nodes.filter((n) => n.type === 'agent');
  const caps = nodes.filter((n) => n.type === 'capability');
  const capsOf = (owner) => caps.filter((c) => c.owner === owner);
  const cx = w / 2, cy = h / 2;

  // You takes the first slot (due west), everyone else follows around the ring
  const ring = [
    ...agents.filter((a) => a.id === 'user'),
    ...agents.filter((a) => a.id !== 'user' && a.id !== 'orchestrator'),
  ];
  const n = Math.max(ring.length, 1);

  /**
   * The frame kept free for names depends on the node sizes, which depend on the
   * ring radius, which depends on the frame — three passes settle it.
   * `s` shrinks the whole vocabulary on a small window: without it the ceilings
   * below stay big, the frame eats the radius, and the ring runs off the edge.
   */
  const s = clamp(Math.min(w, h) / 700, 0.5, 1);
  const nameRoom = clamp(w * 0.12, 86, 180); // horizontal room kept for a name beside a node
  let m = {};
  let padX = 130, padY = 50;
  for (let pass = 0; pass < 3; pass++) {
    const rx = Math.max(50, w / 2 - padX);
    const ry = Math.max(40, h / 2 - padY);
    // arc per slot, measured on the tight axis of the ellipse: the worst case
    const half = (Math.PI * Math.min(rx, ry)) / n;
    const cap = clamp(half * 0.16, 3.5, 10 * s);
    const orb = Math.max(11 * s, Math.min(clamp(half * 0.55, 15 * s, 46 * s), half - cap - 3));
    const node = Math.min(clamp(half * 0.26, 5.5, 20 * s), Math.max(5.5, orb - cap - 5));
    const fs = clamp(node * 0.78, 8, 13 * s);
    m = { rx, ry, half, cap, orb, node, fs, reach: orb + cap + 8 };
    padX = m.reach + nameRoom + 10;
    padY = m.reach + m.fs + 8;
  }
  const { rx, ry, half, cap: capR, orb, node: nodeR, fs } = m;

  const orch = agents.find((a) => a.id === 'orchestrator');
  const orchR = clamp(Math.min(rx, ry) * 0.1, 15, 26);
  const orchFs = clamp(orchR * 0.6, 10, 14);
  pos.orchestrator = {
    x: cx, y: cy, r: orchR, fs: orchFs,
    lab: {
      x: cx, y: cy + orchR + 14 + orchFs, anchor: 'middle', sy: cy + orchR + 28 + orchFs,
      text: fit(orch?.label || 'Main Agent', orchFs, 150),
    },
  };

  // its capabilities ring it, with a gap left at the bottom for the name
  const ocaps = capsOf('orchestrator');
  const ocapR = clamp(Math.min(rx, ry) * 0.05, 7, 11);
  const oOrb = orchR + ocapR + clamp(Math.min(rx, ry) * 0.09, 20, 34);
  ocaps.forEach((c, i) => {
    // 120°…420°: the 60° left free at the bottom is where the agent's own name goes
    const a = (120 + ((i + 0.5) * 300) / ocaps.length) * DEG;
    pos[c.id] = { x: cx + Math.cos(a) * oOrb, y: cy + Math.sin(a) * oOrb, r: c.capability === 'skill' ? ocapR - 1 : ocapR };
  });

  ring.forEach((nd, i) => {
    const a = Math.PI + (i * TAU) / n;
    const x = cx + Math.cos(a) * rx;
    const y = cy + Math.sin(a) * ry;
    const r = nd.id === 'user' ? nodeR * 1.35 + 2 : nodeR;

    // outward direction: on an ellipse it is not the slot angle, so take it from the point
    const len = Math.hypot(x - cx, y - cy) || 1;
    const ux = (x - cx) / len, uy = (y - cy) / len;

    const list = capsOf(nd.id);
    const out = list.length ? orb + capR + 8 : r + 8;
    // near the sides a name reads better beside the node than under it
    const side = Math.abs(ux) > 0.45;
    const lab = side
      ? { x: x + ux * out, y: y + fs * 0.36, anchor: ux > 0 ? 'start' : 'end', sy: y + fs * 0.36 + fs + 2 }
      : uy > 0
        ? { x, y: y + out + fs, anchor: 'middle', sy: y + out + 2 * fs + 3 }
        : { x, y: y - out - 4, anchor: 'middle', sy: y - out - 6 - fs };
    lab.text = fit(nd.label, fs, side ? nameRoom : clamp(half * 2.4, 84, 200));
    pos[nd.id] = { x, y, r, fs: nd.id === 'user' ? fs + 1 : fs, lab };

    // capabilities fan out away from the centre, so they never fall on the edges;
    // the fan closes as the slots tighten, so it stops short of the next agent's
    const base = Math.atan2(uy, ux);
    const span = clamp(Math.asin(clamp((half - capR - 1) / orb, 0.1, 1)), 18 * DEG, 62 * DEG);
    // on a fan that has closed, the squares shrink too instead of piling up
    const step = list.length > 1 ? (2 * span) / (list.length - 1) : 0;
    const cr = Math.max(1.5, list.length > 1 ? Math.min(capR, orb * Math.sin(step / 2)) : capR);
    list.forEach((c, j) => {
      const t = list.length === 1 ? 0.5 : j / (list.length - 1);
      const ca = base + (2 * t - 1) * span;
      pos[c.id] = { x: x + Math.cos(ca) * orb, y: y + Math.sin(ca) * orb, r: c.capability === 'skill' ? cr - 0.5 : cr };
    });
  });

  // anything left over (a capability whose owner never got a slot)
  caps.forEach((c) => {
    if (!pos[c.id]) pos[c.id] = { x: cx, y: cy - orchR - 20, r: capR };
  });

  return pos;
}

export default function GraphView({ graph, cursor }) {
  const boxRef = useRef(null);
  const [size, setSize] = useState({ w: 1000, h: 600 });
  const [hover, setHover] = useState(null);
  // collapsed by default: the ring reaches into the bottom-right corner, and an
  // open legend sits on top of whichever sub-agents land there
  const [legendOpen, setLegendOpen] = useState(false);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width > 0 && height > 0) setSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w, h } = size;
  const nodes = graph?.nodes || [];
  const events = graph?.events || [];
  const pos = useMemo(() => layout(nodes, w, h), [nodes, w, h]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const { edges, activity } = useMemo(() => {
    const map = new Map();
    const act = {};
    const upto = Math.min(events.length - 1, Math.floor(cursor));
    for (let i = 0; i <= upto; i++) {
      const e = events[i];
      if (e.from === e.to) continue;
      const key = e.from + '|' + e.to;
      const cur = map.get(key);
      if (cur) { cur.n++; if (styleOf(e.kind).agent) cur.agentEdge = true; }
      else map.set(key, { from: e.from, to: e.to, n: 1, kind: e.kind, agentEdge: styleOf(e.kind).agent });
      const rec = cursor - i;
      if (rec < 6) {
        act[e.from] = Math.max(act[e.from] || 0, 1 - rec / 6);
        act[e.to] = Math.max(act[e.to] || 0, 1 - rec / 6);
      }
    }
    return { edges: [...map.values()], activity: act };
  }, [events, cursor]);

  const packets = useMemo(() => {
    const out = [];
    const end = Math.min(events.length - 1, Math.floor(cursor));
    for (let i = Math.max(0, end - 3); i <= end; i++) {
      const e = events[i];
      const p = (cursor - i) / TRAIL;
      if (p < 0 || p > 1) continue;
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      const st = styleOf(e.kind);
      if (e.from === e.to) {
        const ang = p * Math.PI * 2 - Math.PI / 2;
        out.push({ key: i, x: a.x + Math.cos(ang) * (a.r + 13), y: a.y + Math.sin(ang) * (a.r + 13), color: st.color, p });
      } else {
        out.push({ key: i, x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, color: st.color, p, big: st.agent });
      }
    }
    return out;
  }, [events, cursor, pos]);

  const usedCaps = useMemo(() => {
    const m = new Map();
    for (const n of nodes) if (n.type === 'capability' && !m.has(n.capability)) m.set(n.capability, n);
    return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [nodes]);

  if (!graph) return null;
  const maxN = Math.max(1, ...edges.map((e) => e.n));

  const dimmed = (id) => {
    if (!hover || id === hover) return false;
    const n = nodeById.get(id);
    if (n?.type === 'capability' && n.owner === hover) return false;
    const hv = nodeById.get(hover);
    if (hv?.type === 'capability' && hv.owner === id) return false;
    return true;
  };

  return (
    <div className="stage" ref={boxRef}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="glow">
            <stop offset="0%" stopColor="#fff" stopOpacity=".26" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>

        <g>
          {edges.map((e) => {
            const a = pos[e.from], b = pos[e.to];
            if (!a || !b) return null;
            const t = e.n / maxN;
            const st = styleOf(e.kind);
            const dim = dimmed(e.from) && dimmed(e.to);
            return (
              <g key={e.from + '>' + e.to} opacity={dim ? 0.08 : 1}>
                <line
                  x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                  stroke={e.agentEdge ? st.color : '#2b3547'}
                  strokeWidth={e.agentEdge ? 1.6 + t * 2.6 : 1 + t * 2}
                  strokeOpacity={e.agentEdge ? 0.5 : 0.3 + t * 0.35}
                  strokeDasharray={e.kind === 'message' ? '5 4' : undefined}
                />
                {e.n > 1 && (
                  <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 5} fill="#5a6a85" fontSize="9.5" textAnchor="middle">
                    {e.n}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        <g>
          {packets.map((pk) => (
            <g key={pk.key}>
              <circle cx={pk.x} cy={pk.y} r={pk.big ? 14 : 10} fill={pk.color} opacity={0.16 * (1 - pk.p)} />
              <circle cx={pk.x} cy={pk.y} r={pk.big ? 6 : 4.5} fill={pk.color} opacity={0.95 - pk.p * 0.35} />
            </g>
          ))}
        </g>

        {/* capabilities: squares for tools, a smaller circle for skills */}
        <g>
          {nodes.filter((n) => n.type === 'capability').map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const a = activity[n.id] || 0;
            const isSkill = n.capability === 'skill';
            const isOrch = n.owner === 'orchestrator';
            return (
              <g key={n.id} opacity={dimmed(n.id) ? 0.18 : 1}
                onMouseEnter={() => setHover(n.owner)} onMouseLeave={() => setHover(null)}>
                {a > 0 && <circle cx={p.x} cy={p.y} r={p.r + 14 * a} fill="url(#glow)" />}
                {isSkill ? (
                  <>
                    <circle cx={p.x} cy={p.y} r={p.r} fill="#05070b" stroke={n.color} strokeWidth={1.6} strokeOpacity={0.5 + a * 0.5} />
                    <circle cx={p.x} cy={p.y} r={p.r - 3} fill={n.color} opacity={0.14 + a * 0.5} />
                  </>
                ) : (
                  <>
                    <rect x={p.x - p.r} y={p.y - p.r} width={p.r * 2} height={p.r * 2} rx={3}
                      fill="#05070b" stroke={n.color} strokeWidth={1.4} strokeOpacity={0.45 + a * 0.55} />
                    <rect x={p.x - p.r + 3} y={p.y - p.r + 3} width={p.r * 2 - 6} height={p.r * 2 - 6} rx={2}
                      fill={n.color} opacity={0.12 + a * 0.5} />
                  </>
                )}
                {isOrch && (
                  <text x={p.x} y={p.y - p.r - 6} textAnchor="middle" fill={n.color} fontSize={clamp(p.r, 8.5, 11)}
                    style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 3 }}>
                    {n.label}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        <g>
          {nodes.filter((n) => n.type === 'agent').map((n) => {
            const p = pos[n.id];
            if (!p) return null;
            const a = activity[n.id] || 0;
            const lab = p.lab;
            return (
              <g key={n.id} opacity={dimmed(n.id) ? 0.25 : 1} style={{ cursor: 'pointer' }}
                onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)}>
                {a > 0 && <circle cx={p.x} cy={p.y} r={p.r + 24 * a} fill="url(#glow)" />}
                <circle cx={p.x} cy={p.y} r={p.r} fill="#05070b" stroke={n.color}
                  strokeWidth={n.id === 'user' ? 3 : 2} strokeOpacity={0.55 + a * 0.45} />
                <circle cx={p.x} cy={p.y} r={Math.max(2, p.r - 6)} fill={n.color} opacity={0.12 + a * 0.38} />
                {/* the name sits on the far side of the ring, clear of the capabilities */}
                <text
                  x={lab.x} y={lab.y} textAnchor={lab.anchor}
                  fill={n.color} fontSize={p.fs}
                  fontWeight={n.id === 'user' ? 700 : n.kind === 'subagent' ? 600 : 500}
                  style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 3 }}
                >
                  {lab.text}
                </text>
                {n.sub && p.fs >= 10 && (
                  <text x={lab.x} y={lab.sy} textAnchor={lab.anchor} fill="#66748a" fontSize="9.5"
                    style={{ paintOrder: 'stroke', stroke: '#000', strokeWidth: 3 }}>
                    {fit(n.sub, 9.5, 96)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      <div className={'legend' + (legendOpen ? '' : ' closed')}>
        <button className="lg-toggle" onClick={() => setLegendOpen(!legendOpen)}>
          {legendOpen ? '▾ legend' : '▸ legend'}
        </button>
        {legendOpen && (
          <>
            <div className="lg-title">between agents</div>
            {Object.entries(KIND_STYLE).filter(([, v]) => v.agent).map(([k, v]) => (
              <div key={k}><i style={{ background: v.color }} />{v.label}</div>
            ))}
            <div className="lg-title">executions</div>
            {Object.entries(KIND_STYLE).filter(([, v]) => !v.agent).map(([k, v]) => (
              <div key={k}><i style={{ background: v.color }} />{v.label}</div>
            ))}
            {usedCaps.length > 0 && (
              <>
                <div className="lg-title">capabilities</div>
                {usedCaps.map((c) => (
                  <div key={c.capability}>
                    <i className={c.capability === 'skill' ? '' : 'sq'} style={{ background: c.color }} />
                    {c.label}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
