// components/BartAvatar.tsx
//
// BartAvatar build (2026-06-10) — Bart's "living orb" presence.
//
// ~850 particles fibonacci-distributed on a unit sphere, rendered with
// pure Canvas 2D + additive compositing. No three.js, no animation
// libraries, no shadowBlur (perf). The orb is always alive: breath from
// three incommensurate sines, a randomized lub-dub heartbeat, gaze that
// drifts on a smoothed random walk, and a handful of stray particles
// that wander off-sphere and return. State props layer distinct motion
// signatures on top of the idle life.
//
// Audio reactivity: while `talking`, the level comes from the shared
// voice tap (lib/voice-tap.ts — both ARGOS playback paths route through
// it, so ElevenLabs/F5/Piper all drive the orb identically). An optional
// audioEl prop supports HTMLAudioElement paths via a one-time
// createMediaElementSource binding. With neither, a synthetic envelope
// (|sin·sin|) stands in.
//
// The RAF loop pauses on document.hidden and resumes on visibilitychange.
// Perf stats are exposed at window.__bartAvatarStats for measurement.

"use client";

import { useEffect, useRef } from "react";
import {
  attachMediaElementTap,
  getVoiceLevel,
  readAnalyserLevel,
} from "@/lib/voice-tap";

// ---------- palette ----------
const BG = "#0a0e14";
const BASE = { r: 0xd8, g: 0x86, b: 0x22 }; // #D88622
const HOT = { r: 0xfa, g: 0xc7, b: 0x75 }; // #FAC775
const CORE = { r: 0xef, g: 0x9f, b: 0x27 }; // #EF9F27
const ALERT = { r: 0xe2, g: 0x4b, b: 0x4a }; // #E24B4A

const PARTICLE_COUNT = 850;
const STRAY_COUNT = 14;
const FOCAL = 1.6;

// Easing doctrine: fast onset, slow settle.
const EASE_IN = 0.15;
const EASE_OUT = 0.025;

interface Particle {
  // unit-sphere position
  x: number;
  y: number;
  z: number;
  size: number; // 0.6 - 2.0
  phase: number;
  flickerFreq: number; // Hz, independent per particle
  hot: boolean;
  // stray state: 0 = on-sphere, 1 = wandering, 2 = returning
  strayState: number;
  strayUntil: number; // time the wander ends
  strayNext: number; // next scheduled departure
  strayAmp: number; // current off-sphere displacement amplitude
  // wander noise: three random-frequency sines per axis
  wf1: number;
  wf2: number;
  wf3: number;
}

interface Ring {
  tiltX: number;
  tiltZ: number;
  radius: number; // in units of orb radius
  speed: number; // rad/s spin of the ring's own phase
  phase: number;
  alpha: number;
}

export interface BartAvatarProps {
  talking?: boolean;
  thinking?: boolean;
  toolRunning?: boolean;
  alert?: boolean;
  listening?: boolean;
  audioEl?: HTMLAudioElement;
  /** CSS pixel size of the square canvas. Default 200 (matches Eye). */
  size?: number;
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Asymmetric exponential approach: fast when rising, slow when falling. */
function ease(current: number, target: number, up = EASE_IN, down = EASE_OUT): number {
  return current + (target - current) * (target > current ? up : down);
}

export function BartAvatar({
  talking = false,
  thinking = false,
  toolRunning = false,
  alert = false,
  listening = false,
  audioEl,
  size = 200,
}: BartAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Props are read inside the RAF loop via a ref so prop changes don't
  // tear down and restart the animation.
  const propsRef = useRef({ talking, thinking, toolRunning, alert, listening });
  propsRef.current = { talking, thinking, toolRunning, alert, listening };

  const audioElRef = useRef<HTMLAudioElement | undefined>(audioEl);
  audioElRef.current = audioEl;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;

    const cx = size / 2;
    const cy = size / 2;
    const baseR = size * 0.32;

    // ---------- particles (fibonacci sphere) ----------
    const particles: Particle[] = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const theta = golden * i;
      particles.push({
        x: Math.cos(theta) * r,
        y,
        z: Math.sin(theta) * r,
        size: 0.6 + Math.random() * 1.4,
        phase: Math.random() * Math.PI * 2,
        flickerFreq: 0.4 + Math.random() * 2.2,
        hot: Math.random() < 0.18,
        strayState: 0,
        strayUntil: 0,
        strayNext: 0,
        strayAmp: 0,
        wf1: 0.5 + Math.random() * 1.5,
        wf2: 0.3 + Math.random() * 1.0,
        wf3: 0.2 + Math.random() * 0.8,
      });
    }
    // Designate strays and stagger their first departures.
    const strayIdx: number[] = [];
    while (strayIdx.length < STRAY_COUNT) {
      const i = Math.floor(Math.random() * PARTICLE_COUNT);
      if (!strayIdx.includes(i)) strayIdx.push(i);
    }
    for (const i of strayIdx) particles[i].strayNext = 1 + Math.random() * 10;

