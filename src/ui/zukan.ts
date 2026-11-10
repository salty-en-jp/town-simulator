// 車両図鑑（v0.8.0）
//
// ・全部の車両を、絵・能力・登場年・値段・説明文つきで並べる
// ・まだ登場していない車両は影だけ。使ったことのある車両には★
// ・「使った・見た」はこの端末に記録する（どの街・チャレンジで使っても集まる。新しい街でも消えない）
// ・説明文は src/data/zukan.md に書く（オーナーが書けるように、プログラムと分けてある）

import flavorMd from '../data/zukan.md?raw';
import { parseFlavor } from './flavor';
import {
  CARGO_SPECS,
  DEV_POWER_NAMES,
  DEV_POWERS,
  DEV_USE_NAMES,
  DEV_USES,
  ENGINE_SPECS,
  ENGINE_TYPES,
  isDevEngine,
  isEngine,
  WAGON_SPECS,
  WAGON_TYPES,
  type VehicleType,
} from '../sim/constants';
import { canBuy, vehicleYear, type World } from '../sim/world';
import { compatMark } from '../sim/devel';
import { CAR_COLORS } from '../render/renderer';
import type { Game } from '../game';
import { esc } from './panels';

// ───────────── 説明文 ─────────────

const FLAVOR = parseFlavor(flavorMd);

// ───────────── この端末の記録 ─────────────

interface ZukanRecord {
  used: string[];
  seen: string[];
  /** 自社開発でわかった相性（"electric:commuter" → ◎○△） */
  combos?: Record<string, string>;
}

const LS_KEY = 'tsunagu.zukan';

export function zukanRecord(): ZukanRecord {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
    const combos: Record<string, string> = {};
    if (v.combos && typeof v.combos === 'object') for (const [k, m] of Object.entries(v.combos)) if (typeof m === 'string') combos[k] = m;
    return { used: Array.isArray(v.used) ? v.used : [], seen: Array.isArray(v.seen) ? v.seen : [], combos };
  } catch {
    return { used: [], seen: [], combos: {} };
  }
}

export function comboRecord(): Record<string, string> {
  return zukanRecord().combos ?? {};
}

/** 今の街で使っている車両・買える車両を記録する。新しく使った車両があれば、その名前を返す */
export function noteVehicles(world: World): VehicleType[] {
  const rec = zukanRecord();
  const used = new Set(rec.used),
    seen = new Set(rec.seen);
  const fresh: VehicleType[] = [];
  const cars = [...[...world.trains.values()].flatMap((t) => t.cars), ...[...world.depots.values()].flatMap((d) => d.stored)];
  for (const c of cars) {
    // 自社開発の機関車はその街だけのもの。図鑑の「使った車両」には数えない
    if (isDevEngine(c.type)) continue;
    if (!used.has(c.type)) {
      used.add(c.type);
      fresh.push(c.type);
    }
    seen.add(c.type);
  }
  for (const t of [...ENGINE_TYPES, ...WAGON_TYPES] as VehicleType[]) if (canBuy(world, t)) seen.add(t);
  // できあがった自社開発の機関車から、動力と用途の相性を記録する
  const combos = { ...(rec.combos ?? {}) };
  let newCombo = false;
  for (const d of world.designs ?? []) {
    const k = `${d.power}:${d.use}`;
    if (d.done !== undefined && !combos[k]) {
      combos[k] = compatMark(d.power, d.use);
      newCombo = true;
    }
  }
  if (fresh.length || newCombo || seen.size !== rec.seen.length) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ used: [...used], seen: [...seen], combos }));
    } catch {
      /* 記録できなくても遊べる */
    }
  }
  return fresh;
}

// ───────────── 車両の絵（横から見た簡単な絵） ─────────────

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const shadeHex = (n: number, f: number) => {
  const r = Math.min(255, Math.round(((n >> 16) & 255) * f)),
    g = Math.min(255, Math.round(((n >> 8) & 255) * f)),
    b = Math.min(255, Math.round((n & 255) * f));
  return hex((r << 16) | (g << 8) | b);
};

