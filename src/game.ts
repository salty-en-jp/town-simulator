// ゲーム全体のまとめ役：ツール・プレビュー・キー操作・画面・時間の進行

import { attachInput, type InputTarget, type Mods } from './input/input';
import { Renderer, type Preview } from './render/renderer';
import {
  applyUndo,
  buildDepot,
  buildStation,
  buildTrack,
  cloneTrain,
  deleteOrder,
  demolish,
  replaceStationInOrders,
  stationTrains,
  formatYen,
  stationAxisFor,
  trackPath,
  type CmdResult,
  type UndoRecord,
} from './sim/commands';
import {
  CARGO_SPECS,
  CARGOS,
  INDUSTRY_ECON,
  INDUSTRY_SPECS,
  PRIMARY_TYPES,
  STATION,
  TICKS_PER_DAY,
  type Cargo,
  type IndustryType,
} from './sim/constants';
import { buildFactory, startSurvey } from './sim/industries';
import { generateWorld } from './sim/mapgen';
import { acceptanceForRect, step, suppliesForRect } from './sim/simulate';
import { findPath, rectTiles, straightLine } from './sim/track';
import { canLoadFrom, dateOf, tx, ty, type Axis, type Rect, type World } from './sim/world';
import { ICONS } from './ui/icons';
import {
  addOrderFromMap,
  esc,
  openDepot,
  openFinance,
  openHelp,
  openIndustry,
  openIndustryList,
  openBuildIndustry,
  openMarket,
  openMenu,
  openRequests,
  openStation,
  openStationList,
  openTown,
  openTownList,
  openTrain,
  openTrainList,
} from './ui/panels';
import { WindowManager } from './ui/windows';
import {
  deleteSave,
  exportSave,
  listSaves,
  loadFrom,
  metaLabel,
  pickSaveFile,
  saveTo,
  SLOTS,
  type SaveMeta,
  type Slot,
} from './storage';

export type Tool = 'none' | 'track' | 'station' | 'depot' | 'demolish' | 'industry' | 'order' | 'clone' | 'replace';
type BuildTool = 'track' | 'station' | 'depot' | 'demolish' | 'industry';
const BUILD_TOOLS: Tool[] = ['track', 'station', 'depot', 'demolish', 'industry'];

const MS_PER_DAY = 2000; // 速度×1で 1日 = 2秒
const SPEEDS = [1, 2, 4];

