// 折れ線グラフ（SVG）。ウィンドウの中にそのまま埋め込む

export interface Series {
  name: string;
  color: string;
  data: number[];
  /** 点線で描く */
  dashed?: boolean;
}

export interface ChartOptions {
  height?: number;
  /** 縦軸の数字の書き方 */
  format?: (v: number) => string;
  /** 横軸の左端・右端の文字 */
  xLeft?: string;
  xRight?: string;
  /** 縦の線（「いま」など）を入れる位置（0..1） */
  marker?: { at: number; label: string };
}

const W = 320;

function niceStep(range: number): number {
  const raw = range / 4;
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * p) return m * p;
  return 10 * p;
}

/** 右詰めの記録（最後が先月）を、同じ長さにそろえて描く */
export function lineChart(series: Series[], opts: ChartOptions = {}): string {
  const H = opts.height ?? 120;
  const fmt = opts.format ?? ((v: number) => Math.round(v).toLocaleString('ja-JP'));
  const len = Math.max(2, ...series.map((s) => s.data.length));
  const all = series.flatMap((s) => s.data);
  if (all.length === 0) return `<div class="chart-empty">まだ記録がありません（月が替わると記録されます）</div>`;
  let lo = Math.min(0, ...all),
    hi = Math.max(0, ...all);
  if (hi === lo) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const padL = 46,
    padR = 6,
    padT = 6,
    padB = 18;
  const iw = W - padL - padR,
    ih = H - padT - padB;
  const x = (i: number) => padL + (iw * i) / (len - 1);
  const y = (v: number) => padT + ih - ((v - lo) / (hi - lo)) * ih;
  const grid: string[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid.push(
      `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="${v === 0 ? 'zero' : 'grid'}"/>` +
        `<text x="${padL - 4}" y="${y(v) + 3}" class="ylab">${fmt(v)}</text>`,
    );
  }
  const lines = series
    .map((s) => {
      if (!s.data.length) return '';
      const off = len - s.data.length;
      const pts = s.data.map((v, i) => `${x(i + off).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
      const last = s.data[s.data.length - 1];
      return `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dashed ? 'stroke-dasharray="4 3"' : ''} stroke-linejoin="round"/>` +
        `<circle cx="${x(len - 1)}" cy="${y(last)}" r="2.6" fill="${s.color}"/>`;
    })
    .join('');
  const marker = opts.marker
    ? `<line x1="${padL + iw * opts.marker.at}" x2="${padL + iw * opts.marker.at}" y1="${padT}" y2="${padT + ih}" class="marker"/>` +
      `<text x="${padL + iw * opts.marker.at + 3}" y="${padT + 10}" class="mlab">${opts.marker.label}</text>`
    : '';
  const legend =
    series.length > 1
      ? `<div class="chart-legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join('')}</div>`
      : '';
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">
    ${grid.join('')}${marker}${lines}
    <text x="${padL}" y="${H - 4}" class="xlab">${opts.xLeft ?? ''}</text>
    <text x="${W - padR}" y="${H - 4}" class="xlab end">${opts.xRight ?? ''}</text>
  </svg>${legend}</div>`;
}

/** 一覧の行に入れる小さなグラフ */
export function sparkline(data: number[], color = '#2c4a3e'): string {
  if (data.length < 2) return '<span class="spark empty"></span>';
  const w = 60,
    h = 18;
  const lo = Math.min(0, ...data),
    hi = Math.max(0, ...data);
  const span = hi - lo || 1;
  const pts = data.map((v, i) => `${((w * i) / (data.length - 1)).toFixed(1)},${(h - ((v - lo) / span) * (h - 2) - 1).toFixed(1)}`).join(' ');
  const zero = h - ((0 - lo) / span) * (h - 2) - 1;
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><line x1="0" x2="${w}" y1="${zero}" y2="${zero}" stroke="#d8ccb2"/><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>`;
}

/** お金を短く（グラフの軸用） */
export function shortYen(v: number): string {
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 100_000_000) return `${s}${(a / 100_000_000).toFixed(a >= 1e9 ? 0 : 1)}億`;
  if (a >= 10_000) return `${s}${Math.round(a / 10_000).toLocaleString('ja-JP')}万`;
  return `${s}${Math.round(a)}`;
}

/** 右詰めの記録の、左端の文字（何か月前か） */
export function monthsAgo(n: number): string {
  if (n <= 1) return '先月';
  if (n % 12 === 0) return `${n / 12}年前`;
  return `${n}か月前`;
}
