// 効果音と振動（v0.9.5）
//
// ・効果音：音のファイルは使わず、ブラウザの中で音をつくる（Web Audio）。オフラインでも鳴る
// ・振動：Android などは navigator.vibrate。iPhone の Safari にはないので、iOS 18 からの
//   「スイッチ型のチェックボックス」を見えないところで切り替えると、軽い振動（ハプティクス）が出るのを使う。
//   iPhone では、画面をさわった瞬間（タップの処理の中）でしか振動しない
// ・どちらもはじめはオン。メニューの「音・振動」で切り替える（この端末に覚える）

import { bgmPlaying, playBgm, stopBgm } from './bgm';

const KEY = 'tsunagu.fx';

interface FxPrefs {
  sound: boolean;
  vibe: boolean;
  /** BGM（v0.9.6） */
  bgm: boolean;
  volume: number;
}

let prefs: FxPrefs = load();

function load(): FxPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return {
      sound: v.sound !== false,
      vibe: v.vibe !== false,
      bgm: v.bgm !== false,
      volume: typeof v.volume === 'number' ? Math.min(1, Math.max(0, v.volume)) : 0.6,
    };
  } catch {
    return { sound: true, vibe: true, bgm: true, volume: 0.6 };
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* 覚えられなくても遊べる */
  }
}

export function fxPrefs(): Readonly<FxPrefs> {
  return prefs;
}

export function setFx(p: Partial<FxPrefs>) {
  prefs = { ...prefs, ...p };
  save();
  // BGM の切り替えは、押したその場で（iPhone はタップの中でないと鳴らない）
  if (p.bgm === true) playBgm(prefs.volume);
  if (p.bgm === false) stopBgm();
}

// ───────────── 音 ─────────────

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let warmed = false;

/** はじめてさわったときに音を使えるようにする（ブラウザは、さわるまで音を出させてくれない） */
export function unlockAudio() {
  if (prefs.bgm && !bgmPlaying()) playBgm(prefs.volume);
  if (!prefs.sound) return;
  try {
    if (!ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.connect(ctx.destination);
    }
    if (ctx.state !== 'running') void ctx.resume();
    // iPhone：さわった瞬間に一度「空鳴らし」しておかないと、そのあとも鳴らないことがある
    if (!warmed) {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      warmed = true;
    }
  } catch {
    ctx = null;
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain: number, freqEnd?: number) {
  if (!ctx || !master) return;
  const t0 = ctx.currentTime + start;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(master);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export type Sfx = 'build' | 'depart' | 'coin' | 'fanfare' | 'error' | 'tap';

const lastPlayed: Partial<Record<Sfx, number>> = {};
/** 同じ音が続けて鳴りすぎないように（ミリ秒） */
const GAP: Record<Sfx, number> = { build: 60, depart: 400, coin: 350, fanfare: 1500, error: 200, tap: 40 };

export function sfx(name: Sfx) {
  if (!prefs.sound || prefs.volume <= 0) return;
  if (!ctx) unlockAudio();
  if (!ctx || !master || ctx.state !== 'running') return;
  const now = performance.now();
  if (now - (lastPlayed[name] ?? -1e9) < GAP[name]) return;
  lastPlayed[name] = now;
  master.gain.value = prefs.volume * 0.5;
  switch (name) {
    case 'build': // コトッ
      tone(180, 0, 0.09, 'square', 0.35, 70);
      tone(900, 0, 0.03, 'triangle', 0.15);
      break;
    case 'depart': // ポーッ（汽笛）
      tone(740, 0, 0.45, 'sine', 0.3, 700);
      tone(932, 0, 0.45, 'sine', 0.22, 880);
      break;
    case 'coin': // チャリン（小さめ）
      tone(1568, 0, 0.08, 'triangle', 0.12);
      tone(2093, 0.06, 0.14, 'triangle', 0.1);
      break;
    case 'fanfare': // 短いファンファーレ
      [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.09, i === 3 ? 0.35 : 0.12, 'square', 0.18));
      break;
    case 'error': // ブッ
      tone(120, 0, 0.16, 'square', 0.3, 90);
      break;
    case 'tap':
      tone(1400, 0, 0.025, 'triangle', 0.08);
      break;
  }
}

// ───────────── 振動 ─────────────

/**
 * iOS 18 の Safari：スイッチ型のチェックボックスを切り替えると軽く振動する。
 * 毎回つくって、表示しないまま切り替えて、すぐ消す（よく使われている ios-haptics と同じやり方）。
 * 画面をさわった処理の中（クリックの中）で呼んだときだけ振動する
 */
function iosHaptic() {
  const label = document.createElement('label');
  label.setAttribute('aria-hidden', 'true');
  label.style.display = 'none';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.setAttribute('switch', '');
  label.appendChild(input);
  document.head.appendChild(label);
  label.click();
  document.head.removeChild(label);
}

export type Haptic = 'light' | 'medium' | 'error';

export function haptic(kind: Haptic = 'light') {
  if (!prefs.vibe) return;
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(kind === 'error' ? [30, 50, 30] : kind === 'medium' ? 25 : 12);
      return;
    }
    // iPhone（vibrate がない）：1種類だけ。エラーは2回
    iosHaptic();
    if (kind === 'error') setTimeout(() => iosHaptic(), 90);
  } catch {
    /* 振動できなくても遊べる */
  }
}

/** 音の準備ができているか（確認用） */
export function audioState(): string {
  return ctx ? ctx.state : 'none';
}

/** BGM が流れているか（確認用） */
export function bgmState(): boolean {
  return bgmPlaying();
}