export function vehicleSvg(type: VehicleType, silhouette = false): string {
  const base = CAR_COLORS[type] ?? (isEngine(type) ? ENGINE_SPECS[type].color : undefined) ?? 0x888888;
  const body = silhouette ? '#3a3a3a' : hex(base);
  const dark = silhouette ? '#2a2a2a' : shadeHex(base, 0.7);
  const wheel = silhouette ? '#222' : '#2a2620';
  const parts: string[] = [];
  const wheels = (xs: number[]) => xs.map((x) => `<circle cx="${x}" cy="34" r="5" fill="${wheel}"/>`).join('');
  if (isEngine(type)) {
    if (type === 'steam' || (isDevEngine(type) && ENGINE_SPECS[type].power === 'steam')) {
      parts.push(`<rect x="8" y="14" width="44" height="16" rx="3" fill="${body}"/>`);
      parts.push(`<rect x="52" y="6" width="18" height="24" rx="2" fill="${dark}"/>`);
      parts.push(`<rect x="16" y="2" width="6" height="12" fill="${dark}"/>`);
      if (!silhouette) parts.push(`<circle cx="19" cy="0" r="3" fill="#ccc" opacity=".6"/>`);
      parts.push(wheels([16, 30, 44, 62]));
    } else {
      const nose = type === 'superexpress';
      parts.push(
        nose
          ? `<path d="M6 30 L6 16 Q6 8 20 8 L70 8 L70 30 Z" fill="${body}"/>`
          : `<rect x="6" y="8" width="64" height="22" rx="4" fill="${body}"/>`,
      );
      parts.push(`<rect x="${nose ? 14 : 10}" y="12" width="10" height="7" rx="1" fill="${silhouette ? '#444' : '#cfe3f0'}"/>`);
      if (!silhouette) {
        const stripe: Record<string, number> = { express: 0xf2c14e, heavy: 0xe8a317, superexpress: 0x2f5f8f };
        parts.push(`<rect x="6" y="22" width="64" height="3" fill="${hex(stripe[type] ?? 0xc0443a)}"/>`);
      }
      parts.push(wheels([18, 30, 50, 62]));
    }
  } else {
    const w = WAGON_SPECS[type];
    const len = w.big ? 68 : 58;
    const x0 = (76 - len) / 2;
    if (w.cargo === 'passengers') {
      parts.push(`<rect x="${x0}" y="8" width="${len}" height="22" rx="4" fill="${body}"/>`);
      if (!silhouette) for (let k = 0; k < (w.big ? 6 : 5); k++) parts.push(`<rect x="${x0 + 6 + k * 10}" y="12" width="6" height="7" rx="1" fill="#e8f2f8"/>`);
    } else if (['logs', 'lumber', 'steel'].includes(w.cargo)) {
      parts.push(`<rect x="${x0}" y="24" width="${len}" height="6" fill="${dark}"/>`);
      if (!silhouette) for (let k = 0; k < 3; k++) parts.push(`<rect x="${x0 + 3}" y="${12 + k * 4}" width="${len - 6}" height="4" rx="2" fill="${hex(CARGO_SPECS[w.cargo].color)}"/>`);
      else parts.push(`<rect x="${x0 + 3}" y="12" width="${len - 6}" height="12" fill="${body}"/>`);
    } else if (['ore', 'coal', 'grain'].includes(w.cargo)) {
      parts.push(`<path d="M${x0} 12 L${x0 + len} 12 L${x0 + len - 6} 30 L${x0 + 6} 30 Z" fill="${body}"/>`);
    } else {
      parts.push(`<rect x="${x0}" y="10" width="${len}" height="20" rx="2" fill="${body}"/>`);
      if (!silhouette && w.fresh) parts.push(`<rect x="${x0}" y="18" width="${len}" height="2" fill="#7db6e0"/>`);
    }
    parts.push(wheels([x0 + 8, x0 + 18, x0 + len - 18, x0 + len - 8]));
  }
  return `<svg class="veh-svg" viewBox="0 -4 76 44" aria-hidden="true"><rect x="0" y="38" width="76" height="2" fill="#a89a80"/>${parts.join('')}</svg>`;
}

// ───────────── 図鑑のウィンドウ ─────────────

type Tab = 'engines' | 'wagons' | 'combo';
let tab: Tab = 'engines';

