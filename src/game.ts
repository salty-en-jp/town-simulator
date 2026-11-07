// ゲーム全体のまとめ役：ツール・プレビュー・キー操作・画面・時間の進行

import { attachInput, type InputTarget, type Mods } from './input/input';
import { Renderer, type Preview } from './render/renderer';
import {
  applyUndo,
  buildDepot,
  buildStation,
  buildTrack,
  cloneTrain,
  demolish,
  formatYen,
  trackPath,
  type CmdResult,
  type UndoRecord,
} from './sim/commands';
import { STATION, TICKS_PER_DAY, type WagonType } from './sim/constants';
import { generateWorld } from './sim/mapgen';
import { step } from './sim/simulate';
import { rectTiles, straightLine } from './sim/track';
import { dateOf, tx, ty, type Rect, type World } from './sim/world';
import { ICONS } from './ui/icons';
import {
  addOrderFromMap,
  esc,
  openDepot,
  openFinance,
  openHelp,
  openIndustry,
  openIndustryList,
  openMenu,
  openStation,
  openStationList,
  openTown,
  openTownList,
  openTrain,
  openTrainList,
} from './ui/panels';
import { WindowManager } from './ui/windows';

export type Tool = 'none' | 'track' | 'station' | 'depot' | 'demolish' | 'order' | 'clone';
type BuildTool = 'track' | 'station' | 'depot' | 'demolish';
const BUILD_TOOLS: Tool[] = ['track', 'station', 'depot', 'demolish'];

const MS_PER_DAY = 2000; // 速度×1で 1日 = 2秒
const SPEEDS = [1, 2, 4];

const TOOL_NAMES: Record<BuildTool, string> = {
  track: '線路',
  station: '駅',
  depot: '車庫',
  demolish: '解体',
};

interface Pending {
  kind: BuildTool;
  a: number;
  b: number;
}

export class Game implements InputTarget {
  world!: World;
  wm: WindowManager;
  tool: Tool = 'none';
  removeMode = false;
  orderTrain = -1;
  cloneDepot = -1;
  cloneShare = true;
  orderSel = new Map<number, number>();
  buildComp = new Map<number, WagonType[]>();
  selectedTrain = -1;
  selectedStation = -1;
  touchUI = false;
  uiPref: 'auto' | 'pc' | 'touch' = 'auto';
  paused = false;
  speedIdx = 0;
  railToolbarOpen = false;

  private acc = 0;
  private lastFrame = 0;
  private drag: Pending | null = null;
  /** スマホ：確定待ちのプレビュー */
  private pending: Pending | null = null;
  private pendingBeforeDrag: Pending | null = null;
  private undoStack: UndoRecord[] = [];
  private lastUi = 0;
  private toastTimer = 0;
  private newsTimer = 0;
  private lastNewsTile = -1;
  private mouse = { x: -1, y: -1 };
  private started = false;

  private el = {
    toolbar: document.getElementById('toolbar')!,
    railbar: document.getElementById('railbar')!,
    status: document.getElementById('statusbar')!,
    mtop: document.getElementById('mobile-top')!,
    mtools: document.getElementById('mobile-tools')!,
    confirm: document.getElementById('confirm')!,
    toast: document.getElementById('toast')!,
    tip: document.getElementById('cursor-tip')!,
    guide: document.getElementById('guide')!,
  };

  constructor(public renderer: Renderer) {
    this.wm = new WindowManager(document.getElementById('windows')!);
    attachInput(renderer.canvas, this);
    this.buildHud();
    this.bindKeys();
    const mq = window.matchMedia('(pointer: coarse)');
    mq.addEventListener('change', () => this.applyUiMode());
    window.addEventListener('resize', () => this.applyUiMode());
    try {
      const p = localStorage.getItem('tsunagu.ui');
      if (p === 'pc' || p === 'touch' || p === 'auto') this.uiPref = p;
    } catch {
      /* 保存できない環境でも動く */
    }
    this.applyUiMode();
    document.addEventListener('visibilitychange', () => {
      // 裏に回ったら自動で一時停止（電池の節約）
      if (document.hidden && this.started && !this.paused) this.togglePause();
    });
    window.addEventListener('beforeunload', (e) => {
      if (this.started) e.preventDefault();
    });
  }