const TOOL_NAMES: Record<BuildTool, string> = {
  track: '線路',
  station: '駅',
  depot: '車庫',
  demolish: '解体',
  industry: '産業',
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
  /** 相場表で選んでいる貨物 */
  marketCargo: Cargo | null = null;
  /** 車庫ごとに選んでいる列車（編成の組み替え用） */
  depotSel = new Map<number, number>();
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
    pickbar: document.getElementById('pickbar')!,
    labels: document.getElementById('labels')!,
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
      if (!document.hidden || !this.started) return;
      // 裏に回ったら自動で一時停止（電池の節約）して、オートセーブ
      // （iPhone は裏のタブを勝手に閉じることがあるため）
      if (!this.paused) this.togglePause();
      this.autosave();
    });
    window.addEventListener('pagehide', () => this.autosave());
    window.addEventListener('beforeunload', () => this.autosave());
  }

  newGame(seed: number) {
    this.startWorld(generateWorld(seed));
  }

  /** 世界を差し替える（新しいゲーム・ロード） */
  startWorld(world: World) {
    this.world = world;
    this.renderer.setWorld(world);
    this.undoStack = [];
    this.depotSel.clear();
    this.orderSel.clear();
    this.wm.closeWhere(() => true);
    this.setTool('none');
    this.selectTrain(-1);
    this.selectStation(-1);
    this.lastAutoMonth = dateOf(world.day).m;
    const st = [...world.stations.values()][0];
    if (st) {
      const t = st.tiles[0];
      this.renderer.centerOnTile(tx(world, t), ty(world, t), this.touchUI ? 0.7 : 1);
    } else {
      // 最初の森と製材所のあいだ（はじめの目標の場所）
      const all = [...world.industries.values()];
      const first = [all.find((i) => i.type === 'forest'), all.find((i) => i.type === 'sawmill')].filter((i) => !!i);
      const ind = first.length ? first : all;
      const cx = ind.reduce((s, i) => s + i.x + 1, 0) / ind.length;
      const cy = ind.reduce((s, i) => s + i.y + 1, 0) / ind.length;
      this.renderer.centerOnTile(cx, cy, this.touchUI ? 0.7 : 1);
    }
    this.started = true;
    this.guideClosed = false;
    this.updateHud();
    this.updateGuide();
    if (!this.loopStarted) {
      this.loopStarted = true;
      requestAnimationFrame((t) => this.loop(t));
    }
  }

  // ───────────────────────── セーブ ─────────────────────────

  private loopStarted = false;
  private lastAutoMonth = -1;
  private saving = false;
  saveMetas: Partial<Record<Slot, SaveMeta>> = {};

  private autosaveAgain = false;

  autosave() {
    if (!this.started) return;
    if (this.saving) {
      // 保存中なら、終わったらもう一度（最新の状態を残す）
      this.autosaveAgain = true;
      return;
    }
    this.saving = true;
    saveTo('auto', this.world)
      .catch(() => this.toast('オートセーブに失敗しました', 'bad'))
      .finally(() => {
        this.saving = false;
        if (this.autosaveAgain) {
          this.autosaveAgain = false;
          this.autosave();
        }
      });
  }

  async refreshSaveMetas() {
    this.saveMetas = await listSaves();
    this.wm.refresh('saveload', true);
  }

  openSaveLoad() {
    void this.refreshSaveMetas();
    this.wm.open({
      id: 'saveload',
      title: 'セーブ／ロード',
      width: 400,
      render: () => {
        const rows = SLOTS.map((slot) => {
          const m = this.saveMetas[slot];
          const name = slot === 'auto' ? 'オートセーブ' : `スロット ${slot}`;
          const info = m
            ? `<span>${metaLabel(m)}・${formatYen(m.money)}</span><small class="muted">人口 ${m.population.toLocaleString('ja-JP')}人・列車 ${m.trains}本・保存 ${new Date(m.savedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</small>`
            : '<span class="muted">空き</span>';
          return `<li class="slot">
            <div class="thumb">${m?.thumb ? `<img src="${m.thumb}" alt="">` : ''}</div>
            <div class="slot-info"><b>${name}</b>${info}</div>
            <div class="slot-btns">
              ${slot !== 'auto' ? `<button class="small-btn" data-action="save" data-slot="${slot}">${ICONS.save}セーブ</button>` : ''}
              ${m ? `<button class="small-btn" data-action="load" data-slot="${slot}">ロード</button>` : ''}
              ${m && slot !== 'auto' ? `<button class="small-btn" data-action="delete" data-slot="${slot}" title="消す">${ICONS.close}</button>` : ''}
            </div></li>`;
        }).join('');
        return `
          <p class="muted small">オートセーブは毎月と、アプリを裏に回したとき・閉じたときに自動で保存されます。</p>
          <ul class="slots">${rows}</ul>
          <h4>ファイル</h4>
          <div class="btnrow">
            <button data-action="export">${this.touchUI ? '送る・保存する' : 'ファイルに書き出す'}</button>
            <button data-action="import">ファイルから読み込む</button>
          </div>
          <p class="muted small">PC と iPhone の行き来や、家族に街を見せるときに使えます。iPhone のデータは、ホーム画面に追加したアプリから遊ぶと消えにくくなります。</p>
          <div class="btnrow"><button class="danger" data-action="new">新しいゲームをはじめる</button></div>`;
      },
      onAction: (a, el) => void this.saveAction(a, el.dataset.slot as Slot | undefined),
    });
  }

  private async saveAction(a: string, slot?: Slot) {
    try {
      if (a === 'save' && slot) {
        if (this.saveMetas[slot] && !confirm(`スロット ${slot} に上書きしますか？`)) return;
        await saveTo(slot, this.world);
        this.toast(`スロット ${slot} にセーブしました`, 'good');
      } else if (a === 'load' && slot) {
        if (slot !== 'auto') await saveTo('auto', this.world); // 今の街はオートセーブに残しておく
        const w = await loadFrom(slot);
        if (w) {
          this.startWorld(w);
          this.toast(`${slot === 'auto' ? 'オートセーブ' : `スロット ${slot}`}を読み込みました`, 'good');
        }
      } else if (a === 'delete' && slot) {
        if (!confirm(`スロット ${slot} を消しますか？`)) return;
        await deleteSave(slot);
      } else if (a === 'export') {
        const r = await exportSave(this.world);
        if (r === 'downloaded') this.toast('セーブファイルを書き出しました', 'good');
      } else if (a === 'import') {
        const w = await pickSaveFile();
        if (w) {
          await saveTo('auto', this.world);
          this.startWorld(w);
          this.toast('セーブファイルを読み込みました', 'good');
        }
      } else if (a === 'new') {
        if (!confirm('新しいゲームをはじめますか？（今の街はオートセーブに残ります）')) return;
        await saveTo('auto', this.world);
        this.newGame(Math.floor(Math.random() * 1e9));
        this.toast('新しいゲームをはじめました', 'good');
      }
    } catch (e) {
      this.toast((e as Error).message || 'うまくいきませんでした', 'bad');
    }
    await this.refreshSaveMetas();
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
    // スマホでは地図を広く見せるためにウィンドウを隠す（下の選択バーの「完了」で戻る）
    this.wm.setCollapsed(this.touchUI && (tool === 'order' || tool === 'clone' || tool === 'replace'));
    this.renderer.setFaded(this.userFaded || tool === 'order' || tool === 'replace');
    this.renderer.setOverlay({ preview: null });
    this.el.tip.hidden = true;
    this.updateHud();
    this.updatePickbar();
    this.updateRoute(true);
    this.wm.refreshAll();
  }

  // ───────────────────────── 行き先を選ぶとき ─────────────────────────

  /** X キー：建物を半透明にする（OpenTTD と同じ） */
  private userFaded = false;
  /** 選択中に追加した指令の位置（「1つ戻す」用） */
  private pickAdded: { i: number; append: boolean }[] = [];
  private routeKey = '';

  toggleFade() {
    this.userFaded = !this.userFaded;
    this.renderer.setFaded(this.userFaded || this.tool === 'order');
    this.toast(this.userFaded ? '建物を半透明にしました（X で戻す）' : '建物の表示を戻しました', 'info');
  }

  // ───────── 駅の差し替え（駅ウィンドウの一覧から） ─────────

  replaceFrom = -1;
  /** 差し替える指令（省くと、その駅を使うすべての指令） */
  replaceLists: number[] | undefined;

  startReplace(from: number, lists?: number[]) {
    this.tool = 'none';
    this.replaceFrom = from;
    this.replaceLists = lists;
    this.setTool('replace');
  }

  private doReplace(to: number) {
    const from = this.world.stations.get(this.replaceFrom);
    const r = replaceStationInOrders(this.world, this.replaceFrom, to, this.replaceLists);
    if (this.result(r)) {
      this.toast(`${r.count}件の指令を、${from?.name ?? ''}から${this.world.stations.get(to)!.name}に差し替えました`, 'good');
      this.setTool('none');
    }
    this.wm.refreshAll();
  }

  /** 地図で駅を選んだ（地面・駅名の看板・近くのマス、どれからでも） */
  pickStation(stationId: number, full: boolean) {
    if (this.tool === 'replace' && this.world.stations.has(stationId)) {
      this.doReplace(stationId);
      return;
    }
    if (this.tool !== 'order' || !this.world.stations.has(stationId)) return;
    const t = this.world.trains.get(this.orderTrain);
    if (!t) return;
    const count = () => this.world.orderLists.get(t.orderList)!.orders.length;
    const before = count();
    const sel = this.orderSel.get(t.id) ?? -1;
    // 選んでいる指令の前に入る。選んでいなければ最後に足す
    const at = sel >= 0 ? sel : before;
    addOrderFromMap(this, t.id, stationId, full);
    if (count() > before) this.pickAdded.push({ i: at, append: sel < 0 });
    this.updatePickbar();
    this.updateRoute(true);
  }

  /** 押した位置の近くにある駅（ビルに隠れていても選べるように） */
  private stationNear(sx: number, sy: number): number {
    const t = this.renderer.screenToTile(sx, sy);
    const o = t >= 0 ? this.world.occ[t] : null;
    if (o?.k === 'station') return o.id;
    const p = this.renderer.screenToTileF(sx, sy);
    let best = -1,
      bd = 1.3;
    for (const st of this.world.stations.values()) {
      for (const tile of st.tiles) {
        const d = Math.max(Math.abs(tx(this.world, tile) - p.x), Math.abs(ty(this.world, tile) - p.y));
        if (d < bd) {
          bd = d;
          best = st.id;
        }
      }
    }
    return best;
  }

  private undoPick() {
    const last = this.pickAdded.pop();
    if (!last) return;
    this.result(deleteOrder(this.world, this.orderTrain, last.i));
    // 次に選んだ駅が、消した指令と同じ場所に入るように
    this.orderSel.set(this.orderTrain, last.append ? -1 : last.i);
    this.updatePickbar();
    this.updateRoute(true);
    this.wm.refreshAll();
  }

  /** 画面下の選択バー：指令の並び・1つ戻す・完了 */
  private updatePickbar() {
    const bar = this.el.pickbar;
    if (this.tool === 'replace') {
      bar.hidden = false;
      const from = this.world.stations.get(this.replaceFrom);
      const n = this.replaceLists ? this.replaceLists.length : stationTrains(this.world, this.replaceFrom).length;
      this.setPickbarHtml(`<div class="pick-text"><b>${esc(from?.name ?? '')}の代わり</b><span>新しい行き先の駅を${this.touchUI ? 'タップ' : 'クリック'}（${n}組の指令を差し替えます）</span></div>
        <button class="pick-btn" data-p="done">やめる</button>`);
      return;
    }
    if (this.tool === 'clone') {
      bar.hidden = false;
      this.setPickbarHtml(`<div class="pick-text"><b>クローン</b><span>複製する列車を${this.touchUI ? 'タップ' : 'クリック'}してください</span></div>
        <button class="pick-btn" data-p="done">やめる</button>`);
      return;
    }
    if (this.tool !== 'order') {
      bar.hidden = true;
      this.pickAdded = [];
      return;
    }
    const t = this.world.trains.get(this.orderTrain);
    if (!t) {
      bar.hidden = true;
      return;
    }
    const orders = this.world.orderLists.get(t.orderList)!.orders;
    const chips = orders
      .map((o, i) => {
        const name = this.world.stations.get(o.station)?.name ?? '?';
        const full = o.load === 'full_any' || o.load === 'full_all';
        return `<span class="pick-chip"><i>${i + 1}</i>${esc(name)}${full ? '<small>満載</small>' : ''}</span>`;
      })
      .join('<span class="pick-arrow">→</span>');
    bar.hidden = false;
    this.setPickbarHtml(`
      <div class="pick-text"><b>${esc(t.name)}の行き先</b>
        <span>${this.touchUI ? '駅（または駅名）をタップ' : '駅（または駅名）をクリック・Ctrl+クリックで満載待ち'}</span></div>
      <div class="pick-chips">${chips || '<span class="muted">まだありません</span>'}</div>
      <button class="pick-btn" data-p="undo" ${this.pickAdded.length ? '' : 'disabled'}>1つ戻す</button>
      <button class="pick-btn primary" data-p="done">完了</button>`);
  }

  private pickbarHtml = '';

  /** 中身が変わったときだけ書き換える（押している途中でボタンが作り直されないように） */
  private setPickbarHtml(html: string) {
    if (html === this.pickbarHtml) return;
    this.pickbarHtml = html;
    this.el.pickbar.innerHTML = html;
    const c = this.el.pickbar.querySelector('.pick-chips');
    if (c) c.scrollLeft = c.scrollWidth;
  }

  /** 選んでいる列車の路線を地図に描く */
  updateRoute(force = false) {
    if (!this.world) return;
    const id = this.tool === 'order' ? this.orderTrain : this.selectedTrain;
    const t = this.world.trains.get(id);
    if (!t) {
      if (this.routeKey !== '') {
        this.routeKey = '';
        this.renderer.setRoute(null);
      }
      return;
    }
    const orders = this.world.orderLists.get(t.orderList)!.orders;
    const key = `${id}:${this.world.trackVersion}:${t.curOrder}:${orders.map((o) => o.station).join(',')}`;
    if (!force && key === this.routeKey) return;
    this.routeKey = key;
    const stops = orders.map((o) => o.station).filter((s) => this.world.stations.has(s));
    const paths: (number[] | null)[] = [];
    if (stops.length >= 2) {
      for (let i = 0; i < stops.length; i++) {
        const a = this.world.stations.get(stops[i])!;
        const b = this.world.stations.get(stops[(i + 1) % stops.length])!;
        paths.push(findPath(this.world, a.tiles[0], new Set(b.tiles)));
      }
    }
    this.renderer.setRoute({ stops, paths, current: t.curOrder });
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
    this.updateRoute(true);
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
        return buildStation(w, p.a, p.b, { dry: true, axis: this.explicitAxis() });
      case 'depot':
        return buildDepot(w, p.b, { dry: true });
      case 'demolish':
        return demolish(w, p.a, p.b, { dry: true });
      case 'industry':
        return this.industryCmd(p.b, true);
    }
  }

  // ───────────────────────── 産業をつくる（探鉱・工場の建設） ─────────────────────────

  /** 産業をつくるツールで選んでいる種類 */
  industryType: IndustryType = 'sawmill';

  startIndustryTool(type: IndustryType) {
    this.industryType = type;
    this.tool = 'none';
    this.setTool('industry');
    this.toast(
      `${PRIMARY_TYPES.includes(type) ? '探鉱' : '建設'}する場所を${this.touchUI ? 'タップ' : 'クリック'}してください（${INDUSTRY_SPECS[type].w}×${INDUSTRY_SPECS[type].h}マス）`,
      'info',
    );
  }

  /** 押したマスを中心に、産業の左上を決める */
  private industryOrigin(tile: number): { x: number; y: number } {
    const spec = INDUSTRY_SPECS[this.industryType];
    return {
      x: tx(this.world, tile) - Math.floor((spec.w - 1) / 2),
      y: ty(this.world, tile) - Math.floor((spec.h - 1) / 2),
    };
  }

  private industryCmd(tile: number, dry: boolean): CmdResult & { chance?: number } {
    const { x, y } = this.industryOrigin(tile);
    return PRIMARY_TYPES.includes(this.industryType)
      ? startSurvey(this.world, this.industryType, x, y, { dry })
      : buildFactory(this.world, this.industryType, x, y, { dry });
  }

  private industryLabel(): string {
    const primary = PRIMARY_TYPES.includes(this.industryType);
    const name = INDUSTRY_SPECS[this.industryType].suffix.replace(/^の/, '');
    return primary ? `探鉱：${name}` : `建設：${name}`;
  }

  private commit(p: Pending, remove: boolean): boolean {
    const w = this.world;
    let r: CmdResult;
    switch (p.kind) {
      case 'track':
        r = buildTrack(w, p.a, p.b, { remove });
        break;
      case 'station':
        r = buildStation(w, p.a, p.b, { axis: this.explicitAxis() });
        break;
      case 'depot':
        r = buildDepot(w, p.b);
        break;
      case 'demolish':
        r = demolish(w, p.a, p.b);
        break;
      case 'industry': {
        r = this.industryCmd(p.b, false);
        if (r.ok && PRIMARY_TYPES.includes(this.industryType)) {
          this.toast(`探鉱をはじめました。${INDUSTRY_ECON.surveyDays}日後に結果がわかります`, 'info');
        }
        break;
      }
    }
    const ok = this.result(r, p.b);
    if (ok && p.kind === 'depot' && r.id && !this.touchUI) {
      this.toast('車庫を建てました。クリックすると列車を買えます', 'good');
    }
    return ok;
  }

  /** 駅の向き：'auto' はまわりの線路から推測 */
  stationAxis: 'auto' | Axis = 'auto';
  private hoverPending: Pending | null = null;

  private explicitAxis(): Axis | undefined {
    return this.stationAxis === 'auto' ? undefined : this.stationAxis;
  }

  /** 1マスの駅の向きを切り替える（PC：O キー／ボタン、スマホ：確定バーの回転ボタン） */
  rotateStation() {
    const p = this.pending ?? this.hoverPending;
    let cur: Axis = this.stationAxis === 'auto' ? 'x' : this.stationAxis;
    if (p && p.kind === 'station') {
      cur = stationAxisFor(this.world, straightLine(this.world, p.a, p.b, STATION.maxLength), this.explicitAxis());
    }
    this.stationAxis = cur === 'x' ? 'y' : 'x';
    if (this.tool !== 'station') this.setTool('station');
    if (this.pending) this.showPreview(this.pending, this.removeMode);
    else if (this.hoverPending) this.showPreview(this.hoverPending, false);
    this.updateHud();
  }

  private previewTiles(p: Pending): { tiles: number[]; path?: number[]; catchment?: Rect | null; axis?: Axis } {
    const w = this.world;
    switch (p.kind) {
      case 'track': {
        const path = trackPath(w, p.a, p.b, this.removeMode);
        return { tiles: path, path };
      }
      case 'station': {
        const tiles = straightLine(w, p.a, p.b, STATION.maxLength);
        return { tiles, catchment: catchmentOf(w, tiles), axis: stationAxisFor(w, tiles, this.explicitAxis()) };
      }
      case 'depot':
        return { tiles: [p.b] };
      case 'demolish':
        return { tiles: rectTiles(w, p.a, p.b) };
      case 'industry': {
        const { x, y } = this.industryOrigin(p.b);
        const spec = INDUSTRY_SPECS[this.industryType];
        const tiles: number[] = [];
        for (let yy = y; yy < y + spec.h; yy++) {
          for (let xx = x; xx < x + spec.w; xx++) if (xx >= 0 && yy >= 0 && xx < w.w && yy < w.h) tiles.push(yy * w.w + xx);
        }
        return { tiles };
      }
    }
  }

  private showPreview(p: Pending | null, remove: boolean, mods?: Mods) {
    if (!p) {
      this.renderer.setOverlay({ preview: null });
      this.el.tip.hidden = true;
      this.renderConfirm(null, null);
      return;
    }
    const r = this.dry(p, remove) as CmdResult & { chance?: number };
    const t = this.previewTiles(p);
    const info = this.stationInfo(p);
    const preview: Preview = {
      ...t,
      ok: r.ok,
      remove: remove && p.kind === 'track',
      kind: p.kind === 'industry' ? 'depot' : p.kind,
      marks: info?.marks,
    };
    this.renderer.setOverlay({ preview });
    this.lastStationInfo = info?.html ?? '';
    const chance = r.chance !== undefined ? `・成功率${Math.round(r.chance * 100)}%` : '';
    const label = r.ok ? `${formatYen(r.cost)}${chance}` : (r.error ?? '');
    if (this.touchUI) {
      this.renderConfirm(p, r);
    } else {
      const tip = this.el.tip;
      tip.hidden = false;
      tip.className = r.ok ? '' : 'bad';
      tip.innerHTML = (r.ok ? `${esc(label)}${mods?.shift ? '<small>（見積もり）</small>' : ''}` : esc(label)) + (info ? `<div class="tip-info">${info.html}</div>` : '');
      tip.style.transform = `translate(${this.mouse.x + 16}px, ${this.mouse.y + 18}px)`;
    }
  }

  private lastStationInfo = '';

  /** 駅のプレビュー：範囲から集められるもの・受け入れる貨物・範囲に入る産業 */
  private stationInfo(p: Pending): { html: string; marks: NonNullable<Preview['marks']> } | null {
    if (p.kind !== 'station') return null;
    const w = this.world;
    const tiles = straightLine(w, p.a, p.b, STATION.maxLength);
    const r = catchmentOf(w, tiles);
    if (!r) return null;
    const sign = tiles[Math.floor(tiles.length / 2)];
    const sup = suppliesForRect(w, r);
    const acc = acceptanceForRect(w, r, tx(w, sign), ty(w, sign));
    const collect: string[] = [];
    for (const ind of sup.industries) {
      const spec = INDUSTRY_SPECS[ind.type];
      const ok = canLoadFrom(w, ind);
      const cargo = CARGO_SPECS[spec.output].name;
      collect.push(
        `<span class="${ok ? '' : 'locked'}">${esc(ind.name)}：${cargo}${spec.inputs.length ? '' : ` 月${Math.round(ind.prodRate)}t`}${ok ? '' : '（他社・運べない）'}</span>`,
      );
    }
    if (sup.houses > 0) collect.push(`<span>旅客：家${sup.houses}軒・月${sup.paxPerMonth}人ほど</span>`);
    const accepts = CARGOS.filter((c) => (acc.by[c]?.length ?? 0) > 0).map((c) => CARGO_SPECS[c].name);
    const html = `<div><b>集める</b>${collect.length ? collect.join('') : '<span class="none">なし</span>'}</div>
      <div><b>受け入れ</b>${accepts.length ? `<span>${accepts.join('・')}</span>` : '<span class="none">なし</span>'}</div>`;
    const marks = sup.industries.map((ind) => ({ x: ind.x, y: ind.y, w: ind.w, h: ind.h, ok: canLoadFrom(w, ind) }));
    return { html, marks };
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
    const name = p.kind === 'track' && this.removeMode ? '線路の撤去' : p.kind === 'industry' ? this.industryLabel() : TOOL_NAMES[p.kind];
    const chance = (r as CmdResult & { chance?: number }).chance;
    c.innerHTML = `
      ${p.kind === 'station' && this.lastStationInfo ? `<div class="confirm-info">${this.lastStationInfo}</div>` : ''}
      <div class="confirm-text ${r.ok ? '' : 'bad'}">
        <b>${name}</b>
        <span>${r.ok ? formatYen(r.cost) : esc(r.error ?? '')}</span>
        ${r.ok && chance !== undefined ? `<small>成功率 ${Math.round(chance * 100)}%（失敗すると費用はもどりません）</small>` : ''}
        ${p.kind === 'track' && p.a === p.b ? '<small>もう一度タップで終点</small>' : ''}
      </div>
      ${p.kind === 'station' && p.a === p.b ? `<button class="round rotate" data-c="rotate" aria-label="向きを変える">${ICONS.rotate}</button>` : ''}
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
    if (t >= 0 && (this.tool === 'station' || this.tool === 'depot' || this.tool === 'industry')) {
      this.hoverPending = { kind: this.tool, a: t, b: t };
      this.showPreview(this.hoverPending, false, mods);
    } else if (!this.drag) {
      this.hoverPending = null;
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
    if (this.tool === 'order' || this.tool === 'replace') {
      const st = this.stationNear(sx, sy);
      if (st >= 0) this.pickStation(st, mods.ctrl);
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
      else if (k === 'F3' && !e.shiftKey) this.openSaveLoad();
      else if (k === 'F10' && !e.shiftKey) openMarket(this);
      else if (!e.shiftKey && ['F2', 'F6', 'F9', 'F11'].includes(k)) this.notYet(k);
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
      else if (this.railToolbarOpen && (k === 'o' || k === 'O')) this.rotateStation();
      else if (this.railToolbarOpen && ['s', 'S', 'b', 'B', 't', 'T', '8', 'c', 'C'].includes(k)) this.notYet(k.toUpperCase());
      else if (k === 'x' || k === 'X') this.toggleFade();
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
        <button data-a="save" title="セーブ／ロード (F3)">${ICONS.save}</button>
      </div>
      <div class="tb-group">
        <button data-a="finance" title="財務 (F8)">${ICONS.money}</button>
        <button data-a="towns" title="町一覧 (F5)">${ICONS.depot}</button>
        <button data-a="stations" title="駅一覧 (F7)">${ICONS.station}</button>
        <button data-a="industries" title="産業一覧 (F12)">${ICONS.industry}</button>
        <button data-a="trains" title="列車一覧 (Shift+F1)">${ICONS.train}</button>
        <button data-a="requests" title="依頼ボード" class="has-badge">${ICONS.request}<span class="badge"></span></button>
        <button data-a="market" title="相場表 (F10)">${ICONS.market}</button>
        <button data-a="build-industry" title="産業をつくる（探鉱・工場の建設）">${ICONS.factoryPlus}</button>
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
      <button data-a="t-rotate" class="rotate-btn" title="1マスの駅の向き O（自動 → 切り替え）">${ICONS.rotate}<span class="axis-label"></span><kbd>O</kbd></button>
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
      <button data-a="requests" class="m-btn has-badge" aria-label="依頼ボード">${ICONS.request}<span class="badge"></span></button>
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
      else if (b.dataset.c === 'rotate') this.rotateStation();
    });
    this.el.pickbar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('[data-p]') as HTMLButtonElement | null;
      if (!b || b.disabled) return;
      if (b.dataset.p === 'done') this.setTool('none');
      else if (b.dataset.p === 'undo') this.undoPick();
    });
    // 駅名の看板を押しても駅を選べる（ビルに隠れた駅のため）
    this.el.labels.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest('[data-station]') as HTMLElement | null;
      if (el && (this.tool === 'order' || this.tool === 'replace')) this.pickStation(Number(el.dataset.station), e.ctrlKey || e.metaKey);
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
      case 'save':
        this.openSaveLoad();
        break;
      case 'requests':
        openRequests(this);
        break;
      case 'market':
        openMarket(this);
        break;
      case 'build-industry':
        openBuildIndustry(this);
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
      case 't-rotate':
        this.rotateStation();
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
    on('[data-a="build-industry"]', this.tool === 'industry');
    document.querySelectorAll('.axis-label').forEach(
      (el) => (el.textContent = this.stationAxis === 'auto' ? '自動' : this.stationAxis === 'x' ? '＼' : '／'),
    );
    on('[data-a="t-depot"]', this.tool === 'depot');
    on('[data-a="t-demolish"], [data-a="demolish"]', this.tool === 'demolish');
    on('[data-a="t-remove"]', this.removeMode);
    this.el.railbar.hidden = !this.railToolbarOpen || this.touchUI;
    document.body.classList.toggle('picking', this.tool === 'order' || this.tool === 'clone' || this.tool === 'replace');
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
    const n = w.requests.length;
    document.querySelectorAll('.badge').forEach((b) => (b.textContent = n > 0 ? String(n) : ''));
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
      { done: trains.some((t) => t.state !== 'in_depot'), text: '車庫で<b>機関車</b>と<b>原木車</b>を買い、<b>指令</b>で行き先を選んで<b>発車</b>' },
      { done: w.finance.thisYear.income + w.finance.lastYear.income > 0, text: '原木を製材所に届けて<b>お金を稼ぐ</b>' },
      { done: [...w.towns.values()].some((t) => (t.recv.lumber?.total ?? 0) > 0), text: '<b>木材</b>を町に届けて<b>家を建てる</b>' },
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
    const m = dateOf(this.world.day).m;
    if (m !== this.lastAutoMonth) {
      this.lastAutoMonth = m;
      this.autosave();
    }
    this.drainEvents();
    this.renderer.frame(now);
    if (now - this.lastUi > 250) {
      this.lastUi = now;
      this.updateHud();
      this.wm.refreshAll();
      this.updateGuide();
      this.updateRoute();
      if (this.tool === 'order') this.updatePickbar();
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
      } else if (ev.type === 'fx') {
        for (const t of ev.tiles) this.renderer.floatText(t, '🔥', 'fire');
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

