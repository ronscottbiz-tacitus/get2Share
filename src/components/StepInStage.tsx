import { useEffect, useRef, useState } from 'react';
import type { StepInFrame } from '../types';

/**
 * Plays a Step In / Step Out splat with a slow, controlled camera move.
 *
 *   kind="in"   the whole scene; the view is cropped a little so the splat's ragged
 *               edges never show (fills its box, like a photo with object-fit: cover)
 *   kind="out"  just the people, on a transparent background, centered on them
 *
 * The camera starts at the original photo's viewpoint and never swings far, because a
 * single-photo splat only holds up for small moves. PlayCanvas loads on first use, in
 * its own chunk, so it costs nothing for pages that never show a Step In.
 *
 * Splats from services/step-in are saved upright: y up, original camera at the origin
 * looking down +z. `frame` comes with them; without it the viewer measures the splat.
 */
export type StepInMotion = 'sway' | 'push' | 'drift';

interface Props {
  url: string;
  kind: 'in' | 'out';
  frame?: StepInFrame | null;
  /** How far the camera swings, in degrees. Single-photo splats hold up to about 15°. */
  amount?: number;
  /** Seconds per loop. */
  loop?: number;
  motion?: StepInMotion;
  /** Drag to look around. */
  interactive?: boolean;
  /** Cap on render resolution; TVs and older phones do better at 1–1.5. */
  maxPixelRatio?: number;
  className?: string;
  onReady?: () => void;
  onError?: (e: unknown) => void;
}

type Framing = { pivot: number; cx: number; cy: number; tanH: number; tanV: number };