    // ---------- rings ----------
    const rings: Ring[] = [];
    for (let i = 0; i < 5; i++) {
      rings.push({
        tiltX: (Math.random() - 0.5) * 1.6,
        tiltZ: (Math.random() - 0.5) * 1.2,
        radius: 1.12 + i * 0.09 + Math.random() * 0.04,
        speed: (Math.random() < 0.5 ? -1 : 1) * (0.08 + Math.random() * 0.15),
        phase: Math.random() * Math.PI * 2,
        alpha: 0.10 + Math.random() * 0.06,
      });
    }

    // ---------- mutable animation state ----------
    let t = 0; // animated seconds (excludes hidden time)
    let lastNow: number | null = null;
    let rotY = Math.random() * Math.PI * 2;
    let rotSpeed = 0.25; // rad/s, current
    let rotSpeedTarget = 0.25;
    let tiltX = 0.15;
    let tiltXTarget = 0.15;
    let nextRetarget = 2 + Math.random() * 4;

    // heartbeat
    let nextBeat = 1.5 + Math.random() * 1.5;
    let beatT = -10; // time of last beat onset

    // smoothed signals
    let level = 0; // voice level
    let thinkAmt = 0;
    let toolAmt = 0;
    let listenAmt = 0;
    let flare = 0; // alert flare 0..1
    let prevAlert = false;
    let cursorPull = 0; // 0..1 pointer-near-orb engagement

    // pointer
    let px = -9999;
    let py = -9999;
    let pointerIn = false;

    // wobble phases (incommensurate so X wobble never loops with Y spin)
    const wob1 = Math.random() * 10;
    const wob2 = Math.random() * 10;

    // perf stats
    let frames = 0;
    let frameMsSum = 0;
    let statWindowStart = 0;

    const onMove = (e: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      // rect tracks CSS transforms (ChatPane scales to 75% mid-chat)
      px = ((e.clientX - rect.left) / rect.width) * size;
      py = ((e.clientY - rect.top) / rect.height) * size;
      pointerIn = true;
    };
    const onLeave = () => {
      pointerIn = false;
    };
    // Listen on window so the orb reacts as the cursor approaches,
    // not only once it's already inside the small canvas.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerleave", onLeave);

    let raf = 0;
    let running = true;

