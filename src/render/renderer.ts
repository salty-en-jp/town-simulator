// PixiJS による描画。シミュレーションの状態を読むだけで、変更はしない。

// CSP（eval を禁止）の下でも動くようにする。公開版は eval を許していない
import 'pixi.js/unsafe-eval';
import { Application, Container, Graphics } from 'pixi.js';
import { CARGO_SPECS, INDUSTRY_SPECS, isEngine, WAGON_SPECS } from '../sim/constants';
import { industryStatus, ownerLabel } from '../sim/industries';
import { activeBooms } from '../sim/market';
import { stageName, townStage } from '../sim/towns';
import {
  carLoad,
  DIRS,
  DX,
  DY,
  idx,
  stationSign,
  Terrain,
  tx,
  ty,
  type Car,
  type Industry,
  type Rect,
  type Train,
  type World,
  townLabel,
} from '../sim/world';
import { groundPoly, hash01, isoX, isoY, shade, TH, TW, worldToTile } from './iso';

export interface Preview {
  tiles: number[];
  /** 線路のゴースト（タイル列をつなぐ） */
  path?: number[];
  ok: boolean;
  remove?: boolean;
  catchment?: Rect | null;
  /** 駅の向き（ゴーストの線路をこの向きに描く） */
  axis?: 'x' | 'y';
  /** 範囲に入る産業の枠（ok=運べる） */
  marks?: { x: number; y: number; w: number; h: number; ok: boolean }[];
  kind: 'track' | 'station' | 'depot' | 'demolish';
}

export interface Overlay {
  hover: number;
  preview: Preview | null;
  selectedStation: number;
  selectedTrain: number;
}

const C = {
  bg: 0x1d2a22,
  grassA: 0x8cbf68,
  grassB: 0x86b862,
  water: 0x4f93c9,
  rockA: 0x9a8a72,
  rockB: 0x8f7f68,
  stone: 0x6f6252,
  waterHi: 0x7db6e0,
  shore: 0x6fa95a,
  treeA: 0x3f7d3a,
  treeB: 0x4f9444,
  treeC: 0x2f6a35,
  trunk: 0x6b4a2f,
  ballast: 0x958a78,
  sleeper: 0x5b4330,
  rail: 0xe2e2e2,
  deck: 0x8a6a4a,
  platform: 0xd8cfbd,
  roofStation: 0xb94a3f,
  depot: 0x9b5b45,
  depotRoof: 0x4d5f7a,
  houseWalls: [0xf3e4c4, 0xf6efe2, 0xe9d7b6, 0xefe6d8],
  houseRoofs: [0xc8553d, 0x4f74a3, 0x8a5a3c, 0x5c8a5a],
  apt: [0xe8e2d8, 0xd9e1e6, 0xefe2cf, 0xe3dcd2],
  tower: [0xcfd8e0, 0xbfcad6, 0xd8dde2, 0xc6d2cf],
  window: 0x55697d,
  sawmill: 0xa36f45,
  sawmillRoof: 0x6d4c3a,
  log: 0x8b5a2b,
  logEnd: 0xd2a26b,
  plank: 0xd9b27c,
};

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;
/** 建物を描き分ける奥行きの帯の幅（マス） */
const BAND = 6;

/** 地形の見た目が変わったかを見る値（水のマス） */
function terrainSignature(w: World): number {
  let h = 2166136261;
  for (let i = 0; i < w.terrain.length; i++) if (w.terrain[i] === Terrain.Water || w.terrain[i] === Terrain.Rock) h = Math.imul(h ^ (i * 4 + w.terrain[i]), 16777619);
  return (h ^ w.w ^ (w.h << 12)) >>> 0;
}

export class Renderer {
  app!: Application;
  cam = new Container();
  terrainG = new Graphics();
  trackG = new Graphics();
  /** 駅・車庫（建物を半透明にしても見えるように別レイヤー） */
  stationsG = new Graphics();
  /**
   * 家・ビル・木・産業。奥行き（x+y）の帯ごとに分けて描き、中身が変わった帯だけ描き直す
   * （帯の順に重ねるので、全部を奥から順に描くのと同じ見た目になる）
   */
  objectsG = new Container();
  private bands: { g: Graphics; sig: number }[] = [];
  private terrainSig = -1;
  /** 列車の路線（指令の順に通る線路） */
  routeG = new Graphics();
  overlayG = new Graphics();
  trainsG = new Graphics();
  world!: World;
  overlay: Overlay = { hover: -1, preview: null, selectedStation: -1, selectedTrain: -1 };
  private drawnVersion = -1;
  private lastStaticDraw = 0;
  private overlayDirty = true;
  private labels = new Map<string, { el: HTMLElement; x: number; y: number; lift: number }>();
  private floats: { el: HTMLElement; x: number; y: number; born: number }[] = [];
  private labelsVersion = -1;
  private lastLabelText = 0;

  private constructor(
    private host: HTMLElement,
    private labelsEl: HTMLElement,
  ) {}

