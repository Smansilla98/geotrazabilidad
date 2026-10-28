import { useEffect, useMemo, useRef, useState } from 'react';
import type { TrackResponse, TrackingEventDto } from '@geo/shared';
import { EVENT_COLOR, EVENT_LABEL, fmtDateTime, fmtSpeed, fmtTime } from '../lib/format';
import type { FlatPoint } from '../lib/geojson';

const SPEEDS = [1, 10, 60, 300, 1200];

/**
 * Reproductor temporal. Avanza un reloj virtual sobre el rango observado. El gráfico muestra la
 * velocidad registrada (con cortes en los huecos), las detenciones sombreadas y los eventos.
 */
export function Timeline({
  track,
  flat,
  events,
  t,
  setT,
  onSelectEvent,
}: {
  track?: TrackResponse;
  flat: FlatPoint[];
  events: TrackingEventDto[];
  t: number | null;
  setT: (t: number) => void;
  onSelectEvent: (e: TrackingEventDto) => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(60);
  const start = flat[0]?.t ?? 0;
  const end = flat.at(-1)?.t ?? 0;
  const tRef = useRef(t ?? start);
  tRef.current = t ?? start;

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const next = Math.min(end, tRef.current + (now - last) * speed);
      last = now;
      setT(next);
      if (next >= end) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end, setT]);

  const W = 1000;
  const H = 80;
  const x = (v: number) => ((v - start) / Math.max(1, end - start)) * W;
  const maxSpeed = Math.max(5, ...flat.map((p) => p.speed ?? 0));
  const speedPaths = useMemo(() => {
    const paths: string[] = [];
    let cur = '';
    let seg = -1;
    for (const p of flat) {
      if (p.speed == null) continue;
      const cmd = `${x(p.t).toFixed(1)},${(H - (p.speed / maxSpeed) * (H - 8)).toFixed(1)}`;
      if (p.segment !== seg) {
        if (cur) paths.push(cur);
        cur = `M${cmd}`;
        seg = p.segment;
      } else cur += ` L${cmd}`;
    }
    if (cur) paths.push(cur);
    return paths;
  }, [flat, maxSpeed, start, end]);

  if (!flat.length) return <div className="timeline empty muted">Sin posiciones en el rango seleccionado.</div>;
  const gaps = track?.segments.filter((s) => s.kind === 'gap') ?? [];
  const stops = events.filter((e) => e.type === 'stop');
  const cur = t ?? start;
  const step = (dir: number) => {
    const i = flat.findIndex((p) => p.t > cur);
    const idx = dir > 0 ? (i < 0 ? flat.length - 1 : i) : Math.max(0, (i < 0 ? flat.length : i) - 2);
    setT(flat[idx]!.t);
  };

  return (
    <div className="timeline">
      <div className="player-controls">
        <button className="btn small" onClick={() => setT(start)} title="Al inicio" aria-label="Al inicio">
          ⏮
        </button>
        <button className="btn small" onClick={() => step(-1)} title="Punto anterior" aria-label="Punto anterior">
          ◀
        </button>
        <button className="btn primary small" onClick={() => (cur >= end ? (setT(start), setPlaying(true)) : setPlaying((p) => !p))} aria-label={playing ? 'Pausar' : 'Reproducir'}>
          {playing ? '❚❚ Pausa' : '▶ Reproducir'}
        </button>
        <button className="btn small" onClick={() => step(1)} title="Punto siguiente" aria-label="Punto siguiente">
          ▶
        </button>
        <label className="inline">
          Velocidad
          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                ×{s}
              </option>
            ))}
          </select>
        </label>
        <span className="clock" title="Hora local del navegador">
          {fmtDateTime(cur)}
        </span>
        <span className="muted small">
          {fmtTime(start)} – {fmtTime(end)} · máx. {fmtSpeed(maxSpeed)}
        </span>
      </div>
      <svg
        className="speed-chart"
        viewBox={`0 0 ${W} ${H + 14}`}
        preserveAspectRatio="none"
        role="slider"
        aria-label="Línea de tiempo"
        aria-valuemin={start}
        aria-valuemax={end}
        aria-valuenow={cur}
        onClick={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          setT(start + ((e.clientX - r.left) / r.width) * (end - start));
        }}
      >
        {stops.map((s) => (
          <rect key={s.id} x={x(Date.parse(s.occurredAt))} width={Math.max(2, x(Date.parse(s.endedAt ?? new Date(end).toISOString())) - x(Date.parse(s.occurredAt)))} y={0} height={H} fill="#fde68a" opacity={0.6}>
            <title>Detención</title>
          </rect>
        ))}
        {gaps.map((g, i) => (
          <rect key={i} x={x(Date.parse(g.startAt))} width={Math.max(2, x(Date.parse(g.endAt)) - x(Date.parse(g.startAt)))} y={0} height={H} fill="url(#hatch)">
            <title>Sin datos</title>
          </rect>
        ))}
        <defs>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="#ede9fe" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="#a78bfa" strokeWidth="2" />
          </pattern>
        </defs>
        {speedPaths.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#0f766e" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        ))}
        {events.map((e) => (
          <g key={e.id} onClick={(ev) => (ev.stopPropagation(), onSelectEvent(e))} style={{ cursor: 'pointer' }}>
            <rect x={x(Date.parse(e.occurredAt)) - 1} y={H} width={3} height={14} fill={EVENT_COLOR[e.type]}>
              <title>
                {EVENT_LABEL[e.type]} · {fmtTime(e.occurredAt)}
              </title>
            </rect>
          </g>
        ))}
        <line x1={x(cur)} x2={x(cur)} y1={0} y2={H + 14} stroke="#111827" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>
      <input
        className="scrubber"
        type="range"
        min={start}
        max={end}
        step={1000}
        value={cur}
        onChange={(e) => {
          setPlaying(false);
          setT(Number(e.target.value));
        }}
        aria-label="Seleccionar momento"
      />
    </div>
  );
}
