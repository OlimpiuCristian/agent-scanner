import React, { useEffect, useRef } from 'react';
import { KIND_STYLE } from '../kinds.js';

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

export default function Timeline({ events, cursor, setCursor, playing, setPlaying, speed, setSpeed, follow, setFollow }) {
  const stripRef = useRef(null);
  const canvasRef = useRef(null);
  const total = events.length;

  /* event strip: one coloured tick per event */
  useEffect(() => {
    const cv = canvasRef.current;
    const box = stripRef.current;
    if (!cv || !box || !total) return;

    const draw = () => {
      const w = box.clientWidth;
      const h = box.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      cv.width = w * dpr;
      cv.height = h * dpr;
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const bw = Math.max(1, w / total);
      events.forEach((e, i) => {
        const st = KIND_STYLE[e.kind] || KIND_STYLE.call;
        ctx.fillStyle = st.color;
        ctx.globalAlpha = e.kind === 'think' ? 0.35 : 0.8;
        const x = (i / total) * w;
        // tick height shows direction: tall = exchange with you, short = tool work
        const up = e.to === 'user' || e.from === 'user';
        const bh = up ? h * 0.9 : h * 0.5;
        ctx.fillRect(x, up ? h - bh : h * 0.25, Math.max(1, bw - 0.3), bh);
      });
      ctx.globalAlpha = 1;
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(box);
    return () => ro.disconnect();
  }, [events, total]);

  /* playback loop */
  useEffect(() => {
    if (!playing || !total) return;
    let raf;
    let last = performance.now();
    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setCursor((c) => Math.min(total - 1, c + dt * speed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, total, setCursor]);

  // stopping at the end happens here, not inside the state updater (that runs during render)
  useEffect(() => {
    if (playing && total && cursor >= total - 1) setPlaying(false);
  }, [playing, cursor, total, setPlaying]);

  const seek = (clientX) => {
    const r = stripRef.current.getBoundingClientRect();
    const p = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setCursor(p * (total - 1));
  };

  const onDown = (e) => {
    seek(e.clientX);
    const move = (ev) => seek(ev.clientX);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const idx = Math.min(total - 1, Math.floor(cursor));
  const cur = events[idx];
  const pct = total > 1 ? (cursor / (total - 1)) * 100 : 0;

  const step = (d) => {
    setPlaying(false);
    setCursor((c) => Math.min(total - 1, Math.max(0, Math.floor(c) + d)));
  };

  return (
    <div className="timeline">
      <div className="tl-controls">
        <button className="primary" onClick={() => (cursor >= total - 1 ? (setCursor(0), setPlaying(true)) : setPlaying(!playing))}>
          {playing ? '❚❚ Pause' : cursor >= total - 1 ? '↻ Replay' : '▶ Run'}
        </button>
        <button onClick={() => step(-1)} disabled={cursor <= 0}>◀</button>
        <button onClick={() => step(1)} disabled={cursor >= total - 1}>▶</button>
        <button onClick={() => { setPlaying(false); setCursor(0); }}>⏮ Start</button>

        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))} title="events per second">
          {SPEEDS.map((s) => (
            <option key={s} value={s}>{s}× speed</option>
          ))}
        </select>

        <label className="live" title="keep the open session on its newest event">
          <input type="checkbox" checked={!!follow} onChange={(e) => setFollow?.(e.target.checked)} />
          Follow latest
        </label>

        <span className="tl-time">
          {idx + 1} / {total} · {fmtClock(cur?.ts)}
        </span>
      </div>

      <div className="strip" ref={stripRef} onMouseDown={onDown}>
        <canvas ref={canvasRef} />
        <div className="cursor" style={{ left: pct + '%' }} />
      </div>
    </div>
  );
}

function fmtClock(ts) {
  if (!ts) return '--:--:--';
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}