  static async create(host: HTMLElement, labelsEl: HTMLElement): Promise<Renderer> {
    const r = new Renderer(host, labelsEl);
    r.app = new Application();
    await r.app.init({
      resizeTo: host,
      antialias: true,
      backgroundColor: C.bg,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      preference: 'webgl',
    });
    host.appendChild(r.app.canvas);
    r.cam.addChild(r.terrainG, r.trackG, r.stationsG, r.objectsG, r.routeG, r.overlayG, r.trainsG);
    r.app.stage.addChild(r.cam);
    return r;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  setWorld(world: World) {
    this.world = world;
    this.drawnVersion = -1;
    this.terrainSig = -1;
    for (const b of this.bands) b.sig = -1;
    this.labelsVersion = -1;
    for (const l of this.labels.values()) l.el.remove();
    this.labels.clear();
  }

  // ───────────── カメラ ─────────────

  get zoom(): number {
    return this.cam.scale.x;
  }

  screenToTileF(sx: number, sy: number): { x: number; y: number } {
    const px = (sx - this.cam.x) / this.zoom;
    const py = (sy - this.cam.y) / this.zoom;
    return worldToTile(px, py);
  }

  screenToTile(sx: number, sy: number): number {
    const p = this.screenToTileF(sx, sy);
    const x = Math.round(p.x),
      y = Math.round(p.y);
    if (x < 0 || y < 0 || x >= this.world.w || y >= this.world.h) return -1;
    return idx(this.world, x, y);
  }

  tileToScreen(x: number, y: number, lift = 0): { x: number; y: number } {
    return { x: this.cam.x + isoX(x, y) * this.zoom, y: this.cam.y + (isoY(x, y) - lift) * this.zoom };
  }

  panBy(dx: number, dy: number) {
    this.cam.x += dx;
    this.cam.y += dy;
    this.clampCamera();
  }

  zoomAt(sx: number, sy: number, factor: number) {
    const z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.zoom * factor));
    const f = z / this.zoom;
    this.cam.x = sx - (sx - this.cam.x) * f;
    this.cam.y = sy - (sy - this.cam.y) * f;
    this.cam.scale.set(z);
    this.clampCamera();
  }

  zoomStep(sx: number, sy: number, dir: 1 | -1) {
    this.zoomAt(sx, sy, dir > 0 ? 2 : 0.5);
  }

  centerOnTile(x: number, y: number, zoom?: number) {
    if (zoom) this.cam.scale.set(zoom);
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    this.cam.x = w / 2 - isoX(x, y) * this.zoom;
    this.cam.y = h / 2 - isoY(x, y) * this.zoom;
    this.clampCamera();
  }

  private clampCamera() {
    if (!this.world) return;
    const w = this.host.clientWidth,
      h = this.host.clientHeight;
    const z = this.zoom;
    const minX = isoX(0, this.world.h) * z,
      maxX = isoX(this.world.w, 0) * z;
    const minY = 0,
      maxY = isoY(this.world.w, this.world.h) * z;
    // マップの端が画面の中央より内側に入りすぎないように
    this.cam.x = Math.min(w / 2 - minX, Math.max(w / 2 - maxX, this.cam.x));
    this.cam.y = Math.min(h / 2 - minY, Math.max(h / 2 - maxY, this.cam.y));
  }

  setOverlay(o: Partial<Overlay>) {
    Object.assign(this.overlay, o);
    this.overlayDirty = true;
  }

  // ───────────── 毎フレーム ─────────────

  frame(now: number) {
    const w = this.world;
    if (!w) return;
    if (w.version !== this.drawnVersion && now - this.lastStaticDraw > 200) {
      this.drawnVersion = w.version;
      this.lastStaticDraw = now;
      // 地形（水・草地）はほとんど変わらないので、変わったときだけ描き直す
      const ts = terrainSignature(w);
      if (ts !== this.terrainSig) {
        this.terrainSig = ts;
        this.drawTerrain();
      }
      this.drawTrack();
      this.drawObjects();
      this.overlayDirty = true;
    }
    if (this.overlayDirty) {
      this.overlayDirty = false;
      this.drawOverlay();
    }
    this.drawTrains();
    this.updateLabels(now);
  }

  // ───────────── 地形 ─────────────

  private drawTerrain() {
    const g = this.terrainG;
    const w = this.world;
    g.clear();
    const groups = new Map<number, number[][]>();
    const add = (color: number, poly: number[]) => {
      let arr = groups.get(color);
      if (!arr) groups.set(color, (arr = []));
      arr.push(poly);
    };
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        const t = w.terrain[idx(w, x, y)];
        const poly = groundPoly([
          [x - 0.5, y - 0.5],
          [x + 0.5, y - 0.5],
          [x + 0.5, y + 0.5],
          [x - 0.5, y + 0.5],
        ]);
        if (t === Terrain.Water) add(hash01(x, y, 3) < 0.5 ? C.water : shade(C.water, 1.04), poly);
        else if (t === Terrain.Rock) add(hash01(x, y, 5) < 0.5 ? C.rockA : C.rockB, poly);
        else add(hash01(x, y) < 0.5 ? C.grassA : C.grassB, poly);
      }
    }
    for (const [color, polys] of groups) {
      for (const p of polys) g.poly(p);
      g.fill(color);
    }
    // 岩場の石
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        if (w.terrain[idx(w, x, y)] !== Terrain.Rock || hash01(x, y, 21) > 0.55) continue;
        const ox = hash01(x, y, 22) * 0.6 - 0.3,
          oy = hash01(x, y, 23) * 0.6 - 0.3;
        const r = 2 + hash01(x, y, 24) * 3;
        g.ellipse(isoX(x + ox, y + oy), isoY(x + ox, y + oy) - r * 0.4, r * 1.3, r * 0.8);
      }
    }
    g.fill(C.stone);
    // 水面のきらめき
    for (let y = 0; y < w.h; y++) {
      for (let x = 0; x < w.w; x++) {
        if (w.terrain[idx(w, x, y)] !== Terrain.Water || hash01(x, y, 9) > 0.35) continue;
        const ox = hash01(x, y, 11) * 0.5 - 0.25,
          oy = hash01(x, y, 12) * 0.5 - 0.25;
        g.moveTo(isoX(x + ox - 0.12, y + oy), isoY(x + ox - 0.12, y + oy)).lineTo(
          isoX(x + ox + 0.12, y + oy),
          isoY(x + ox + 0.12, y + oy),
        );
      }
    }
    g.stroke({ width: 1.5, color: C.waterHi, alpha: 0.8 });
    // マップの外枠
    g.poly(
      groundPoly([
        [-0.5, -0.5],
        [w.w - 0.5, -0.5],
        [w.w - 0.5, w.h - 0.5],
        [-0.5, w.h - 0.5],
      ]),
    ).stroke({ width: 2, color: 0x000000, alpha: 0.25 });
  }

  // ───────────── 線路 ─────────────

  private drawTrack() {
    const g = this.trackG;
    const w = this.world;
    g.clear();
    const segs: [number, number, number][] = [];
    for (let i = 0; i < w.track.length; i++) {
      const bits = w.track[i];
      if (!bits) continue;
      const x = tx(w, i),
        y = ty(w, i);
      for (const d of DIRS) if (bits & d) segs.push([x, y, d]);
      if (w.terrain[i] === Terrain.Water) {
        // 橋の床
        for (const d of DIRS) {
          if (!(bits & d)) continue;
          const ex = x + DX[d] * 0.5,
            ey = y + DY[d] * 0.5;
          g.moveTo(isoX(x, y), isoY(x, y)).lineTo(isoX(ex, ey), isoY(ex, ey));
        }
        g.stroke({ width: 16, color: C.deck, cap: 'round' });
      }
    }
    drawRails(g, segs, 1);
  }

  // ───────────── 建物など（奥から順に） ─────────────

  private drawObjects() {
    const sg = this.stationsG;
    const w = this.world;
    sg.clear();
    const nb = Math.ceil((w.w + w.h) / BAND) + 2;
    if (this.bands.length !== nb) {
      for (const b of this.bands) b.g.destroy();
      this.objectsG.removeChildren();
      this.bands = Array.from({ length: nb }, () => {
        const g = new Graphics();
        this.objectsG.addChild(g);
        return { g, sig: -1 };
      });
    }
    type Item = { depth: number; draw: (g: Graphics) => void };
    const items: Item[][] = Array.from({ length: nb }, () => []);
    const sigs: number[] = new Array(nb).fill(2166136261);
    const band = (depth: number) => Math.max(0, Math.min(nb - 1, Math.floor(depth / BAND)));
    const add = (depth: number, draw: (g: Graphics) => void, ...key: number[]) => {
      const b = band(depth);
      items[b].push({ depth, draw });
      let h = sigs[b];
      for (const k of key) h = Math.imul(h ^ (k | 0), 16777619);
      sigs[b] = h >>> 0;
    };
    const low: { depth: number; draw: () => void }[] = [];
    const doneIndustry = new Set<number>();
    for (let i = 0; i < w.occ.length; i++) {
      const x = tx(w, i),
        y = ty(w, i);
      const o = w.occ[i];
      if (!o) {
        if (w.terrain[i] === Terrain.Trees) add(x + y, (g) => drawTrees(g, x, y), 1, i);
        continue;
      }
      switch (o.k) {
        case 'house':
          add(x + y, (g) => drawHouse(g, x, y, o.level, o.variant), 2, i, o.level, o.variant);
          break;
        case 'station': {
          const st = w.stations.get(o.id);
          if (!st) break;
          const isSign = stationSign(st) === i;
          low.push({ depth: x + y - 0.1, draw: () => drawPlatform(sg, x, y, st.axis, isSign) });
          break;
        }
        case 'depot': {
          const d = w.depots.get(o.id);
          if (d) low.push({ depth: x + y, draw: () => drawDepot(sg, x, y, d.dir) });
          break;
        }
        case 'industry': {
          if (doneIndustry.has(o.id)) break;
          doneIndustry.add(o.id);
          const ind = w.industries.get(o.id)!;
          const depth = ind.x + ind.w - 1 + ind.y + ind.h - 1;
          const look = industryLook(ind);
          add(depth, (g) => drawIndustry(g, ind, look), 3, ind.id, ind.x, ind.y, ...look.key);
          break;
        }
      }
    }
    low.sort((a, b) => a.depth - b.depth);
    for (const it of low) it.draw();
    // 探鉱中の場所には旗
    for (const sv of w.surveys) {
      const spec = INDUSTRY_SPECS[sv.type];
      add(sv.x + sv.y + spec.w + spec.h - 2, (g) => drawSurvey(g, sv.x, sv.y, spec.w, spec.h), 4, sv.x, sv.y, spec.w, spec.h);
    }
    for (let b = 0; b < nb; b++) {
      const sig = (sigs[b] ^ items[b].length) >>> 0;
      if (this.bands[b].sig === sig) continue;
      this.bands[b].sig = sig;
      const g = this.bands[b].g;
      g.clear();
      items[b].sort((p, q) => p.depth - q.depth);
      for (const it of items[b]) it.draw(g);
    }
  }

  // ───────────── 建物の半透明・路線 ─────────────

  /** 建物（家・ビル・木・産業）を半透明にする。駅を選ぶとき・X キー */
  setFaded(on: boolean) {
    this.objectsG.alpha = on ? 0.28 : 1;
  }

  get faded(): boolean {
    return this.objectsG.alpha < 1;
  }

  private routeNumbers = new Map<number, number[]>();

  /**
   * 列車の路線を描く。paths[i] は stops[i] → stops[i+1]（最後は最初へ戻る）の経路。
   * つながっていない区間は null（赤い点線で描く）
   */
  setRoute(route: { stops: number[]; paths: (number[] | null)[]; current: number } | null) {
    const g = this.routeG;
    const w = this.world;
    g.clear();
    this.routeNumbers.clear();
    this.labelsVersion = -1;
    if (!route || !w) return;
    route.stops.forEach((id, i) => {
      const arr = this.routeNumbers.get(id) ?? [];
      arr.push(i + 1);
      this.routeNumbers.set(id, arr);
    });
    const lift = 3;
    route.paths.forEach((path, i) => {
      const from = w.stations.get(route.stops[i]);
      const to = w.stations.get(route.stops[(i + 1) % route.stops.length]);
      if (!from || !to) return;
      const active = i === (route.current - 1 + route.stops.length) % route.stops.length;
      if (path && path.length > 1) {
        const pts = path.map((t) => groundPoly([[tx(w, t), ty(w, t)]], lift));
        g.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
        g.stroke({ width: 10, color: 0x1f332b, alpha: 0.55, cap: 'round', join: 'round' });
        g.moveTo(pts[0][0], pts[0][1]);
        for (const p of pts.slice(1)) g.lineTo(p[0], p[1]);
        g.stroke({ width: 6, color: active ? 0xffe066 : 0xf2c14e, alpha: 0.95, cap: 'round', join: 'round' });
      } else {
        // つながっていない：赤い点線
        const a = stationSign(from),
          b = stationSign(to);
        const ax = tx(w, a),
          ay = ty(w, a),
          bx = tx(w, b),
          by = ty(w, b);
        const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 0.6));
        for (let k = 0; k < n; k += 2) {
          const p = groundPoly([[ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]], lift);
          const q = groundPoly([[ax + ((bx - ax) * (k + 1)) / n, ay + ((by - ay) * (k + 1)) / n]], lift);
          g.moveTo(p[0], p[1]).lineTo(q[0], q[1]);
        }
        g.stroke({ width: 5, color: 0xff5a4a, alpha: 0.9, cap: 'round' });
      }
    });
  }

  // ───────────── プレビュー・選択 ─────────────

  private drawOverlay() {
    const g = this.overlayG;
    const w = this.world;
    g.clear();
    const o = this.overlay;
    const pv = o.preview;
    if (pv?.catchment) {
      const r = pv.catchment;
      g.poly(
        groundPoly([
          [r.x0 - 0.5, r.y0 - 0.5],
          [r.x1 + 0.5, r.y0 - 0.5],
          [r.x1 + 0.5, r.y1 + 0.5],
          [r.x0 - 0.5, r.y1 + 0.5],
        ]),
      )
        .fill({ color: 0x9fd3ff, alpha: 0.16 })
        .stroke({ width: 2, color: 0xffffff, alpha: 0.6 });
    }
    for (const m of pv?.marks ?? []) {
      g.poly(
        groundPoly([
          [m.x - 0.5, m.y - 0.5],
          [m.x + m.w - 0.5, m.y - 0.5],
          [m.x + m.w - 0.5, m.y + m.h - 0.5],
          [m.x - 0.5, m.y + m.h - 0.5],
        ]),
      )
        .fill({ color: m.ok ? 0x5fd17a : 0x9a9a9a, alpha: 0.22 })
        .stroke({ width: 3, color: m.ok ? 0x2f8a4a : 0x6a6a6a, alpha: 0.9 });
    }
    if (o.selectedStation >= 0) {
      const st = w.stations.get(o.selectedStation);
      if (st) for (const t of st.tiles) tileDiamond(g, tx(w, t), ty(w, t), 0xffe066, 0.35);
    }
    if (pv) {
      const color = !pv.ok ? 0xff5a4a : pv.remove || pv.kind === 'demolish' ? 0xffa040 : 0xffffff;
      for (const t of pv.tiles) tileDiamond(g, tx(w, t), ty(w, t), color, 0.32);
      if (pv.path && pv.path.length > 1 && !pv.remove) {
        const segs: [number, number, number][] = [];
        for (let k = 0; k < pv.path.length; k++) {
          const t = pv.path[k];
          const x = tx(w, t),
            y = ty(w, t);
          for (const nb of [pv.path[k - 1], pv.path[k + 1]]) {
            if (nb === undefined) continue;
            const dx = tx(w, nb) - x,
              dy = ty(w, nb) - y;
            const d = DIRS.find((dd) => DX[dd] === dx && DY[dd] === dy);
            if (d) segs.push([x, y, d]);
          }
        }
        drawRails(g, segs, 0.55, pv.ok ? undefined : 0xff5a4a);
      }
      if (pv.kind === 'station' && pv.axis) {
        const dirs = pv.axis === 'x' ? [2, 8] : [1, 4];
        const segs: [number, number, number][] = [];
        for (const t of pv.tiles) for (const d of dirs) segs.push([tx(w, t), ty(w, t), d]);
        drawRails(g, segs, 0.75, pv.ok ? undefined : 0xff5a4a);
      }
    }
    if (o.hover >= 0 && !pv) {
      const x = tx(w, o.hover),
        y = ty(w, o.hover);
      g.poly(
        groundPoly([
          [x - 0.5, y - 0.5],
          [x + 0.5, y - 0.5],
          [x + 0.5, y + 0.5],
          [x - 0.5, y + 0.5],
        ]),
      ).stroke({ width: 2, color: 0xffffff, alpha: 0.85 });
    }
  }

  // ───────────── 列車 ─────────────

  private drawTrains() {
    const g = this.trainsG;
    g.clear();
    const w = this.world;
    for (const t of w.trains.values()) {
      if (t.state === 'in_depot') continue;
      const poly = trainPolyline(w, t);
      for (let k = 0; k < t.cars.length; k++) {
        const s = 0.22 + k * 0.47;
        const a = pointAt(poly, s);
        const b = pointAt(poly, s + 0.2);
        const c = pointAt(poly, s - 0.2);
        let dx = c.x - b.x,
          dy = c.y - b.y;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        drawCar(g, a.x, a.y, dx, dy, t.cars[k], t.id === this.overlay.selectedTrain);
      }
    }
  }

  trainAt(sx: number, sy: number): number {
    const w = this.world;
    let best = -1,
      bd = 22;
    for (const t of w.trains.values()) {
      if (t.state === 'in_depot') continue;
      const poly = trainPolyline(w, t);
      for (let k = 0; k < t.cars.length; k++) {
        const p = pointAt(poly, 0.22 + k * 0.47);
        const s = this.tileToScreen(p.x, p.y, 6);
        const d = Math.hypot(s.x - sx, s.y - sy);
        if (d < bd) {
          bd = d;
          best = t.id;
        }
      }
    }
    return best;
  }

  // ───────────── 文字（DOMで重ねる：フォントがきれいに出る） ─────────────

  private label(key: string, html: string, cls: string, x: number, y: number, lift: number) {
    let l = this.labels.get(key);
    if (!l) {
      const el = document.createElement('div');
      el.className = `map-label ${cls}`;
      this.labelsEl.appendChild(el);
      l = { el, x, y, lift };
      this.labels.set(key, l);
    }
    if (l.el.innerHTML !== html) l.el.innerHTML = html;
    l.x = x;
    l.y = y;
    l.lift = lift;
    return l;
  }

  private updateLabels(now: number) {
    const w = this.world;
    if (this.labelsVersion !== w.version || now - this.lastLabelText > 1000) {
      this.labelsVersion = w.version;
      this.lastLabelText = now;
      const live = new Set<string>();
      const boomed = new Set(activeBooms(w).map((b) => `${b.target.kind}:${b.target.id}`));
      const tag = (k: string) => (boomed.has(k) ? '<em class="boom" title="ブーム中">↑</em>' : '');
      for (const town of w.towns.values()) {
        const k = `town${town.id}`;
        live.add(k);
        this.label(
          k,
          `<i class="stage-tag s${townStage(town)}">${stageName(town)}</i><b>${esc(townLabel(town))}</b><span>${town.population.toLocaleString('ja-JP')}人</span>${tag(`town:${town.id}`)}`,
          'town',
          town.cx,
          town.cy,
          36,
        );
      }
      for (const st of w.stations.values()) {
        const k = `st${st.id}`;
        live.add(k);
        const s = stationSign(st);
        const nums = this.routeNumbers.get(st.id);
        const badge = nums ? nums.map((n) => `<i class="ord">${n}</i>`).join('') : '';
        const l = this.label(k, `${badge}${esc(st.name)}`, `station${nums ? ' in-route' : ''}`, tx(w, s), ty(w, s), 22);
        l.el.dataset.station = String(st.id);
        l.el.classList.toggle('in-route', !!nums);
      }
      for (const ind of w.industries.values()) {
        const k = `ind${ind.id}`;
        live.add(k);
        const ol = ownerLabel(w, ind);
        const cls = ol === '自社' ? 'own' : ol === '他社' ? 'other' : ol === '契約中' ? 'contract' : ol === '建設中' ? 'building' : '';
        const st = industryStatus(w, ind);
        this.label(
          k,
          `<i class="st ${st.tone}" title="${esc(st.text)}"></i>${esc(ind.name)}${ol !== '地元' ? `<small>${ol}</small>` : ''}${tag(`industry:${ind.id}`)}`,
          `industry ${cls}`,
          ind.x + (ind.w - 1) / 2,
          ind.y + (ind.h - 1) / 2,
          46,
        );
      }
      for (const [k, l] of this.labels) {
        if (!live.has(k)) {
          l.el.remove();
          this.labels.delete(k);
        }
      }
    }
    const small = this.zoom < 0.4;
    this.labelsEl.classList.toggle('far', small);
    for (const l of this.labels.values()) {
      const p = this.tileToScreen(l.x, l.y, l.lift);
      l.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
    }
    // 収入の浮き文字
    this.floats = this.floats.filter((f) => {
      const age = now - f.born;
      if (age > 2200) {
        f.el.remove();
        return false;
      }
      const p = this.tileToScreen(f.x, f.y, 20 + age * 0.02);
      f.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -100%)`;
      f.el.style.opacity = String(Math.min(1, (2200 - age) / 600));
      return true;
    });
  }

  floatText(tile: number, text: string, cls = 'income') {
    const el = document.createElement('div');
    el.className = `float-text ${cls}`;
    el.textContent = text;
    this.labelsEl.appendChild(el);
    this.floats.push({ el, x: tx(this.world, tile), y: ty(this.world, tile), born: performance.now() });
  }
}

// ───────────── 描画の部品 ─────────────

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function tileDiamond(g: Graphics, x: number, y: number, color: number, alpha: number) {
  g.poly(
    groundPoly([
      [x - 0.5, y - 0.5],
      [x + 0.5, y - 0.5],
      [x + 0.5, y + 0.5],
      [x - 0.5, y + 0.5],
    ]),
  ).fill({ color, alpha });
}

/** 線路：道床 → 枕木 → レール の順に描く */
function drawRails(g: Graphics, segs: [number, number, number][], alpha: number, tint?: number) {
  for (const [x, y, d] of segs) {
    const ex = x + DX[d] * 0.5,
      ey = y + DY[d] * 0.5;
    g.moveTo(isoX(x, y), isoY(x, y)).lineTo(isoX(ex, ey), isoY(ex, ey));
  }
  g.stroke({ width: 11, color: tint ?? C.ballast, alpha, cap: 'round' });
  for (const [x, y, d] of segs) {
    const px = DY[d] !== 0 ? 1 : 0,
      py = DX[d] !== 0 ? 1 : 0; // 地面上で直角の向き
    for (const f of [0.12, 0.37]) {
      const cx = x + DX[d] * f,
        cy = y + DY[d] * f;
      g.moveTo(isoX(cx - px * 0.2, cy - py * 0.2), isoY(cx - px * 0.2, cy - py * 0.2)).lineTo(
        isoX(cx + px * 0.2, cy + py * 0.2),
        isoY(cx + px * 0.2, cy + py * 0.2),
      );
    }
  }
  g.stroke({ width: 3, color: tint ?? C.sleeper, alpha });
  for (const [x, y, d] of segs) {
    const px = DY[d] !== 0 ? 1 : 0,
      py = DX[d] !== 0 ? 1 : 0;
    for (const o of [-0.11, 0.11]) {
      const sx = x + px * o,
        sy = y + py * o;
      const ex = sx + DX[d] * 0.5,
        ey = sy + DY[d] * 0.5;
      g.moveTo(isoX(sx, sy), isoY(sx, sy)).lineTo(isoX(ex, ey), isoY(ex, ey));
    }
  }
  g.stroke({ width: 1.6, color: tint ? 0xffffff : C.rail, alpha });
}

/** 直方体（タイル座標で x0..x1, y0..y1、高さ h px） */
function box(g: Graphics, x0: number, y0: number, x1: number, y1: number, h: number, color: number, base = 0) {
  // +y 側の面（画面の左下）
  g.poly([
    ...groundPoly([[x0, y1]], base),
    ...groundPoly([[x1, y1]], base),
    ...groundPoly([[x1, y1]], base + h),
    ...groundPoly([[x0, y1]], base + h),
  ]).fill(shade(color, 0.82));
  // +x 側の面（画面の右下）
  g.poly([
    ...groundPoly([[x1, y0]], base),
    ...groundPoly([[x1, y1]], base),
    ...groundPoly([[x1, y1]], base + h),
    ...groundPoly([[x1, y0]], base + h),
  ]).fill(shade(color, 0.66));
  // 上面
  g.poly(
    groundPoly(
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
      ],
      base + h,
    ),
  ).fill(color);
}

/** 寄棟屋根 */
function hipRoof(g: Graphics, x0: number, y0: number, x1: number, y1: number, base: number, rh: number, color: number) {
  const cx = (x0 + x1) / 2,
    cy = (y0 + y1) / 2;
  const apex = groundPoly([[cx, cy]], base + rh);
  const tri = (a: [number, number], b: [number, number], f: number) =>
    g.poly([...groundPoly([a], base), ...groundPoly([b], base), ...apex]).fill(shade(color, f));
  tri([x0, y0], [x1, y0], 1.12);
  tri([x0, y0], [x0, y1], 1.05);
  tri([x0, y1], [x1, y1], 0.9);
  tri([x1, y0], [x1, y1], 0.72);
}

function windowBands(g: Graphics, x0: number, y0: number, x1: number, y1: number, h: number, floors: number) {
  const fh = h / floors;
  for (let f = 0; f < floors; f++) {
    const b = f * fh + fh * 0.35,
      t = f * fh + fh * 0.7;
    g.poly([
      ...groundPoly([[x0 + 0.06, y1]], b),
      ...groundPoly([[x1 - 0.06, y1]], b),
      ...groundPoly([[x1 - 0.06, y1]], t),
      ...groundPoly([[x0 + 0.06, y1]], t),
    ]).fill({ color: C.window, alpha: 0.55 });
    g.poly([
      ...groundPoly([[x1, y0 + 0.06]], b),
      ...groundPoly([[x1, y1 - 0.06]], b),
      ...groundPoly([[x1, y1 - 0.06]], t),
      ...groundPoly([[x1, y0 + 0.06]], t),
    ]).fill({ color: C.window, alpha: 0.65 });
  }
}

function drawHouse(g: Graphics, x: number, y: number, level: 1 | 2 | 3, variant: number) {
  const j = (hash01(x, y, 5) - 0.5) * 0.08;
  if (level === 1) {
    const s = 0.26;
    box(g, x - s + j, y - s, x + s + j, y + s, 11, C.houseWalls[variant % 4]);
    hipRoof(g, x - s - 0.04 + j, y - s - 0.04, x + s + 0.04 + j, y + s + 0.04, 11, 10, C.houseRoofs[variant % 4]);
  } else if (level === 2) {
    const s = 0.34;
    const col = C.apt[variant % 4];
    box(g, x - s, y - s, x + s, y + s, 26, col);
    windowBands(g, x - s, y - s, x + s, y + s, 26, 3);
    box(g, x - s - 0.02, y - s - 0.02, x + s + 0.02, y + s + 0.02, 2, shade(col, 0.9), 26);
  } else {
    const s = 0.38;
    const col = C.tower[variant % 4];
    box(g, x - s, y - s, x + s, y + s, 58, col);
    windowBands(g, x - s, y - s, x + s, y + s, 58, 8);
    box(g, x - 0.12, y - 0.12, x + 0.08, y + 0.08, 6, shade(col, 0.8), 58);
  }
}

function drawTrees(g: Graphics, x: number, y: number) {
  const n = 2 + Math.floor(hash01(x, y, 1) * 2);
  const pts: { ox: number; oy: number; k: number }[] = [];
  for (let k = 0; k < n; k++) {
    pts.push({ ox: hash01(x, y, 10 + k) * 0.7 - 0.35, oy: hash01(x, y, 20 + k) * 0.7 - 0.35, k });
  }
  pts.sort((a, b) => a.ox + a.oy - (b.ox + b.oy));
  for (const p of pts) tree(g, x + p.ox, y + p.oy, 0.8 + hash01(x, y, 30 + p.k) * 0.5, hash01(x, y, 40 + p.k));
}

function tree(g: Graphics, x: number, y: number, size: number, kind: number) {
  const sx = isoX(x, y),
    sy = isoY(x, y);
  g.ellipse(sx, sy, 6 * size, 3 * size).fill({ color: 0x000000, alpha: 0.12 });
  g.rect(sx - 1.2 * size, sy - 8 * size, 2.4 * size, 8 * size).fill(C.trunk);
  if (kind < 0.45) {
    // 針葉樹
    const c = kind < 0.2 ? C.treeC : C.treeA;
    g.poly([sx, sy - 24 * size, sx + 7 * size, sy - 6 * size, sx - 7 * size, sy - 6 * size]).fill(c);
    g.poly([sx, sy - 24 * size, sx + 7 * size, sy - 6 * size, sx, sy - 6 * size]).fill(shade(c, 0.8));
  } else {
    const c = kind < 0.75 ? C.treeB : C.treeA;
    g.circle(sx, sy - 13 * size, 7 * size).fill(c);
    g.circle(sx - 2 * size, sy - 15 * size, 4 * size).fill(shade(c, 1.15));
  }
}

function drawPlatform(g: Graphics, x: number, y: number, axis: 'x' | 'y', withRoof: boolean) {
  // 線路の両側にホーム
  const along = 0.5;
  for (const side of [-1, 1]) {
    if (axis === 'x') {
      const y0 = y + side * 0.3 - 0.11,
        y1 = y + side * 0.3 + 0.11;
      box(g, x - along, Math.min(y0, y1), x + along, Math.max(y0, y1), 4, C.platform);
    } else {
      const x0 = x + side * 0.3 - 0.11,
        x1 = x + side * 0.3 + 0.11;
      box(g, Math.min(x0, x1), y - along, Math.max(x0, x1), y + along, 4, C.platform);
    }
  }
  if (withRoof) {
    // 駅舎の屋根（看板のあるタイル）
    if (axis === 'x') {
      box(g, x - 0.3, y - 0.48, x + 0.3, y - 0.36, 14, 0xe9e0cc, 4);
      box(g, x - 0.42, y - 0.5, x + 0.42, y - 0.12, 2, C.roofStation, 18);
    } else {
      box(g, x - 0.48, y - 0.3, x - 0.36, y + 0.3, 14, 0xe9e0cc, 4);
      box(g, x - 0.5, y - 0.42, x - 0.12, y + 0.42, 2, C.roofStation, 18);
    }
  }
}

function drawDepot(g: Graphics, x: number, y: number, dir: number) {
  const s = 0.4;
  box(g, x - s, y - s, x + s, y + s, 18, C.depot);
  // 入口
  if (dir === 4 /* S */) {
    g.poly([
      ...groundPoly([[x - 0.2, y + s]], 0),
      ...groundPoly([[x + 0.2, y + s]], 0),
      ...groundPoly([[x + 0.2, y + s]], 13),
      ...groundPoly([[x - 0.2, y + s]], 13),
    ]).fill(0x2a2420);
  } else if (dir === 2 /* E */) {
    g.poly([
      ...groundPoly([[x + s, y - 0.2]], 0),
      ...groundPoly([[x + s, y + 0.2]], 0),
      ...groundPoly([[x + s, y + 0.2]], 13),
      ...groundPoly([[x + s, y - 0.2]], 13),
    ]).fill(0x2a2420);
  }
  hipRoof(g, x - s - 0.03, y - s - 0.03, x + s + 0.03, y + s + 0.03, 18, 9, C.depotRoof);
}

function drawForest(g: Graphics, x0: number, y0: number, w: number, h: number) {
  g.poly(
    groundPoly([
      [x0 - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 + h - 0.5],
      [x0 - 0.5, y0 + h - 0.5],
    ]),
  ).fill({ color: 0x5e8f3e, alpha: 0.9 });
  const trees: { x: number; y: number; s: number; k: number }[] = [];
  for (let yy = 0; yy < h; yy++) {
    for (let xx = 0; xx < w; xx++) {
      for (let k = 0; k < 3; k++) {
        const ox = hash01(x0 + xx, y0 + yy, 50 + k) * 0.8 - 0.4,
          oy = hash01(x0 + xx, y0 + yy, 60 + k) * 0.8 - 0.4;
        if (xx === w - 1 && yy === h - 1 && k > 0) continue; // 小屋の場所
        trees.push({ x: x0 + xx + ox, y: y0 + yy + oy, s: 1 + hash01(x0 + xx, y0 + yy, 70 + k) * 0.4, k: hash01(x0 + xx, y0 + yy, 80 + k) * 0.45 });
      }
    }
  }
  trees.sort((a, b) => a.x + a.y - (b.x + b.y));
  for (const t of trees) tree(g, t.x, t.y, t.s, t.k);
  // 小屋と丸太の山
  const hx = x0 + w - 1,
    hy = y0 + h - 1;
  box(g, hx - 0.3, hy - 0.2, hx + 0.15, hy + 0.3, 12, 0x8a6240);
  hipRoof(g, hx - 0.34, hy - 0.24, hx + 0.19, hy + 0.34, 12, 8, 0x5a3f2c);
  logPile(g, hx + 0.32, hy - 0.05, 3);
}

function logPile(g: Graphics, x: number, y: number, rows: number) {
  for (let r = 0; r < rows; r++) {
    for (let k = 0; k < rows - r; k++) {
      const cx = x + (k - (rows - r - 1) / 2) * 0.12;
      const sx = isoX(cx, y),
        sy = isoY(cx, y) - 3 - r * 4.2;
      g.ellipse(sx, sy, 2.6, 2.6).fill(C.logEnd).stroke({ width: 1, color: C.log });
    }
  }
}

function drawSawmill(g: Graphics, x0: number, y0: number, w: number, h: number, inStock: number, outStock: number) {
  g.poly(
    groundPoly([
      [x0 - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 + h - 0.5],
      [x0 - 0.5, y0 + h - 0.5],
    ]),
  ).fill(0xb7a98c);
  // 原木置き場（在庫が多いほど高く積む）
  const logRows = Math.min(4, Math.ceil(inStock / 100));
  for (let k = 0; k < 3; k++) if (logRows > 0) logPile(g, x0 - 0.2 + k * 0.32, y0 - 0.15, logRows);
  // 工場
  box(g, x0 + 0.1, y0 - 0.4, x0 + w - 0.5, y0 + h - 0.55, 24, C.sawmill);
  // のこぎり屋根
  for (let k = 0; k < 3; k++) {
    const a = x0 + 0.1 + k * ((w - 0.6) / 3);
    const b = a + (w - 0.6) / 3;
    g.poly([
      ...groundPoly([[a, y0 - 0.4]], 24),
      ...groundPoly([[b, y0 - 0.4]], 24),
      ...groundPoly([[b, y0 + h - 0.55]], 24),
      ...groundPoly([[a, y0 + h - 0.55]], 24),
      ...groundPoly([[a, y0 + h - 0.55]], 32),
      ...groundPoly([[a, y0 - 0.4]], 32),
    ]).fill(shade(C.sawmillRoof, 1 + k * 0.05));
  }
  // 煙突
  box(g, x0 + w - 0.95, y0 - 0.35, x0 + w - 0.75, y0 - 0.15, 46, 0x7a6a62);
  // 木材置き場
  const planks = Math.min(5, Math.ceil(outStock / 80));
  for (let k = 0; k < planks; k++) {
    box(g, x0 + 0.3, y0 + h - 0.45, x0 + 1.2, y0 + h - 0.15, 2.4, k % 2 ? C.plank : shade(C.plank, 0.92), k * 2.6);
  }
}

/** 産業の種類ごとに描き分ける */
/** 産業の見た目を決める値（在庫の山は 25t きざみ）。key が同じなら見た目も同じ */
function industryLook(ind: Industry) {
  const q = (v: number) => Math.round(v / 25) * 25;
  const look = {
    building: ind.status === 'building',
    inStock: q(ind.inputs.logs ?? 0),
    outStock: q(ind.outStock),
    active: ind.producedThisMonth + ind.producedLastMonth > 0,
    key: [] as number[],
  };
  look.key = [INDUSTRY_TYPES.indexOf(ind.type), ind.w, ind.h, +look.building, look.inStock, look.outStock, +look.active];
  return look;
}

const INDUSTRY_TYPES = Object.keys(INDUSTRY_SPECS);

function drawIndustry(g: Graphics, ind: Industry, look = industryLook(ind)) {
  const { x, y, w, h } = ind;
  if (look.building) return drawConstruction(g, x, y, w, h);
  const pile = (c: number, cap = 500) => Math.min(1, c / cap);
  switch (ind.type) {
    case 'forest':
      return drawForest(g, x, y, w, h);
    case 'sawmill':
      return drawSawmill(g, x, y, w, h, look.inStock, look.outStock);
    case 'farm':
      return drawFarm(g, x, y, w, h);
    case 'ironmine':
      return drawMine(g, x, y, w, h, 0xa0543c, pile(look.outStock));
    case 'coalmine':
      return drawMine(g, x, y, w, h, 0x2b2b2e, pile(look.outStock));
    case 'foodplant':
      return drawFoodPlant(g, x, y, w, h);
    case 'steelmill':
      return drawSteelMill(g, x, y, w, h, look.active);
    case 'materialsplant':
      return drawMaterialsPlant(g, x, y, w, h, pile(look.outStock));
    case 'ranch':
      return drawRanch(g, x, y, w, h);
    case 'fishery':
      return drawFishery(g, x, y, w, h);
  }
}

/** 建設中の工場：囲いと足場とクレーン */
function drawConstruction(g: Graphics, x0: number, y0: number, w: number, h: number) {
  lot(g, x0, y0, w, h, 0xb59a74);
  for (let k = 0; k < 3; k++) {
    const x = x0 + 0.1 + k * ((w - 0.8) / 2);
    box(g, x - 0.06, y0 - 0.2, x + 0.06, y0 + h - 0.8, 16 + k * 4, 0x9a8a74);
  }
  box(g, x0 - 0.1, y0 - 0.25, x0 + w - 0.9, y0 + h - 0.75, 2, 0xd9a441, 12);
  box(g, x0 + w - 0.7, y0 + h - 1.0, x0 + w - 0.6, y0 + h - 0.9, 44, 0xe2b13c);
  box(g, x0 + w - 1.8, y0 + h - 1.0, x0 + w - 0.6, y0 + h - 0.9, 2, 0xe2b13c, 44);
}

/** 探鉱中の場所：杭と旗 */
function drawSurvey(g: Graphics, x0: number, y0: number, w: number, h: number) {
  const corners: [number, number][] = [
    [x0 - 0.4, y0 - 0.4],
    [x0 + w - 0.6, y0 - 0.4],
    [x0 + w - 0.6, y0 + h - 0.6],
    [x0 - 0.4, y0 + h - 0.6],
  ];
  const p = groundPoly(corners);
  g.poly(p).stroke({ width: 2, color: 0xffffff, alpha: 0.7 });
  for (const [cx, cy] of corners) g.rect(isoX(cx, cy) - 1, isoY(cx, cy) - 8, 2, 8).fill(0x7a5a3a);
  const fx = isoX(x0 + (w - 1) / 2, y0 + (h - 1) / 2),
    fy = isoY(x0 + (w - 1) / 2, y0 + (h - 1) / 2);
  g.rect(fx - 1, fy - 26, 2, 26).fill(0x5a4a3a);
  g.poly([fx + 1, fy - 26, fx + 14, fy - 21, fx + 1, fy - 16]).fill(0xe2574a);
}

function lot(g: Graphics, x0: number, y0: number, w: number, h: number, color: number) {
  g.poly(
    groundPoly([
      [x0 - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 - 0.5],
      [x0 + w - 0.5, y0 + h - 0.5],
      [x0 - 0.5, y0 + h - 0.5],
    ]),
  ).fill(color);
}

/** 円柱（タンク・サイロ） */
function cylinder(g: Graphics, x: number, y: number, r: number, h: number, color: number, base = 0) {
  const sx = isoX(x, y),
    sy = isoY(x, y) - base;
  const rx = r * TW * 0.7,
    ry = rx / 2;
  g.rect(sx - rx, sy - h, rx * 2, h).fill(shade(color, 0.8));
  g.ellipse(sx, sy, rx, ry).fill(shade(color, 0.8));
  g.rect(sx - rx, sy - h, rx, h).fill(shade(color, 0.9));
  g.ellipse(sx, sy - h, rx, ry).fill(color);
}

/** 円すいの山（鉱石・石炭） */
function heap(g: Graphics, x: number, y: number, r: number, hgt: number, color: number) {
  const sx = isoX(x, y),
    sy = isoY(x, y);
  const rx = r * TW * 0.7;
  g.poly([sx - rx, sy, sx + rx, sy, sx, sy - hgt]).fill(color);
  g.poly([sx, sy - hgt, sx + rx, sy, sx, sy + rx / 4]).fill(shade(color, 0.75));
}

function drawFarm(g: Graphics, x0: number, y0: number, w: number, h: number) {
  lot(g, x0, y0, w, h, 0xc9b25a);
  // 畑のうね
  for (let k = 0; k < w * 4; k++) {
    const xx = x0 - 0.5 + (k + 0.5) / 4;
    const a = groundPoly([[xx, y0 - 0.45]]),
      b = groundPoly([[xx, y0 + h - 1.55]]);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
  }
  g.stroke({ width: 2, color: 0x9c8a3c, alpha: 0.8 });
  // 納屋とサイロ
  const bx = x0 + w - 1,
    by = y0 + h - 1;
  box(g, bx - 0.35, by - 0.3, bx + 0.25, by + 0.3, 13, 0xb5433a);
  hipRoof(g, bx - 0.38, by - 0.33, bx + 0.28, by + 0.33, 13, 9, 0x6b3a2c);
  cylinder(g, x0 + 0.3, y0 + h - 1, 0.14, 26, 0xd6d8d2);
}

/** 牧場：柵の中の草地と、牛と、赤い牛舎 */
function drawRanch(g: Graphics, x0: number, y0: number, w: number, h: number) {
  lot(g, x0, y0, w, h, 0x9fcf72);
  // 柵
  const c = [
    [x0 - 0.45, y0 - 0.45],
    [x0 + w - 0.55, y0 - 0.45],
    [x0 + w - 0.55, y0 + h - 0.55],
    [x0 - 0.45, y0 + h - 0.55],
  ] as [number, number][];
  for (let k = 0; k < 4; k++) {
    const a = groundPoly([c[k]], 4),
      b = groundPoly([c[(k + 1) % 4]], 4);
    g.moveTo(a[0], a[1]).lineTo(b[0], b[1]);
  }
  g.stroke({ width: 1.5, color: 0xf3ecd8 });
  // 牛（白と黒のまだら）
  for (let k = 0; k < 4; k++) {
    const cx = x0 + 0.2 + hash01(x0, y0 + k, 31) * (w - 1.6),
      cy = y0 + 0.4 + hash01(x0 + k, y0, 32) * (h - 1.4);
    box(g, cx - 0.12, cy - 0.07, cx + 0.12, cy + 0.07, 5, k % 2 ? 0xf6f2ea : 0x3a3430);
  }
  // 牛舎
  const bx = x0 + w - 1,
    by = y0 + h - 1;
  box(g, bx - 0.35, by - 0.28, bx + 0.3, by + 0.3, 12, 0xb5433a);
  hipRoof(g, bx - 0.38, by - 0.31, bx + 0.33, by + 0.33, 12, 7, 0x5a3a2c);
}

/** 漁港：桟橋と漁船と、魚をしまう倉庫 */
function drawFishery(g: Graphics, x0: number, y0: number, w: number, h: number) {
  lot(g, x0, y0, w, h, 0xb9b0a0);
  box(g, x0 - 0.35, y0 - 0.3, x0 + 0.45, y0 + 0.35, 11, 0xd9dde2);
  hipRoof(g, x0 - 0.38, y0 - 0.33, x0 + 0.48, y0 + 0.38, 11, 6, 0x4f74a3);
  // 箱と、旗の立った小屋
  box(g, x0 + w - 1.3, y0 + h - 1.3, x0 + w - 1.0, y0 + h - 1.0, 4, 0x6fa8c8);
  box(g, x0 + w - 0.9, y0 + h - 1.3, x0 + w - 0.6, y0 + h - 1.0, 4, 0x6fa8c8);
  box(g, x0 + 0.6, y0 + h - 0.9, x0 + 0.9, y0 + h - 0.6, 4, 0x8a6a4a);
}

function drawMine(g: Graphics, x0: number, y0: number, w: number, h: number, color: number, fill: number) {
  lot(g, x0, y0, w, h, 0x8b7a62);
  // やぐら
  const tx0 = x0 + 0.1,
    ty0 = y0 + 0.1;
  box(g, tx0 - 0.25, ty0 - 0.25, tx0 - 0.15, ty0 + 0.25, 34, 0x5a4a3a);
  box(g, tx0 + 0.15, ty0 - 0.25, tx0 + 0.25, ty0 + 0.25, 34, 0x5a4a3a);
  box(g, tx0 - 0.28, ty0 - 0.28, tx0 + 0.28, ty0 + 0.28, 3, 0x3d3229, 34);
  g.circle(isoX(tx0, ty0), isoY(tx0, ty0) - 40, 5).fill(0x2a2420).stroke({ width: 1.5, color: 0x8a7a68 });
  // 小屋
  box(g, x0 + 0.6, y0 + 0.55, x0 + 1.2, y0 + 1.25, 10, 0x9a8a74);
  // 掘り出したものの山（在庫が多いほど大きい）
  heap(g, x0 + w - 0.75, y0 - 0.1, 0.22, 6 + 16 * fill, color);
  if (fill > 0.4) heap(g, x0 + w - 0.95, y0 + 0.35, 0.18, 4 + 10 * fill, color);
}

function drawFoodPlant(g: Graphics, x0: number, y0: number, w: number, h: number) {
  lot(g, x0, y0, w, h, 0xc8c4b8);
  box(g, x0 - 0.2, y0 - 0.35, x0 + w - 1.2, y0 + h - 0.6, 20, 0xf1eee6);
  box(g, x0 - 0.22, y0 - 0.37, x0 + w - 1.18, y0 + h - 0.58, 2, 0x4f7d9a, 20);
  cylinder(g, x0 + w - 0.85, y0 - 0.1, 0.16, 30, 0xe6e9ec);
  cylinder(g, x0 + w - 0.85, y0 + 0.55, 0.16, 30, 0xe6e9ec);
}

function drawSteelMill(g: Graphics, x0: number, y0: number, w: number, h: number, working: boolean) {
  lot(g, x0, y0, w, h, 0x77726c);
  box(g, x0 - 0.3, y0 + 0.3, x0 + w - 1.4, y0 + h - 0.6, 26, 0x4a4e55);
  box(g, x0 - 0.32, y0 + 0.28, x0 + w - 1.38, y0 + h - 0.58, 3, 0x353a40, 26);
  // 高炉
  cylinder(g, x0 + w - 1.0, y0 + 0.1, 0.22, 46, 0x5d5853);
  if (working) g.circle(isoX(x0 + w - 1.0, y0 + 0.1), isoY(x0 + w - 1.0, y0 + 0.1) - 14, 4).fill({ color: 0xff8a3a, alpha: 0.9 });
  // 煙突
  box(g, x0 - 0.1, y0 - 0.35, x0 + 0.08, y0 - 0.17, 58, 0x6a6058);
  box(g, x0 + 0.4, y0 - 0.35, x0 + 0.58, y0 - 0.17, 50, 0x6a6058);
  if (working) {
    for (const [cx, hh] of [
      [x0, 62],
      [x0 + 0.5, 54],
    ] as const) {
      g.circle(isoX(cx, y0 - 0.26), isoY(cx, y0 - 0.26) - hh, 6).fill({ color: 0xdedede, alpha: 0.55 });
    }
  }
}

function drawMaterialsPlant(g: Graphics, x0: number, y0: number, w: number, h: number, fill: number) {
  lot(g, x0, y0, w, h, 0xb8b0a2);
  box(g, x0 - 0.3, y0 - 0.35, x0 + 1.3, y0 + h - 0.6, 22, 0x9aa3ab);
  box(g, x0 - 0.32, y0 - 0.37, x0 + 1.32, y0 + h - 0.58, 2, 0xd88a3c, 22);
  // 建設資材のパレット（在庫が多いほど高い）
  const layers = Math.max(1, Math.round(fill * 4));
  for (let k = 0; k < layers; k++) {
    box(g, x0 + w - 1.3, y0 - 0.3, x0 + w - 0.7, y0 + 0.3, 3, k % 2 ? 0xd88a3c : 0xc07a30, k * 3.2);
  }
  // クレーン
  box(g, x0 + w - 0.6, y0 + h - 1.2, x0 + w - 0.5, y0 + h - 1.1, 40, 0xe2b13c);
  box(g, x0 + w - 1.6, y0 + h - 1.2, x0 + w - 0.5, y0 + h - 1.1, 2, 0xe2b13c, 40);
}

// 列車の描画

function trainPolyline(w: World, t: Train): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const a = t.path[0];
  const ax = tx(w, a),
    ay = ty(w, a);
  if (t.path.length > 1) {
    const b = t.path[1];
    pts.push({ x: ax + (tx(w, b) - ax) * t.progress, y: ay + (ty(w, b) - ay) * t.progress });
  }
  pts.push({ x: ax, y: ay });
  for (const p of t.trail) pts.push({ x: tx(w, p), y: ty(w, p) });
  return pts;
}

function pointAt(poly: { x: number; y: number }[], s: number): { x: number; y: number } {
  if (s <= 0 || poly.length === 1) return poly[0];
  let rem = s;
  for (let k = 0; k + 1 < poly.length; k++) {
    const a = poly[k],
      b = poly[k + 1];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d >= rem && d > 0) return { x: a.x + ((b.x - a.x) * rem) / d, y: a.y + ((b.y - a.y) * rem) / d };
    rem -= d;
  }
  // 足りなければ最後の方向に延ばす
  const a = poly[poly.length - 2] ?? poly[0],
    b = poly[poly.length - 1];
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: b.x + ((b.x - a.x) * rem) / d, y: b.y + ((b.y - a.y) * rem) / d };
}

const CAR_COLORS: Record<string, number> = {
  steam: 0x2f3b4a,
  express: 0x2f5f8f,
  heavy: 0x5a3a2a,
  superexpress: 0xe8eef2,
  coach: 0x3d7a5a,
  bigcoach: 0x2f6a4a,
  biggraincar: 0xa07a22,
  freshcar: 0xbfd3e0,
  bigorecar: 0x5e2e20,
  bigcoalcar: 0x2e2e32,
  bigsteelcar: 0x48525e,
  bigmaterialcar: 0x985220,
  livestockcar: 0x9a6a3a,
  fishcar: 0x9cc6dc,
  logcar: 0x7a4f2c,
  lumbercar: 0x9a7a52,
  biglogcar: 0x6a4020,
  biglumbercar: 0x8a6a42,
  graincar: 0xb08a2e,
  foodcar: 0xd9dde2,
  orecar: 0x6e3a2a,
  coalcar: 0x3a3a3e,
  steelcar: 0x55606c,
  materialcar: 0xa8622a,
};

function drawCar(g: Graphics, x: number, y: number, dx: number, dy: number, car: Car, selected: boolean) {
  const engine = isEngine(car.type);
  const wspec = isEngine(car.type) ? null : WAGON_SPECS[car.type];
  const big = !!wspec?.big;
  const pax = wspec?.cargo === 'passengers';
  const len = car.type === 'superexpress' ? 0.48 : engine ? 0.44 : big ? 0.46 : 0.42;
  const wid = 0.22;
  const h = car.type === 'superexpress' ? 8 : engine ? 9 : pax ? (big ? 10 : 9) : big ? 6 : 5;
  const px = -dy,
    py = dx;
  const corners: [number, number][] = [
    [x + (dx * len) / 2 + (px * wid) / 2, y + (dy * len) / 2 + (py * wid) / 2],
    [x + (dx * len) / 2 - (px * wid) / 2, y + (dy * len) / 2 - (py * wid) / 2],
    [x - (dx * len) / 2 - (px * wid) / 2, y - (dy * len) / 2 - (py * wid) / 2],
    [x - (dx * len) / 2 + (px * wid) / 2, y - (dy * len) / 2 + (py * wid) / 2],
  ];
  const color = CAR_COLORS[car.type];
  const base = 2;
  // 影
  g.poly(groundPoly(corners)).fill({ color: 0x000000, alpha: 0.18 });
  // 手前を向いた側面
  for (let k = 0; k < 4; k++) {
    const a = corners[k],
      b = corners[(k + 1) % 4];
    const mx = (a[0] + b[0]) / 2 - x,
      my = (a[1] + b[1]) / 2 - y;
    if (mx + my <= 0) continue;
    g.poly([...groundPoly([a], base), ...groundPoly([b], base), ...groundPoly([b], base + h), ...groundPoly([a], base + h)]).fill(
      shade(color, mx > my ? 0.68 : 0.84),
    );
  }
  g.poly(groundPoly(corners, base + h)).fill(color);
  if (selected) g.poly(groundPoly(corners, base + h)).stroke({ width: 2, color: 0xffe066 });

  if (engine) {
    // 煙突とライン
    const fx = x + dx * 0.14,
      fy = y + dy * 0.14;
    if (car.type === 'steam') g.ellipse(isoX(fx, fy), isoY(fx, fy) - base - h - 3, 2.2, 3.2).fill(0x1b2129);
    const s0 = groundPoly([[x - dx * 0.2, y - dy * 0.2]], base + h - 3),
      s1 = groundPoly([[x + dx * 0.2, y + dy * 0.2]], base + h - 3);
    const stripe: Record<string, number> = { steam: 0xc0443a, express: 0xf2c14e, heavy: 0xe8a317, superexpress: 0x2f5f8f };
    g.moveTo(s0[0], s0[1]).lineTo(s1[0], s1[1]).stroke({ width: car.type === 'superexpress' ? 2.5 : 1.5, color: stripe[car.type] ?? 0xc0443a });
  } else if (pax) {
    g.poly(groundPoly(corners.map(([cx, cy]) => [x + (cx - x) * 0.8, y + (cy - y) * 0.6] as [number, number]), base + h)).fill(
      shade(color, 1.2),
    );
  } else if (!isEngine(car.type)) {
    const spec = WAGON_SPECS[car.type];
    const fill = carLoad(car) / spec.capacity;
    if (fill > 0.02) {
      const ch = 2 + fill * 5;
      const inner = corners.map(([cx, cy]) => [x + (cx - x) * 0.85, y + (cy - y) * 0.75] as [number, number]);
      const top = CARGO_SPECS[spec.cargo].color;
      g.poly(groundPoly(inner, base + h + ch)).fill(spec.cargo === 'logs' ? C.logEnd : spec.cargo === 'lumber' ? C.plank : top);
      g.poly(groundPoly(inner, base + h + ch)).stroke({ width: 1, color: shade(top, 0.7), alpha: 0.8 });
    }
  }
}

export { TW, TH };