  newGame(seed: number) {
    this.world = generateWorld(seed);
    this.renderer.setWorld(this.world);
    this.undoStack = [];
    const ind = [...this.world.industries.values()];
    const cx = ind.reduce((s, i) => s + i.x + 1, 0) / ind.length;
    const cy = ind.reduce((s, i) => s + i.y + 1, 0) / ind.length;
    this.renderer.centerOnTile(cx, cy, this.touchUI ? 0.7 : 1);
    this.started = true;
    this.updateHud();
    this.updateGuide();
    requestAnimationFrame((t) => this.loop(t));
  }

  // ───────────────────────── 画面モード ─────────────────────────

  setUiPref(p: 'auto' | 'pc' | 'touch') {
    this.uiPref = p;
    try {
      localStorage.setItem('tsunagu.ui', p);
    } catch {
      /* 無視 */
    }
    this.applyUiMode();
  }

  private applyUiMode() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const fine = window.matchMedia('(pointer: fine)').matches;
    const touch = this.uiPref === 'touch' || (this.uiPref === 'auto' && coarse && !fine);
    this.touchUI = touch;
    document.body.classList.toggle('touch', touch);
    document.body.classList.toggle('pc', !touch);
    this.wm.setTouchMode(touch);
    this.clearPending();
    this.updateHud();
  }

  // ───────────────────────── ツール ─────────────────────────

  setTool(tool: Tool) {
    if (this.tool === tool && BUILD_TOOLS.includes(tool)) tool = 'none';
    this.tool = tool;
    if (tool !== 'order') this.orderTrain = -1;
    if (tool !== 'clone') this.cloneDepot = -1;
    this.drag = null;
    this.clearPending();
    this.wm.setCollapsed(this.touchUI && (tool === 'order' || tool === 'clone'));
    this.renderer.setOverlay({ preview: null });
    this.el.tip.hidden = true;
    this.updateHud();
    this.wm.refreshAll();
  }

  toggleRemove() {
    this.removeMode = !this.removeMode;
    if (this.removeMode && this.tool !== 'track') this.setTool('track');
    this.refreshPreview();
    this.updateHud();
  }

  startOrderPick(trainId: number) {
    if (this.tool === 'order' && this.orderTrain === trainId) {
      this.setTool('none');
      return;
    }
    this.setTool('order');
    this.orderTrain = trainId;
    this.wm.refreshAll();
    this.updateHud();
  }

  startClone(depotId: number) {
    this.setTool('clone');
    this.cloneDepot = depotId;
    this.wm.refreshAll();
    this.updateHud();
  }

  selectTrain(id: number) {
    this.selectedTrain = id;
    this.renderer.setOverlay({ selectedTrain: id });
  }

  selectStation(id: number) {
    this.selectedStation = id;
    this.renderer.setOverlay({ selectedStation: id });
  }

  centerOnTrain(id: number) {
    const t = this.world.trains.get(id);
    if (!t) return;
    const tile = t.state === 'in_depot' ? this.world.depots.get(t.depotId)?.tile ?? t.path[0] : t.path[0];
    this.renderer.centerOnTile(tx(this.world, tile), ty(this.world, tile));
  }

  // ───────────────────────── コマンドの結果 ─────────────────────────

  result(r: CmdResult, tile = -1): boolean {
    if (!r.ok) {
      if (r.error) this.toast(r.error, 'bad');
      return false;
    }
    if (r.undo) {
      this.undoStack.push(r.undo);
      if (this.undoStack.length > 50) this.undoStack.shift();
    }
    if (tile >= 0 && r.cost > 0) this.renderer.floatText(tile, `-${formatYen(r.cost)}`, 'cost');
    this.updateHud();
    this.updateGuide();
    return true;
  }

  undo() {
    const rec = this.undoStack.pop();
    if (!rec) {
      this.toast('元に戻せる操作がありません', 'info');
      return;
    }
    const r = applyUndo(this.world, rec);
    if (r.ok) this.toast(`元に戻しました：${rec.label}（${formatYen(rec.cost)} 返金）`, 'info');
    else this.toast(r.error ?? '元に戻せません', 'bad');
    this.updateHud();
    this.wm.refreshAll();
  }

  toast(text: string, tone: 'good' | 'bad' | 'info' = 'info') {
    const t = this.el.toast;
    t.textContent = text;
    t.className = `show ${tone}`;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => (t.className = ''), tone === 'bad' ? 3200 : 2600);
  }

  // ───────────────────────── プレビュー ─────────────────────────

  private dry(p: Pending, remove: boolean): CmdResult {
    const w = this.world;
    switch (p.kind) {
      case 'track':
        return buildTrack(w, p.a, p.b, { remove, dry: true });
      case 'station':
        return buildStation(w, p.a, p.b, { dry: true });
      case 'depot':
        return buildDepot(w, p.b, { dry: true });
      case 'demolish':
        return demolish(w, p.a, p.b, { dry: true });
    }
  }

  private commit(p: Pending, remove: boolean): boolean {
    const w = this.world;
    let r: CmdResult;
    switch (p.kind) {
      case 'track':
        r = buildTrack(w, p.a, p.b, { remove });
        break;
      case 'station':
        r = buildStation(w, p.a, p.b);
        break;
      case 'depot':
        r = buildDepot(w, p.b);
        break;
      case 'demolish':
        r = demolish(w, p.a, p.b);
        break;
    }
    const ok = this.result(r, p.b);
    if (ok && p.kind === 'depot' && r.id && !this.touchUI) {
      this.toast('車庫を建てました。クリックすると列車を買えます', 'good');
    }
    return ok;
  }

  private previewTiles(p: Pending): { tiles: number[]; path?: number[]; catchment?: Rect | null } {
    const w = this.world;
    switch (p.kind) {
      case 'track': {
        const path = trackPath(w, p.a, p.b, this.removeMode);
        return { tiles: path, path };
      }
      case 'station': {
        const tiles = straightLine(w, p.a, p.b, STATION.maxLength);
        return { tiles, catchment: catchmentOf(w, tiles) };
      }
      case 'depot':
        return { tiles: [p.b] };
      case 'demolish':
        return { tiles: rectTiles(w, p.a, p.b) };
    }
  }

  private showPreview(p: Pending | null, remove: boolean, mods?: Mods) {
    if (!p) {
      this.renderer.setOverlay({ preview: null });
      this.el.tip.hidden = true;
      this.renderConfirm(null, null);
      return;
    }
    const r = this.dry(p, remove);
    const t = this.previewTiles(p);
    const preview: Preview = { ...t, ok: r.ok, remove: remove && p.kind === 'track', kind: p.kind };
    this.renderer.setOverlay({ preview });
    const label = r.ok ? `${formatYen(r.cost)}` : (r.error ?? '');
    if (this.touchUI) {
      this.renderConfirm(p, r);
    } else {
      const tip = this.el.tip;
      tip.hidden = false;
      tip.className = r.ok ? '' : 'bad';
      tip.innerHTML = r.ok ? `${esc(label)}${mods?.shift ? '<small>（見積もり）</small>' : ''}` : esc(label);
      tip.style.transform = `translate(${this.mouse.x + 16}px, ${this.mouse.y + 18}px)`;
    }
  }

  private refreshPreview() {
    if (this.pending) this.showPreview(this.pending, this.removeMode);
  }

  private clearPending() {
    this.pending = null;
    this.renderConfirm(null, null);
    if (this.renderer.world) this.renderer.setOverlay({ preview: null });
  }

  private renderConfirm(p: Pending | null, r: CmdResult | null) {
    const c = this.el.confirm;
    if (!p || !r) {
      c.hidden = true;
      return;
    }
    c.hidden = false;
    const name = p.kind === 'track' && this.removeMode ? '線路の撤去' : TOOL_NAMES[p.kind];
    c.innerHTML = `
      <div class="confirm-text ${r.ok ? '' : 'bad'}">
        <b>${name}</b>
        <span>${r.ok ? formatYen(r.cost) : esc(r.error ?? '')}</span>
        ${p.kind === 'track' && p.a === p.b ? '<small>もう一度タップで終点</small>' : ''}
      </div>
      <button class="round cancel" data-c="cancel" aria-label="取り消し">${ICONS.close}</button>
      <button class="round ok" data-c="ok" aria-label="確定" ${r.ok ? '' : 'disabled'}>${ICONS.check}</button>`;
  }

  // ───────────────────────── 入力（InputTarget） ─────────────────────────

  toolActive(): boolean {
    return BUILD_TOOLS.includes(this.tool);
  }

  pan(dx: number, dy: number) {
    this.renderer.panBy(dx, dy);
  }

  zoomAt(sx: number, sy: number, f: number) {
    this.renderer.zoomAt(sx, sy, f);
  }

  zoomStep(sx: number, sy: number, dir: 1 | -1) {
    this.renderer.zoomStep(sx, sy, dir);
  }

  hover(sx: number, sy: number, mods: Mods) {
    this.mouse = { x: sx, y: sy };
    if (!this.world) return;
    const t = sx < 0 ? -1 : this.renderer.screenToTile(sx, sy);
    this.renderer.setOverlay({ hover: t });
    if (this.touchUI) return;
    if (t >= 0 && (this.tool === 'station' || this.tool === 'depot')) {
      this.showPreview({ kind: this.tool, a: t, b: t }, false, mods);
    } else if (!this.drag) {
      this.renderer.setOverlay({ preview: null });
      this.el.tip.hidden = true;
    }
  }

  dragStart(sx: number, sy: number, mods: Mods, touch: boolean) {
    this.mouse = { x: sx, y: sy };
    const t = this.renderer.screenToTile(sx, sy);
    if (t < 0 || !this.toolActive()) return;
    this.pendingBeforeDrag = this.pending;
    this.drag = { kind: this.tool as BuildTool, a: t, b: t };
    this.showPreview(this.drag, this.removeFor(mods, touch), mods);
  }

  dragMove(sx: number, sy: number, mods: Mods, touch: boolean) {
    this.mouse = { x: sx, y: sy };
    if (!this.drag) return;
    const t = this.renderer.screenToTile(sx, sy);
    if (t >= 0) this.drag.b = t;
    this.showPreview(this.drag, this.removeFor(mods, touch), mods);
  }

  dragEnd(sx: number, sy: number, mods: Mods, touch: boolean) {
    if (!this.drag) return;
    const t = this.renderer.screenToTile(sx, sy);
    if (t >= 0) this.drag.b = t;
    const p = this.drag;
    this.drag = null;
    if (touch) {
      // スマホ：すぐには建てず、✓ で確定
      this.pending = p;
      this.showPreview(p, this.removeMode);
      return;
    }
    if (mods.shift) {
      const r = this.dry(p, this.removeFor(mods, false));
      this.toast(r.ok ? `見積もり：${formatYen(r.cost)}` : (r.error ?? ''), r.ok ? 'info' : 'bad');
    } else {
      this.commit(p, this.removeFor(mods, false));
    }
    this.renderer.setOverlay({ preview: null });
    this.el.tip.hidden = true;
  }

  dragCancel() {
    this.drag = null;
    this.pending = this.pendingBeforeDrag;
    if (this.pending) this.showPreview(this.pending, this.removeMode);
    else this.showPreview(null, false);
  }

  tap(sx: number, sy: number, mods: Mods, touch: boolean) {
    if (!this.world) return;
    const t = this.renderer.screenToTile(sx, sy);
    if (touch && this.toolActive()) {
      if (t < 0) return;
      const kind = this.tool as BuildTool;
      // 線路：1回目のタップで始点、2回目で終点
      if (kind === 'track' && this.pending && this.pending.a === this.pending.b && this.pending.kind === 'track') {
        this.pending = { kind, a: this.pending.a, b: t };
      } else {
        this.pending = { kind, a: t, b: t };
      }
      this.showPreview(this.pending, this.removeMode);
      return;
    }
    if (this.tool === 'order') {
      const o = t >= 0 ? this.world.occ[t] : null;
      if (o?.k === 'station') addOrderFromMap(this, this.orderTrain, o.id, mods.ctrl);
      else this.toast(touch ? '駅をタップしてください' : '駅をクリックしてください', 'info');
      return;
    }
    if (this.tool === 'clone') {
      const tr = this.renderer.trainAt(sx, sy);
      if (tr >= 0) {
        const r = cloneTrain(this.world, tr, this.cloneDepot, mods.ctrl || this.cloneShare);
        if (this.result(r)) {
          this.toast(`複製しました${mods.ctrl || this.cloneShare ? '（指令を共有）' : ''}`, 'good');
          this.setTool('none');
          if (r.id) openTrain(this, r.id);
        }
      } else this.toast('複製する列車を選んでください', 'info');
      return;
    }
    this.inspect(sx, sy);
  }

  longPress(sx: number, sy: number) {
    navigator.vibrate?.(10);
    this.inspect(sx, sy);
  }

  private inspect(sx: number, sy: number) {
    const tr = this.renderer.trainAt(sx, sy);
    if (tr >= 0) {
      openTrain(this, tr);
      return;
    }
    const t = this.renderer.screenToTile(sx, sy);
    if (t < 0) return;
    const o = this.world.occ[t];
    if (!o) return;
    if (o.k === 'station') openStation(this, o.id);
    else if (o.k === 'depot') openDepot(this, o.id);
    else if (o.k === 'industry') openIndustry(this, o.id);
    else if (o.k === 'house') openTown(this, o.town);
  }

  private removeFor(mods: Mods, touch: boolean): boolean {
    return touch ? this.removeMode : mods.ctrl !== this.removeMode;
  }

  // ───────────────────────── キーボード（OpenTTD と同じ割り当て） ─────────────────────────

  private bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (!this.started) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const k = e.key;
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      if (k === 'F1' && e.shiftKey) openTrainList(this);
      else if (k === 'F1' || k === 'Pause') this.togglePause();
      else if (!e.shiftKey && ['F2', 'F3', 'F6', 'F9', 'F10', 'F11'].includes(k)) this.notYet(k);
      else if (k === 'F4' && !e.shiftKey) this.notYet('全体マップ');
      else if (k === 'F5' && !e.shiftKey) openTownList(this);
      else if (k === 'F7' && e.shiftKey) this.toggleRailToolbar();
      else if (k === 'F7') openStationList(this);
      else if (k === 'F8' && !e.shiftKey) openFinance(this);
      else if (k === 'F12' && !e.shiftKey) openIndustryList(this);
      else if (k === 'Escape') {
        if (this.tool !== 'none') this.setTool('none');
        else this.clearPending();
      } else if (k === 'Delete' && e.shiftKey) this.wm.closeAll();
      else if (k === 'Delete') this.wm.closeTop();
      else if (ctrl && (k === 'z' || k === 'Z')) this.undo();
      else if (ctrl) handled = false;
      else if (k === '+' || k === '=' || (e.shiftKey && k === 'F5')) this.renderer.zoomStep(innerWidth / 2, innerHeight / 2, 1);
      else if (k === '-' || (e.shiftKey && k === 'F6')) this.renderer.zoomStep(innerWidth / 2, innerHeight / 2, -1);
      else if (k === 'a' || k === 'A') this.setToolKey('track');
      else if (k === 'd' || k === 'D') this.setToolKey('demolish');
      else if (this.railToolbarOpen && ['1', '2', '3', '4', '5'].includes(k)) this.setToolKey('track');
      else if (this.railToolbarOpen && k === '6') this.setToolKey('demolish');
      else if (this.railToolbarOpen && k === '7') this.setToolKey('depot');
      else if (this.railToolbarOpen && k === '9') this.setToolKey('station');
      else if (this.railToolbarOpen && (k === 'r' || k === 'R')) this.toggleRemove();
      else if (this.railToolbarOpen && ['s', 'S', 'b', 'B', 't', 'T', '8', 'c', 'C'].includes(k)) this.notYet(k.toUpperCase());
      else if (['q', 'Q', 'w', 'W', 'e', 'E'].includes(k)) this.notYet('地形の変更');
      else handled = false;
      if (handled) e.preventDefault();
    });
  }

  private setToolKey(tool: BuildTool) {
    if (!this.railToolbarOpen && !this.touchUI) this.toggleRailToolbar(true);
    if (this.tool !== tool) this.setTool(tool);
  }

  private notYet(what: string) {
    this.toast(`「${what}」は試作版ではまだ使えません`, 'info');
  }

  togglePause() {
    this.paused = !this.paused;
    this.updateHud();
  }

  cycleSpeed() {
    if (this.paused) this.paused = false;
    else this.speedIdx = (this.speedIdx + 1) % SPEEDS.length;
    this.updateHud();
  }

  toggleRailToolbar(force?: boolean) {
    this.railToolbarOpen = force ?? !this.railToolbarOpen;
    if (!this.railToolbarOpen && BUILD_TOOLS.includes(this.tool)) this.setTool('none');
    this.updateHud();
  }

  // ───────────────────────── 画面（ツールバー・ステータスバー） ─────────────────────────

  private buildHud() {
    const tb = this.el.toolbar;
    tb.innerHTML = `
      <div class="tb-group">
        <button data-a="pause" title="一時停止 (F1)">${ICONS.pause}</button>
        <button data-a="speed" title="早送り">${ICONS.fast}<span class="speed"></span></button>
      </div>
      <div class="tb-group">
        <button data-a="finance" title="財務 (F8)">${ICONS.money}</button>
        <button data-a="towns" title="町一覧 (F5)">${ICONS.depot}</button>
        <button data-a="stations" title="駅一覧 (F7)">${ICONS.station}</button>
        <button data-a="industries" title="産業一覧 (F12)">${ICONS.industry}</button>
        <button data-a="trains" title="列車一覧 (Shift+F1)">${ICONS.train}</button>
      </div>
      <div class="tb-group">
        <button data-a="rail" title="鉄道建設 (Shift+F7)">${ICONS.rail}</button>
        <button data-a="demolish" title="解体 (D)">${ICONS.demolish}</button>
        <button data-a="undo" title="元に戻す (Ctrl+Z)">${ICONS.undo}</button>
      </div>
      <div class="tb-group">
        <button data-a="help" title="操作方法">${ICONS.help}</button>
      </div>`;
    const rb = this.el.railbar;
    rb.innerHTML = `
      <span class="rb-title">鉄道建設</span>
      <button data-a="t-track" title="線路（オートレール）A ・ Ctrl+ドラッグで撤去 ・ Shiftで見積もり">${ICONS.rail}<kbd>A</kbd></button>
      <button data-a="t-demolish" title="解体 6">${ICONS.demolish}<kbd>6</kbd></button>
      <button data-a="t-depot" title="車庫 7">${ICONS.depot}<kbd>7</kbd></button>
      <button data-a="t-station" title="駅 9 ・ ドラッグで長さを指定">${ICONS.station}<kbd>9</kbd></button>
      <button data-a="na" title="信号 S（試作版では未実装）" disabled><span class="na">信号</span><kbd>S</kbd></button>
      <button data-a="na" title="橋 B（試作版では川の上に線路を引くと自動で橋になります）" disabled><span class="na">橋</span><kbd>B</kbd></button>
      <button data-a="na" title="トンネル T（試作版では未実装）" disabled><span class="na">トンネル</span><kbd>T</kbd></button>
      <button data-a="t-remove" title="建設／撤去の切り替え R">${ICONS.remove}<kbd>R</kbd></button>
      <button data-a="t-close" class="rb-close" title="閉じる">${ICONS.close}</button>`;
    this.el.status.innerHTML = `
      <span class="sb-date"></span>
      <button class="sb-news" title="クリックでその場所へ"></button>
      <span class="sb-money"></span>`;
    this.el.mtop.innerHTML = `
      <span class="m-money"></span>
      <span class="m-date"></span>
      <button data-a="pause" class="m-btn" aria-label="一時停止">${ICONS.pause}</button>
      <button data-a="speed" class="m-btn" aria-label="速度">${ICONS.fast}<span class="speed"></span></button>
      <button data-a="menu" class="m-btn" aria-label="メニュー">${ICONS.menu}</button>`;
    this.el.mtools.innerHTML = `
      <button data-a="t-track" aria-label="線路">${ICONS.rail}<span>線路</span></button>
      <button data-a="t-station" aria-label="駅">${ICONS.station}<span>駅</span></button>
      <button data-a="t-depot" aria-label="車庫">${ICONS.depot}<span>車庫</span></button>
      <button data-a="t-demolish" aria-label="解体">${ICONS.demolish}<span>解体</span></button>
      <button data-a="t-remove" class="remove" aria-label="撤去">${ICONS.remove}<span>撤去</span></button>
      <button data-a="undo" aria-label="元に戻す">${ICONS.undo}<span>戻す</span></button>`;

    const onClick = (e: Event) => {
      const b = (e.target as HTMLElement).closest('[data-a]') as HTMLElement | null;
      if (!b) return;
      this.hudAction(b.dataset.a!);
    };
    for (const el of [tb, rb, this.el.mtop, this.el.mtools]) el.addEventListener('click', onClick);
    this.el.status.querySelector('.sb-news')!.addEventListener('click', () => {
      if (this.lastNewsTile >= 0) this.renderer.centerOnTile(tx(this.world, this.lastNewsTile), ty(this.world, this.lastNewsTile));
    });
    this.el.confirm.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-c]') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      if (b.dataset.c === 'ok' && this.pending) {
        const p = this.pending;
        if (this.commit(p, this.removeMode)) this.clearPending();
        else this.showPreview(p, this.removeMode);
      } else if (b.dataset.c === 'cancel') this.clearPending();
    });
    this.el.guide.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('[data-g="close"]')) {
        this.el.guide.hidden = true;
        this.guideClosed = true;
      } else if ((e.target as HTMLElement).closest('[data-g="toggle"]')) {
        this.el.guide.classList.toggle('min');
      }
    });
  }

  private guideClosed = false;

  private hudAction(a: string) {
    switch (a) {
      case 'pause':
        this.togglePause();
        break;
      case 'speed':
        this.cycleSpeed();
        break;
      case 'finance':
        openFinance(this);
        break;
      case 'towns':
        openTownList(this);
        break;
      case 'stations':
        openStationList(this);
        break;
      case 'industries':
        openIndustryList(this);
        break;
      case 'trains':
        openTrainList(this);
        break;
      case 'rail':
        this.toggleRailToolbar();
        break;
      case 'demolish':
        this.setToolKey('demolish');
        break;
      case 'undo':
        this.undo();
        break;
      case 'help':
        openHelp(this);
        break;
      case 'menu':
        openMenu(this);
        break;
      case 't-track':
        if (this.removeMode && this.tool === 'track') this.removeMode = false;
        this.setTool('track');
        break;
      case 't-station':
        this.setTool('station');
        break;
      case 't-depot':
        this.setTool('depot');
        break;
      case 't-demolish':
        this.setTool('demolish');
        break;
      case 't-remove':
        this.toggleRemove();
        break;
      case 't-close':
        this.toggleRailToolbar(false);
        break;
    }
  }

  updateHud() {
    const w = this.world;
    const on = (sel: string, v: boolean) => document.querySelectorAll(sel).forEach((b) => b.classList.toggle('on', v));
    on('[data-a="pause"]', this.paused);
    document.querySelectorAll('.speed').forEach((s) => (s.textContent = `×${SPEEDS[this.speedIdx]}`));
    on('[data-a="rail"]', this.railToolbarOpen);
    on('[data-a="t-track"]', this.tool === 'track' && !this.removeMode);
    on('[data-a="t-station"]', this.tool === 'station');
    on('[data-a="t-depot"]', this.tool === 'depot');
    on('[data-a="t-demolish"], [data-a="demolish"]', this.tool === 'demolish');
    on('[data-a="t-remove"]', this.removeMode);
    this.el.railbar.hidden = !this.railToolbarOpen || this.touchUI;
    document.body.classList.toggle('picking', this.tool === 'order' || this.tool === 'clone');
    if (!w) return;
    const d = dateOf(w.day);
    const date = `${d.y}年${d.m}月${d.d}日`;
    const money = formatYen(w.money);
    (this.el.status.querySelector('.sb-date') as HTMLElement).textContent = date;
    const sm = this.el.status.querySelector('.sb-money') as HTMLElement;
    sm.textContent = money;
    sm.classList.toggle('neg', w.money < 0);
    (this.el.mtop.querySelector('.m-date') as HTMLElement).textContent = `${d.y}/${d.m}/${d.d}`;
    const mm = this.el.mtop.querySelector('.m-money') as HTMLElement;
    mm.textContent = money;
    mm.classList.toggle('neg', w.money < 0);
    document.body.classList.toggle('paused', this.paused);
  }

  // ───────────────────────── はじめのガイド ─────────────────────────

  private updateGuide() {
    if (this.guideClosed || !this.world) return;
    const w = this.world;
    const forest = [...w.industries.values()].find((i) => i.type === 'forest');
    const saw = [...w.industries.values()].find((i) => i.type === 'sawmill');
    const trains = [...w.trains.values()];
    const steps = [
      { done: w.stations.size >= 2, text: `${esc(forest?.name ?? '森')}と${esc(saw?.name ?? '製材所')}の近くに<b>駅</b>を建てる` },
      { done: w.depots.size >= 1 && hasAnyTrack(w), text: '駅を<b>線路</b>でつなぎ、線路の隣に<b>車庫</b>を置く' },
      { done: trains.some((t) => t.state !== 'in_depot'), text: '車庫で列車を買い、<b>指令</b>で行き先を選んで<b>発車</b>' },
      { done: w.finance.thisYear.income + w.finance.lastYear.income > 0, text: '原木を製材所に届けて<b>お金を稼ぐ</b>' },
      { done: [...w.towns.values()].some((t) => t.lumberReceivedThisMonth + t.lumberReceivedLastMonth > 0), text: '<b>木材</b>を町に届けて<b>家を建てる</b>' },
    ];
    const next = steps.findIndex((s) => !s.done);
    if (this.el.guide.hidden && this.touchUI) this.el.guide.classList.add('min'); // スマホでは最初はたたんでおく
    this.el.guide.hidden = false;
    this.el.guide.innerHTML = `
      <header><button data-g="toggle" class="g-title">はじめの目標 <small>${steps.filter((s) => s.done).length}/${steps.length}</small></button><button data-g="close" aria-label="閉じる">${ICONS.close}</button></header>
      <ol>${steps.map((s, i) => `<li class="${s.done ? 'done' : i === next ? 'next' : ''}">${s.text}</li>`).join('')}</ol>
      ${next === -1 ? '<p class="g-done">達成！ あとは自由に路線を広げましょう</p>' : ''}`;
  }

  // ───────────────────────── ループ ─────────────────────────

  private loop(now: number) {
    const dtMs = this.lastFrame ? Math.min(250, now - this.lastFrame) : 16;
    this.lastFrame = now;
    if (!this.paused) {
      this.acc += dtMs * SPEEDS[this.speedIdx];
      const msPerTick = MS_PER_DAY / TICKS_PER_DAY;
      const ticks = Math.min(240, Math.floor(this.acc / msPerTick));
      if (ticks > 0) {
        this.acc -= ticks * msPerTick;
        step(this.world, ticks);
      }
    }
    this.drainEvents();
    this.renderer.frame(now);
    if (now - this.lastUi > 250) {
      this.lastUi = now;
      this.updateHud();
      this.wm.refreshAll();
      this.updateGuide();
    }
    requestAnimationFrame((t) => this.loop(t));
  }

  private drainEvents() {
    const evs = this.world.events;
    if (!evs.length) return;
    this.world.events = [];
    for (const ev of evs) {
      if (ev.type === 'income') {
        this.renderer.floatText(ev.tile, `+${formatYen(ev.amount)}`, 'income');
      } else {
        this.news(ev.text, ev.tone ?? 'info', ev.tile ?? -1);
      }
    }
  }

  private news(text: string, tone: string, tile: number) {
    this.lastNewsTile = tile;
    const sn = this.el.status.querySelector('.sb-news') as HTMLElement;
    sn.textContent = text;
    sn.className = `sb-news show ${tone}`;
    window.clearTimeout(this.newsTimer);
    this.newsTimer = window.setTimeout(() => (sn.className = 'sb-news'), 8000);
    if (this.touchUI) this.toast(text, tone === 'bad' ? 'bad' : tone === 'good' ? 'good' : 'info');
  }
}

function catchmentOf(w: World, tiles: number[]): Rect | null {
  if (!tiles.length) return null;
  const xs = tiles.map((t) => tx(w, t)),
    ys = tiles.map((t) => ty(w, t));
  const r = STATION.catchment;
  return {
    x0: Math.max(0, Math.min(...xs) - r),
    y0: Math.max(0, Math.min(...ys) - r),
    x1: Math.min(w.w - 1, Math.max(...xs) + r),
    y1: Math.min(w.h - 1, Math.max(...ys) + r),
  };
}

function hasAnyTrack(w: World): boolean {
  for (let i = 0; i < w.track.length; i++) {
    const o = w.occ[i];
    if (w.track[i] && !o) return true;
  }
  return false;
}