    // All per-frame work lives here; RAF scheduling stays in frame() so
    // the bench hook below can drive frames synchronously for perf
    // measurement in environments where RAF is throttled (hidden tabs,
    // headless preview).
    const renderFrame = (now: number) => {
      const frameStart = performance.now();
      if (lastNow === null) lastNow = now;
      const dt = Math.min((now - lastNow) / 1000, 0.05);
      lastNow = now;
      t += dt;

      const P = propsRef.current;

      // ----- audio level -----
      let rawLevel = 0;
      if (P.talking) {
        const el = audioElRef.current;
        if (el) {
          const a = attachMediaElementTap(el);
          rawLevel = a ? readAnalyserLevel(a) : 0;
        }
        if (rawLevel === 0) rawLevel = getVoiceLevel();
        if (rawLevel === 0) {
          // synthetic envelope: product of two incommensurate sines
          rawLevel = Math.abs(Math.sin(t * 2 * Math.PI * 1.7) * Math.sin(t * 2 * Math.PI * 0.43)) * 0.8;
        }
      }
      level = ease(level, rawLevel, 0.35, 0.12);

      // ----- state amounts (asymmetric easing) -----
      thinkAmt = ease(thinkAmt, P.thinking ? 1 : 0);
      toolAmt = ease(toolAmt, P.toolRunning ? 1 : 0);
      listenAmt = ease(listenAmt, P.listening ? 1 : 0);

      // alert: rising edge only; decays over ~1.5s even if prop stays true
      if (P.alert && !prevAlert) flare = 1;
      prevAlert = P.alert;
      flare *= Math.pow(0.05, dt / 1.5); // → 5% after 1.5s

      // ----- gaze drift (smoothed random walk) -----
      if (t > nextRetarget) {
        rotSpeedTarget = 0.1 + Math.random() * 0.35;
        if (Math.random() < 0.25) rotSpeedTarget *= -1;
        tiltXTarget = (Math.random() - 0.5) * 0.7;
        nextRetarget = t + 2 + Math.random() * 5;
      }

      // ----- cursor awareness -----
      const pdx = px - cx;
      const pdy = py - cy;
      const pdist = Math.hypot(pdx, pdy);
      const near = pointerIn && pdist < 260;
      cursorPull = ease(cursorPull, near ? 1 - pdist / 260 : 0, EASE_IN, 0.01);

      let speedTarget = rotSpeedTarget;
      let tiltTarget = tiltXTarget;
      if (cursorPull > 0.01) {
        // rotation eases toward the pointer side; tilt follows pointer Y
        const wantSpeed = (pdx / 260) * 0.8;
        const wantTilt = (pdy / 260) * 0.9;
        speedTarget = mix(speedTarget, wantSpeed, cursorPull);
        tiltTarget = mix(tiltTarget, wantTilt, cursorPull);
      }
      // listening: orb stills and levels toward the viewer
      speedTarget = mix(speedTarget, 0.04, listenAmt);
      tiltTarget = mix(tiltTarget, 0, listenAmt);
      // thinking: rotation speeds up
      speedTarget *= 1 + thinkAmt * 1.8;
      // talking: level nudges rotation
      speedTarget *= 1 + level * 0.6;

      rotSpeed = ease(rotSpeed, speedTarget, 0.08, 0.02);
      tiltX = ease(tiltX, tiltTarget, 0.06, 0.02);
      rotY += rotSpeed * dt;
      const wobble = Math.sin(t * 0.31 + wob1) * 0.06 + Math.sin(t * 0.123 + wob2) * 0.04;
      const effTiltX = tiltX + wobble;

      // ----- breath: three incommensurate sines, never repeats -----
      // 0.2 Hz, 0.05·√2 Hz, 0.011·π Hz — pairwise irrational ratios.
      const breath =
        1 +
        0.022 * Math.sin(t * 2 * Math.PI * 0.2) +
        0.016 * Math.sin(t * 2 * Math.PI * 0.05 * Math.SQRT2 + 1.7) +
        0.012 * Math.sin(t * 2 * Math.PI * 0.011 * Math.PI + 4.1);

      // ----- heartbeat: randomized-interval lub-dub -----
      if (t > nextBeat) {
        beatT = t;
        nextBeat = t + 2.6 + Math.random() * 1.6;
      }
      const since = t - beatT;
      // lub at 0, dub at 0.18s; each a fast-attack exp-decay bump
      const pulse =
        (since >= 0 ? Math.exp(-since * 9) : 0) * 1.0 +
        (since >= 0.18 ? Math.exp(-(since - 0.18) * 9) : 0) * 0.55;
      const beatGlow = pulse * 0.35;
      const beatR = 1 + pulse * 0.02;

      const R = baseR * breath * beatR * (1 + level * 0.06);

      // global brightness multiplier
      const glow = 1 + beatGlow + level * 0.8 + flare * 0.9;
      const flickerAmp = mix(1, 0.25, listenAmt); // listening quiets flicker

      // palette shift toward alert red by flare amount
      const pr = (c: { r: number; g: number; b: number }) => ({
        r: Math.round(mix(c.r, ALERT.r, flare * 0.8)),
        g: Math.round(mix(c.g, ALERT.g, flare * 0.8)),
        b: Math.round(mix(c.b, ALERT.b, flare * 0.8)),
      });
      const base = pr(BASE);
      const hot = pr(HOT);
      const core = pr(CORE);

      // ---------- draw ----------
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = BG;
      ctx.fillRect(0, 0, size, size);
      ctx.globalCompositeOperation = "lighter";

      const sinY = Math.sin(rotY);
      const cosY = Math.cos(rotY);
      const sinX = Math.sin(effTiltX);
      const cosX = Math.cos(effTiltX);

      // ----- layered soft core (no blur — concentric fills) -----
      const coreGlow = 0.5 + beatGlow + level * 0.9 + flare * 0.8;
      for (let i = 5; i >= 1; i--) {
        const rr = R * 0.11 * i;
        const a = (0.05 + (5 - i) * 0.035) * coreGlow;
        ctx.fillStyle = `rgba(${core.r},${core.g},${core.b},${Math.min(a, 0.55)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      // hot center
      ctx.fillStyle = `rgba(${hot.r},${hot.g},${hot.b},${Math.min(0.5 * coreGlow, 0.8)})`;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.06, 0, Math.PI * 2);
      ctx.fill();

      // ----- rings: back-half arcs only -----
      for (let ri = 0; ri < rings.length; ri++) {
        const ring = rings[ri];
        // toolRunning: ring 2 tightens and spins up
        const isToolRing = ri === 2;
        const tighten = isToolRing ? mix(1, 0.62, toolAmt) : 1;
        const spin = ring.phase + t * ring.speed * (isToolRing ? 1 + toolAmt * 7 : 1);
        const ringR = ring.radius * tighten;
        const alpha =
          (ring.alpha + level * 0.10 + (isToolRing ? toolAmt * 0.22 : 0)) *
          (1 + flare * 0.5);

        ctx.strokeStyle = `rgba(${core.r},${core.g},${core.b},${Math.min(alpha, 0.5)})`;
        ctx.lineWidth = 0.8;
        const sTX = Math.sin(ring.tiltX);
        const cTX = Math.cos(ring.tiltX);
        const sTZ = Math.sin(ring.tiltZ);
        const cTZ = Math.cos(ring.tiltZ);
        let drawing = false;
        ctx.beginPath();
        const STEPS = 56;
        for (let s = 0; s <= STEPS; s++) {
          const a0 = (s / STEPS) * Math.PI * 2 + spin;
          // ring-local circle
          let x = Math.cos(a0) * ringR;
          let y = 0;
          let z = Math.sin(a0) * ringR;
          // ring tilt X then Z
          let y1 = y * cTX - z * sTX;
          let z1 = y * sTX + z * cTX;
          let x1 = x * cTZ - y1 * sTZ;
          const y2 = x * sTZ + y1 * cTZ;
          // world rotation (shared with particles)
          const x2 = x1 * cosY + z1 * sinY;
          const z2 = -x1 * sinY + z1 * cosY;
          const y3 = y2 * cosX - z2 * sinX;
          const z3 = y2 * sinX + z2 * cosX;
          if (z3 > 0.05) {
            // away from viewer → visible back-half
            const persp = FOCAL / (FOCAL + z3);
            const sx = cx + x2 * R * persp;
            const sy = cy + y3 * R * persp;
            if (!drawing) {
              ctx.moveTo(sx, sy);
              drawing = true;
            } else {
              ctx.lineTo(sx, sy);
            }
          } else {
            drawing = false;
          }
        }
        ctx.stroke();
      }

      // ----- particles -----
      const longWave = thinkAmt; // longitude brightness sweep while thinking
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const p = particles[i];

        // stray lifecycle
        let ox = 0;
        let oy = 0;
        let oz = 0;
        if (p.strayNext > 0) {
          if (p.strayState === 0 && t > p.strayNext) {
            p.strayState = 1;
            p.strayUntil = t + 5 + Math.random() * 3;
          }
          if (p.strayState === 1) {
            p.strayAmp = ease(p.strayAmp, 0.55, 0.02, 0.02);
            if (t > p.strayUntil) p.strayState = 2;
          } else if (p.strayState === 2) {
            p.strayAmp = ease(p.strayAmp, 0, 0.03, 0.03);
            if (p.strayAmp < 0.01) {
              p.strayAmp = 0;
              p.strayState = 0;
              p.strayNext = t + 4 + Math.random() * 14;
            }
          }
          if (p.strayAmp > 0.001) {
            ox = Math.sin(t * p.wf1 + p.phase) * p.strayAmp;
            oy = Math.sin(t * p.wf2 + p.phase * 2.1) * p.strayAmp;
            oz = Math.sin(t * p.wf3 + p.phase * 0.7) * p.strayAmp * 0.6;
          }
        }

        // world rotation: Y then X tilt
        const x1 = (p.x + ox) * cosY + (p.z + oz) * sinY;
        const z1 = -(p.x + ox) * sinY + (p.z + oz) * cosY;
        const y1 = (p.y + oy) * cosX - z1 * sinX;
        const z2 = (p.y + oy) * sinX + z1 * cosX;

        // radial jitter while talking
        const jitter = level > 0.01 ? 1 + Math.sin(t * 21 + p.phase * 5) * level * 0.05 : 1;

        const persp = FOCAL / (FOCAL + z2);
        let sx = cx + x1 * R * jitter * persp;
        let sy = cy + y1 * R * jitter * persp;

        // depth → alpha + size (front z2<0 is brighter, larger)
        const depth = (1 - z2) * 0.5; // 0 back … 1 front
        const flicker =
          1 + Math.sin(t * p.flickerFreq * 2 * Math.PI + p.phase) * 0.35 * flickerAmp;

        // thinking: longitude wave sweeping the surface
        let waveBoost = 0;
        if (longWave > 0.01) {
          const lon = Math.atan2(z1, x1);
          waveBoost = Math.max(0, Math.sin(lon * 3 - t * 4)) * 0.5 * longWave;
        }

        // cursor repulsion (projected-space)
        let cursorBoost = 0;
        if (pointerIn) {
          const dx = sx - px;
          const dy = sy - py;
          const d = Math.hypot(dx, dy);
          if (d < 70 && d > 0.001) {
            const f = 1 - d / 70;
            sx += (dx / d) * f * 14;
            sy += (dy / d) * f * 14;
            cursorBoost = f * 0.6;
          }
        }

        let a =
          (0.10 + depth * 0.55) * flicker * glow * (1 + waveBoost + cursorBoost) *
          (1 + level * 0.5);
        if (a <= 0.02) continue;
        if (a > 0.9) a = 0.9;

        const c = p.hot || depth > 0.82 ? hot : base;
        const sz = p.size * (0.5 + depth * 0.8) * (1 + level * 0.45) * persp;

        ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${a})`;
        ctx.beginPath();
        ctx.arc(sx, sy, sz, 0, Math.PI * 2);
        ctx.fill();
      }

      // perf accounting — 1s windows exposed for measurement
      frames++;
      frameMsSum += performance.now() - frameStart;
      if (now - statWindowStart >= 1000) {
        const stats = {
          fps: frames,
          avgFrameMs: +(frameMsSum / Math.max(frames, 1)).toFixed(2),
        };
        (window as unknown as { __bartAvatarStats?: typeof stats }).__bartAvatarStats =
          stats;
        frames = 0;
        frameMsSum = 0;
        statWindowStart = now;
      }
    };

