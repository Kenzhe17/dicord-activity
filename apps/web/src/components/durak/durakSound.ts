/**
 * Durak synthesized audio — WebAudio only, no assets, no fetches.
 * The AudioContext is created lazily on the first playDurakSound() call
 * (which happens inside a user-gesture-driven render path) and resumed if
 * the browser suspended it. Every entry point is wrapped so audio can
 * never break the game.
 *
 * Master gain is ~0.15. All one-shots are < 300 ms.
 *
 * Usage: call unlockDurakAudio() on the first pointerdown to warm the
 * context; call playDurakSound(kind) for UI-level cues; the FX layer calls
 * it automatically for non-'finished' fx kinds via soundForFx(). For
 * 'finished' the parent decides win vs lose and calls
 * playDurakSound('win' | 'lose') itself.
 */
import type { DurakSound } from './contracts';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;
let enabled = true;

export function setDurakSoundEnabled(value: boolean): void {
  enabled = value;
}

/** Resume/create the context. Safe to call from any pointer handler. */
export function unlockDurakAudio(): void {
  try {
    const ac = ensureContext();
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
  } catch {
    /* audio is best-effort */
  }
}

function ensureContext(): AudioContext {
  if (!ctx) {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) throw new Error('WebAudio unavailable');
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.15;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
  return ctx;
}

function getNoiseBuffer(ac: AudioContext): AudioBuffer {
  if (!noiseBuffer || noiseBuffer.sampleRate !== ac.sampleRate) {
    noiseBuffer = ac.createBuffer(1, ac.sampleRate * 0.5, ac.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
}

interface ToneOpts {
  freq: number;
  endFreq?: number;
  at?: number;
  dur?: number;
  type?: OscillatorType;
  gain?: number;
}

function tone(ac: AudioContext, out: AudioNode, o: ToneOpts): void {
  const t0 = ac.currentTime + (o.at ?? 0);
  const dur = o.dur ?? 0.12;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.endFreq !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.gain ?? 0.5, t0 + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + dur + 0.05);
}

interface NoiseOpts {
  at?: number;
  dur?: number;
  gain?: number;
  type?: BiquadFilterType;
  freq?: number;
  endFreq?: number;
  q?: number;
}

function noise(ac: AudioContext, out: AudioNode, o: NoiseOpts): void {
  const t0 = ac.currentTime + (o.at ?? 0);
  const dur = o.dur ?? 0.08;
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac);
  const filter = ac.createBiquadFilter();
  filter.type = o.type ?? 'bandpass';
  filter.frequency.setValueAtTime(o.freq ?? 1800, t0);
  if (o.endFreq !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.endFreq), t0 + dur);
  filter.Q.value = o.q ?? 0.9;
  const g = ac.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.gain ?? 0.5, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + dur + 0.05);
}

export function playDurakSound(kind: DurakSound): void {
  if (!enabled) return;
  try {
    const ac = ensureContext();
    if (!master || ac.state !== 'running') return;
    switch (kind) {
      case 'deal': // soft noise swish
        noise(ac, master, { dur: 0.28, gain: 0.35, type: 'lowpass', freq: 900, endFreq: 2600 });
        noise(ac, master, { at: 0.05, dur: 0.22, gain: 0.22, type: 'bandpass', freq: 1400, endFreq: 3400 });
        break;
      case 'play': // card snap: noise burst + click
        noise(ac, master, { dur: 0.05, gain: 0.6, type: 'highpass', freq: 2500 });
        tone(ac, master, { freq: 1900, endFreq: 900, dur: 0.045, type: 'square', gain: 0.22 });
        break;
      case 'defend': // lower thud
        tone(ac, master, { freq: 140, endFreq: 70, dur: 0.16, gain: 0.55 });
        noise(ac, master, { dur: 0.07, gain: 0.3, type: 'lowpass', freq: 500 });
        break;
      case 'take': // descending two-tone
        tone(ac, master, { freq: 520, endFreq: 380, dur: 0.11, gain: 0.4 });
        tone(ac, master, { at: 0.1, freq: 380, endFreq: 240, dur: 0.14, gain: 0.4 });
        break;
      case 'pass': // single soft tick
        tone(ac, master, { freq: 1150, endFreq: 900, dur: 0.05, type: 'triangle', gain: 0.3 });
        break;
      case 'win': // ascending arpeggio
        [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
          tone(ac, master!, { at: i * 0.09, freq: f, dur: 0.22, gain: 0.4 }));
        break;
      case 'lose': // descending minor phrase
        [392, 311.13, 261.63].forEach((f, i) =>
          tone(ac, master!, { at: i * 0.13, freq: f, dur: 0.26, type: 'triangle', gain: 0.38 }));
        break;
      case 'turn': // very quiet tick
        noise(ac, master, { dur: 0.03, gain: 0.14, type: 'highpass', freq: 3200 });
        break;
    }
  } catch {
    /* audio is best-effort */
  }
}
