import type { ObservedPoint } from '../src/rules/types.js';

export const ORIGIN = { lat: -34.6037, lon: -58.3816 }; // Obelisco, Buenos Aires
const M_PER_DEG_LAT = 111_195.08;
export const mPerDegLon = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);

/** Desplaza (este, norte) en metros desde un punto. */
export function offset(p: { lat: number; lon: number }, eastM: number, northM: number) {
  return { lat: p.lat + northM / M_PER_DEG_LAT, lon: p.lon + eastM / mPerDegLon(p.lat) };
}

export class TrackBuilder {
  points: ObservedPoint[] = [];
  private id = 1;
  private seq = 0;
  constructor(
    public t: number = Date.UTC(2026, 9, 27, 12, 0, 0),
    public pos: { lat: number; lon: number } = ORIGIN,
    public sessionId = 'session-1',
  ) {}

  add(extra: Partial<ObservedPoint> = {}) {
    this.points.push({
      id: this.id++,
      sessionId: this.sessionId,
      seq: this.seq++,
      t: this.t,
      lat: this.pos.lat,
      lon: this.pos.lon,
      accuracy: 8,
      speed: null,
      heading: null,
      flags: [],
      ...extra,
    });
    return this;
  }

  /** Avanza en línea recta: n puntos cada dtS segundos a speedMps en el rumbo (este=90, norte=0). */
  move(n: number, dtS: number, speedMps: number, bearing = 90, extra: Partial<ObservedPoint> = {}) {
    const rad = (bearing * Math.PI) / 180;
    for (let i = 0; i < n; i++) {
      this.t += dtS * 1000;
      const d = speedMps * dtS;
      this.pos = offset(this.pos, d * Math.sin(rad), d * Math.cos(rad));
      this.add({ speed: speedMps, ...extra });
    }
    return this;
  }

  /** Queda quieto con ruido de ±jitterM. */
  stay(n: number, dtS: number, jitterM = 5) {
    const base = this.pos;
    for (let i = 0; i < n; i++) {
      this.t += dtS * 1000;
      const j = ((i % 3) - 1) * jitterM;
      this.pos = offset(base, j, -j);
      this.add({ speed: 0 });
    }
    this.pos = base;
    return this;
  }

  wait(s: number) {
    this.t += s * 1000;
    return this;
  }

  jumpTo(p: { lat: number; lon: number }) {
    this.pos = p;
    return this;
  }

  session(id: string) {
    this.sessionId = id;
    this.seq = 0;
    return this;
  }
}