export default function StepInStage({
  url, kind, frame, amount = 10, loop = 7, motion = 'sway', interactive = false,
  maxPixelRatio = 1.5, className = '', onReady, onError,
}: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);
  // Latest settings, read by the render loop without restarting it.
  const live = useRef({ amount, loop, motion, kind });
  live.current = { amount, loop, motion, kind };
  const cbs = useRef({ onReady, onError });
  cbs.current = { onReady, onError };

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let disposed = false;
    let app: any = null;
    let ro: ResizeObserver | null = null;
    const abort = new AbortController();
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
    box.appendChild(canvas);
    setReady(false);

    const drag = { yaw: 0, pitch: 0, active: false, endedAt: 0, last: null as null | [number, number] };
    const onDown = (e: PointerEvent) => { drag.active = true; drag.last = [e.clientX, e.clientY]; canvas.setPointerCapture(e.pointerId); };
    const onMove = (e: PointerEvent) => {
      if (!drag.last) return;
      const k = 50 / Math.max(240, canvas.clientWidth);
      drag.yaw = Math.max(-25, Math.min(25, drag.yaw - (e.clientX - drag.last[0]) * k));
      drag.pitch = Math.max(-15, Math.min(15, drag.pitch - (e.clientY - drag.last[1]) * k));
      drag.last = [e.clientX, e.clientY];
    };
    const onUp = () => { drag.active = false; drag.last = null; drag.endedAt = performance.now(); };
    if (interactive) {
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointermove', onMove);
      canvas.addEventListener('pointerup', onUp);
      canvas.addEventListener('pointercancel', onUp);
    }

    (async () => {
      try {
        const pc: any = await import('playcanvas');
        if (disposed) return;
        app = new pc.Application(canvas, { graphicsDeviceOptions: { alpha: true, antialias: false } });
        app.setCanvasFillMode(pc.FILLMODE_NONE);
        app.setCanvasResolution(pc.RESOLUTION_AUTO);
        app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
        app.start();

        const camera = new pc.Entity('camera');
        camera.addComponent('camera', { clearColor: new pc.Color(0, 0, 0, 0), fov: 50, nearClip: 0.01, farClip: 2000 });
        app.root.addChild(camera);

        const resize = () => {
          if (canvas.clientWidth && canvas.clientHeight) app.graphicsDevice.resizeCanvas(canvas.clientWidth, canvas.clientHeight);
        };
        ro = new ResizeObserver(resize);
        ro.observe(box);
        resize();

        const res = await fetch(url, { signal: abort.signal });
        if (!res.ok) throw new Error(`Step In file: ${res.status}`);
        if (disposed) return;
        const name = 'step-in.ply';
        const asset = new pc.Asset(name, 'gsplat', { url: name, filename: name, contents: res });
        let measured: Framing | null = null;
        asset.on('load:data', (data: any) => {
          if (!frame) { try { measured = measure(data, kind); } catch { /* use defaults */ } }
        });
        await new Promise<void>((resolve, reject) => {
          asset.on('load', () => resolve());
          asset.on('error', (e: unknown) => reject(e));
          app.assets.add(asset);
          app.assets.load(asset);
        });
        if (disposed) return;
        const entity = new pc.Entity('splat');
        entity.addComponent('gsplat', { asset });
        app.root.addChild(entity);

        const f: Framing = frame
          ? { pivot: frame.pivot, cx: frame.cx, cy: frame.cy, tanH: frame.tanH, tanV: frame.tanV }
          : measured || { pivot: 3, cx: 0, cy: 0, tanH: 0.6, tanV: 0.45 };
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const q = new pc.Quat(), off = new pc.Vec3(), pivot = new pc.Vec3();
        const t0 = performance.now();
        let shown = false;

        app.on('update', () => {
          const { amount: A0, loop: L, motion: M, kind: K } = live.current;
          const A = reduce ? 0 : A0;
          const t = ((performance.now() - t0) / 1000) / Math.max(2, L) * Math.PI * 2;
          let yaw = 0, pitch = 0, dolly = 1;
          if (M === 'push') { dolly = 1 - 0.14 * (0.5 - 0.5 * Math.cos(t)); yaw = A * 0.35 * Math.sin(t); pitch = A * 0.1 * (0.5 - 0.5 * Math.cos(t)); }
          else if (M === 'drift') { yaw = A * Math.sin(t); pitch = A * 0.45 * Math.sin(2 * t); }
          else { yaw = A * Math.sin(t); pitch = A * 0.18 * Math.sin(2 * t); }
          if (!drag.active && performance.now() - drag.endedAt > 1200) { drag.yaw *= 0.94; drag.pitch *= 0.94; }
          yaw += drag.yaw; pitch += drag.pitch;

          // Step In orbits a point straight ahead of the original camera; Step Out turns
          // toward the people and orbits their center.
          const d = f.pivot;
          if (K === 'out') pivot.set(f.cx * d, f.cy * d, d); else pivot.set(0, 0, d);
          q.setFromEulerAngles(pitch, yaw, 0);
          off.set(-pivot.x * dolly, -pivot.y * dolly, -d * dolly);
          q.transformVector(off, off);
          camera.setPosition(pivot.x + off.x, pivot.y + off.y, pivot.z + off.z);
          camera.lookAt(pivot);

          const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
          const tan = K === 'out'
            ? Math.max(f.tanV, f.tanH / aspect) * (1.12 + A / 120)
            : Math.min(f.tanV, f.tanH / aspect) * Math.max(0.62, 0.95 - A / 140);
          camera.camera.fov = (2 * Math.atan(tan) * 180) / Math.PI;

          if (!shown) { shown = true; requestAnimationFrame(() => { if (!disposed) { setReady(true); cbs.current.onReady?.(); } }); }
        });
      } catch (e) {
        if (!disposed) cbs.current.onError?.(e);
      }
    })();

    return () => {
      disposed = true;
      abort.abort();
      ro?.disconnect();
      try { app?.destroy(); } catch { /* already gone */ }
      canvas.remove();
    };
  }, [url, kind, frame?.pivot, interactive, maxPixelRatio]);

  return (
    <div
      ref={boxRef}
      className={`absolute inset-0 transition-opacity duration-500 ${ready ? 'opacity-100' : 'opacity-0'} ${interactive ? 'cursor-grab active:cursor-grabbing' : ''} ${className}`}
      aria-hidden={!interactive}
    />
  );
}

/** Framing from the splat itself, for files without hints. Same rules as services/step-in. */
function measure(data: any, kind: 'in' | 'out'): Framing | null {
  const d = data.isCompressed && typeof data.decompress === 'function' ? data.decompress() : data;
  const xs: Float32Array = d.getProp('x'), ys: Float32Array = d.getProp('y'), zs: Float32Array = d.getProp('z');
  const n = zs.length, step = Math.max(1, Math.floor(n / 40000));
  const z: number[] = [], tx: number[] = [], ty: number[] = [];
  for (let i = 0; i < n; i += step) if (zs[i] > 0.05) { z.push(zs[i]); tx.push(xs[i] / zs[i]); ty.push(ys[i] / zs[i]); }
  if (z.length < 50) return null;
  const pct = (a: number[], p: number) => { const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]; };
  const centered = kind === 'out';
  const cx = centered ? pct(tx, 0.5) : 0, cy = centered ? pct(ty, 0.5) : 0;
  return {
    pivot: Math.max(0.3, pct(z, centered ? 0.5 : 0.35)), cx, cy,
    tanH: Math.min(2.5, pct(tx.map((v) => Math.abs(v - cx)), 0.97)),
    tanV: Math.min(2.5, pct(ty.map((v) => Math.abs(v - cy)), 0.97)),
  };
}