function card(world: World, t: VehicleType, used: Set<string>, seen: Set<string>): string {
  const y = vehicleYear(t);
  const ok = canBuy(world, t) || seen.has(t) || used.has(t);
  const isUsed = used.has(t);
  const spec = isEngine(t) ? ENGINE_SPECS[t] : WAGON_SPECS[t];
  if (!ok) {
    return `<li class="zk-card locked">
      <div class="zk-art">${vehicleSvg(t, true)}</div>
      <div class="zk-body"><b>？？？</b><span class="zk-badge">${y}年に登場</span><p class="zk-flavor muted">まだ見たことのない車両です。</p></div></li>`;
  }
  const stats = isEngine(t)
    ? [
        ['速さ', `${ENGINE_SPECS[t].speed}マス/日`],
        ['つなげる', `${ENGINE_SPECS[t].maxCars}両まで・${ENGINE_SPECS[t].allow === 'pax' ? '客車だけ' : ENGINE_SPECS[t].allow === 'freight' ? '貨車だけ' : 'なんでも'}`],
        ['維持費', `${Math.round(ENGINE_SPECS[t].runningCostPerYear / 10000).toLocaleString('ja-JP')}万円/年`],
      ]
    : [
        ['運ぶ物', CARGO_SPECS[WAGON_SPECS[t].cargo].name],
        ['積める量', `${WAGON_SPECS[t].capacity}${CARGO_SPECS[WAGON_SPECS[t].cargo].unit}`],
        ...(WAGON_SPECS[t].fresh ? [['傷みにくさ', `${Math.round((1 - WAGON_SPECS[t].fresh!) * 100)}%おそい`]] : []),
      ];
  stats.push(['値段', `${Math.round(spec.cost / 10000).toLocaleString('ja-JP')}万円`], ['登場', y ? `${y}年` : 'はじめから']);
  const flavor = FLAVOR[t];
  return `<li class="zk-card ${isUsed ? 'used' : ''}">
    <div class="zk-art">${vehicleSvg(t)}</div>
    <div class="zk-body">
      <b>${esc(spec.name)}</b>${isUsed ? '<span class="zk-badge used">★ 使った</span>' : ''}
      <dl class="zk-stats">${stats.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
      ${flavor ? flavor.map((p) => `<p class="zk-flavor">${esc(p)}</p>`).join('') : '<p class="zk-flavor muted">（説明文はまだありません）</p>'}
    </div></li>`;
}

export function openZukan(g: Game) {
  noteVehicles(g.world);
  g.wm.open({
    id: 'zukan',
    title: '車両図鑑',
    width: 460,
    render: () => {
      const rec = zukanRecord();
      const used = new Set(rec.used),
        seen = new Set(rec.seen);
      const all = [...ENGINE_TYPES, ...WAGON_TYPES] as VehicleType[];
      const n = all.filter((t) => used.has(t)).length;
      const tabs = (
        [
          ['engines', '機関車'],
          ['wagons', '客車・貨車'],
          ['combo', '相性表'],
        ] as [Tab, string][]
      )
        .map(([k, v]) => `<button role="tab" data-action="tab-${k}" class="${tab === k ? 'on' : ''}">${v}</button>`)
        .join('');
      let body: string;
      if (tab === 'combo') {
        const combos = rec.combos ?? {};
        const found = Object.keys(combos).length;
        body = `<p class="small">自社開発では、<b>動力</b>と<b>用途</b>を組み合わせて機関車をつくります。相性のよい組み合わせは、同じ予算でも能力が高くなります。相性は、つくってみるとこの表に記録されます（この端末で遊んだすべての街）。</p>
          <table class="tbl zk-combo"><tr><th></th>${DEV_USES.map((u) => `<th>${DEV_USE_NAMES[u]}</th>`).join('')}</tr>
          ${DEV_POWERS.map((p) => `<tr><th>${DEV_POWER_NAMES[p]}</th>${DEV_USES.map((u) => (combos[`${p}:${u}`] ? `<td class="zk-mark">${combos[`${p}:${u}`]}</td>` : '<td class="muted">？</td>')).join('')}</tr>`).join('')}</table>
          <p class="small muted">わかった組み合わせ ${found} / ${DEV_POWERS.length * DEV_USES.length}　◎ 抜群・○ ふつう・△ いまひとつ</p>`;
      } else {
        const list = (tab === 'engines' ? ENGINE_TYPES : WAGON_TYPES) as VehicleType[];
        body = `<ul class="zk-list">${list.map((t) => card(g.world, t, used, seen)).join('')}</ul>`;
      }
      return `
        <p class="zk-progress">使った車両 <b>${n}</b> / ${all.length} <small class="muted">（この端末で遊んだすべての街・チャレンジ）</small></p>
        <div class="tabs" role="tablist">${tabs}</div>
        ${body}`;
    },
    onAction: (a, el) => {
      if (a.startsWith('tab-')) {
        tab = a.slice(4) as Tab;
        g.wm.refresh('zukan', true);
        const b = el.closest('.win-body');
        if (b) b.scrollTop = 0;
      }
    },
  });
}
