// BGM（v0.9.6）
//
// ・音のファイルは使わず、ゲームをはじめたときに短い曲（約21秒）をつくって、くり返し流す
// ・ふつうの音楽の再生（<audio>）なので、iPhone では効果音もマナーモード中に鳴りやすくなる
// ・ゆったりした田舎の鉄道の曲：C → Am → F → G → C → Am → Dm → G

const RATE = 22050;
const BPM = 92;
const BEAT = 60 / BPM;
const BARS = 8;

const NOTE = (n: number) => 440 * Math.pow(2, (n - 69) / 12); // MIDI 番号 → Hz

/** 1小節ごとの和音（MIDI 番号） */
const CHORDS = [
  [48, 52, 55], // C
  [45, 48, 52], // Am
  [41, 45, 48], // F
  [43, 47, 50], // G
  [48, 52, 55], // C
  [45, 48, 52], // Am
  [50, 53, 57], // Dm
  [43, 47, 50], // G
];

/** メロディ：[拍の位置, 長さ（拍）, MIDI]（ペンタトニックで、のんびり） */
const MELODY: [number, number, number][] = [
  [0, 1.5, 76], [1.5, 0.5, 74], [2, 2, 72],
  [4, 1, 69], [5, 1, 72], [6, 2, 74],
  [8, 1.5, 72], [9.5, 0.5, 69], [10, 2, 67],
  [12, 1, 69], [13, 1, 71], [14, 2, 74],
  [16, 1.5, 76], [17.5, 0.5, 79], [18, 2, 76],
  [20, 1, 74], [21, 1, 72], [22, 2, 69],
  [24, 1, 74], [25, 1, 72], [26, 2, 69],
  [28, 1, 71], [29, 1, 74], [30, 2, 79],
];

export function render(): Float32Array {
  const len = Math.ceil(BARS * 4 * BEAT * RATE);
  const out = new Float32Array(len);
  const add = (start: number, dur: number, freq: number, vol: number, kind: 'sine' | 'tri' | 'soft', attack = 0.01, release = 0.25) => {
    const s0 = Math.floor(start * RATE);
    const n = Math.floor((dur + release) * RATE);
    for (let i = 0; i < n; i++) {
      const t = i / RATE;
      const idx = (s0 + i) % len; // 終わりは頭にまわして、つなぎ目を目立たなくする
      const ph = 2 * Math.PI * freq * t;
      let w: number;
      if (kind === 'sine') w = Math.sin(ph);
      else if (kind === 'tri') w = (2 / Math.PI) * Math.asin(Math.sin(ph));
      else w = Math.sin(ph) * 0.8 + Math.sin(ph * 2) * 0.15 + Math.sin(ph * 3) * 0.05;
      const env = t < attack ? t / attack : t < dur ? Math.exp(-(t - attack) * 1.2) : Math.exp(-(dur - attack) * 1.2) * Math.max(0, 1 - (t - dur) / release);
      out[idx] += w * env * vol;
    }
  };
  for (let bar = 0; bar < BARS; bar++) {
    const t0 = bar * 4 * BEAT;
    const ch = CHORDS[bar];
    // ベース（1拍目と3拍目）
    add(t0, BEAT * 1.8, NOTE(ch[0] - 12), 0.32, 'tri', 0.01, 0.15);
    add(t0 + 2 * BEAT, BEAT * 1.8, NOTE(ch[0] - 12 + 7), 0.26, 'tri', 0.01, 0.15);
    // 和音の分散（8分音符）
    for (let k = 0; k < 8; k++) {
      const note = ch[[0, 1, 2, 1, 0, 2, 1, 2][k]] + 12;
      add(t0 + k * BEAT * 0.5, BEAT * 0.45, NOTE(note), 0.08, 'sine', 0.005, 0.3);
    }
  }
  for (const [b, d, m] of MELODY) add(b * BEAT, d * BEAT * 0.9, NOTE(m), 0.16, 'soft', 0.02, 0.35);
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < len; i++) out[i] = (out[i] / peak) * 0.8;
  return out;
}

export function wav(samples: Float32Array): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7fff, true);
  return new Blob([buf], { type: 'audio/wav' });
}

let audio: HTMLAudioElement | null = null;

/** 曲をつくって再生する（画面をさわった処理の中で呼ぶ。iPhone はそうでないと鳴らない） */
export function playBgm(volume: number) {
  try {
    if (!audio) {
      audio = new Audio(URL.createObjectURL(wav(render())));
      audio.loop = true;
      // ほかのタブやアプリに切り替えたら止め、戻ったら続きから
      document.addEventListener('visibilitychange', () => {
        if (!audio || audio.dataset.on !== '1') return;
        if (document.hidden) audio.pause();
        else void audio.play().catch(() => {});
      });
    }
    audio.volume = Math.min(1, Math.max(0, volume)) * 0.35;
    audio.dataset.on = '1';
    // iPhone：音楽を鳴らすアプリとして扱ってもらう（マナーモードでも効果音が鳴るように）
    const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
    if (session) session.type = 'playback';
    if (audio.paused) void audio.play().catch(() => {});
  } catch {
    /* 鳴らせなくても遊べる */
  }
}

export function stopBgm() {
  if (!audio) return;
  audio.dataset.on = '0';
  audio.pause();
  const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession;
  if (session) session.type = 'auto';
}

export function bgmPlaying(): boolean {
  return !!audio && !audio.paused;
}