    const frame = (now: number) => {
      if (!running) return;
      renderFrame(now);
      raf = requestAnimationFrame(frame);
    };

    // Dev measurement hook: drive N frames at synthetic 60fps timestamps
    // and report real wall-clock cost per frame. Read by the build's
    // perf gate; harmless elsewhere.
    (window as unknown as {
      __bartAvatarBench?: (n?: number) => {
        frames: number;
        totalMs: number;
        avgFrameMs: number;
        level: number;
        talking: boolean;
        thinking: boolean;
      };
    }).__bartAvatarBench = (n = 300) => {
      let synth = performance.now();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        renderFrame(synth);
        synth += 1000 / 60;
      }
      const totalMs = performance.now() - t0;
      lastNow = null; // don't let synthetic timestamps skew the live loop
      return {
        frames: n,
        totalMs: +totalMs.toFixed(1),
        avgFrameMs: +(totalMs / n).toFixed(3),
        // smoothed voice level after these frames — observable proof that
        // audio reactivity tracks playback amplitude
        level: +level.toFixed(3),
        talking: propsRef.current.talking,
        thinking: propsRef.current.thinking,
      };
    };

    const onVisibility = () => {
      if (document.hidden) {
        running = false;
        cancelAnimationFrame(raf);
        // eslint-disable-next-line no-console
        console.info("[BartAvatar] RAF paused (tab hidden)");
      } else if (!running) {
        running = true;
        lastNow = null; // don't integrate the hidden gap
        // eslint-disable-next-line no-console
        console.info("[BartAvatar] RAF resumed (tab visible)");
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    raf = requestAnimationFrame(frame);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      delete (window as unknown as { __bartAvatarBench?: unknown }).__bartAvatarBench;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [size]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: size, height: size, display: "block" }}
      role="img"
      aria-label="Bartimaeus avatar"
      data-bart-avatar
    />
  );
}
