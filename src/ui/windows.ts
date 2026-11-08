// ウィンドウ管理
// PC：OpenTTD のような小窓（ドラッグで移動・ピンで固定・×で閉じる）
// スマホ：画面の横（横持ち）または下（縦持ち）から出るパネル。いちばん上の1枚だけ表示

import { ICONS } from './icons';

export interface WindowSpec {
  id: string;
  title: string;
  width?: number;
  /** 本文の HTML。内容が変わったときだけ書き換える */
  render: () => string;
  /** data-action を持つ要素がクリックされたとき */
  onAction?: (action: string, el: HTMLElement, ev: MouseEvent) => void;
  onChange?: (el: HTMLInputElement | HTMLSelectElement) => void;
  onClose?: () => void;
  /** 名前を変えられるウィンドウ（タイトルの横に鉛筆ボタン） */
  rename?: { get: () => string; set: (name: string) => boolean };
  /** draggable な行（data-i）をドラッグで並べ替えたとき（PC） */
  onReorder?: (from: number, to: number) => void;
}

interface Win {
  spec: WindowSpec;
  el: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  sticky: boolean;
  lastHtml: string;
  editing: boolean;
}

export class WindowManager {
  private wins = new Map<string, Win>();
  private z = 10;
  private cascade = 0;
  touchMode = false;

  constructor(private root: HTMLElement) {}

  isOpen(id: string): boolean {
    return this.wins.has(id);
  }

  open(spec: WindowSpec): void {
    const existing = this.wins.get(spec.id);
    if (existing) {
      existing.spec = spec;
      this.focus(existing);
      this.refresh(spec.id, true);
      return;
    }
    const el = document.createElement('section');
    el.className = 'win';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', spec.title);
    if (spec.width) el.style.width = `${spec.width}px`;
    el.innerHTML = `
      <header class="win-title">
        <span class="win-title-text"></span>
        ${spec.rename ? `<button class="win-btn win-rename" title="名前を変える" aria-label="名前を変える">${ICONS.pencil}</button>` : ''}
        <button class="win-btn win-pin" title="固定（Delete キーで閉じない）" aria-label="固定">${ICONS.pin}</button>
        <button class="win-btn win-close" title="閉じる" aria-label="閉じる">${ICONS.close}</button>
      </header>
      <div class="win-body"></div>`;
    const titleEl = el.querySelector('.win-title-text') as HTMLElement;
    const body = el.querySelector('.win-body') as HTMLElement;
    const win: Win = { spec, el, body, titleEl, sticky: false, lastHtml: '', editing: false };
    titleEl.textContent = spec.title;
    this.root.appendChild(el);
    this.wins.set(spec.id, win);
    this.place(win);
    this.focus(win);
    this.refresh(spec.id, true);

    el.querySelector('.win-close')!.addEventListener('click', () => this.close(spec.id));
    el.querySelector('.win-rename')?.addEventListener('click', () => this.startRename(win));
    this.makeReorderable(win);
    el.querySelector('.win-pin')!.addEventListener('click', () => {
      win.sticky = !win.sticky;
      el.classList.toggle('sticky', win.sticky);
    });
    el.addEventListener('pointerdown', () => this.focus(win));
    el.addEventListener('click', (ev) => {
      const a = (ev.target as HTMLElement).closest('[data-action]') as HTMLElement | null;
      if (a && el.contains(a) && !(a as HTMLButtonElement).disabled) win.spec.onAction?.(a.dataset.action!, a, ev);
    });
    el.addEventListener('change', (ev) => {
      const t = ev.target as HTMLInputElement | HTMLSelectElement;
      win.spec.onChange?.(t);
    });
    this.makeDraggable(win);
  }

  close(id: string): void {
    const w = this.wins.get(id);
    if (!w) return;
    w.el.remove();
    this.wins.delete(id);
    w.spec.onClose?.();
    this.updateTouchStack();
  }

  /** Delete：いちばん上の（固定していない）ウィンドウを閉じる */
  closeTop(): void {
    const top = [...this.wins.values()].filter((w) => !w.sticky).sort((a, b) => +b.el.style.zIndex - +a.el.style.zIndex)[0];
    if (top) this.close(top.spec.id);
  }

  /** Shift+Delete：固定していないウィンドウを全部閉じる */
  closeAll(): void {
    for (const w of [...this.wins.values()]) if (!w.sticky) this.close(w.spec.id);
  }

  closeWhere(pred: (id: string) => boolean): void {
    for (const id of [...this.wins.keys()]) if (pred(id)) this.close(id);
  }

  refresh(id: string, force = false): void {
    const w = this.wins.get(id);
    if (!w) return;
    const html = w.spec.render();
    if (force || html !== w.lastHtml) {
      // 入力中の要素は書き換えで消えないよう、フォーカスを覚えておく
      const active = document.activeElement as HTMLElement | null;
      const key = active && w.body.contains(active) ? active.dataset.key : undefined;
      w.body.innerHTML = html;
      w.lastHtml = html;
      if (key) (w.body.querySelector(`[data-key="${key}"]`) as HTMLElement | null)?.focus();
    }
    if (!w.editing) w.titleEl.textContent = w.spec.title;
  }

  /** 行をドラッグして並べ替える（PC のマウス操作） */
  private makeReorderable(w: Win) {
    let from = -1;
    const row = (e: Event) => (e.target as HTMLElement).closest('[draggable="true"][data-i]') as HTMLElement | null;
    w.el.addEventListener('dragstart', (e) => {
      const r = row(e);
      if (!r || !w.spec.onReorder) return;
      from = Number(r.dataset.i);
      r.classList.add('dragging');
      e.dataTransfer?.setData('text/plain', String(from));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    });
    w.el.addEventListener('dragover', (e) => {
      const r = row(e);
      if (from < 0 || !r) return;
      e.preventDefault();
      w.el.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
      r.classList.add('drop-target');
    });
    const clear = () => {
      from = -1;
      w.el.querySelectorAll('.dragging, .drop-target').forEach((x) => x.classList.remove('dragging', 'drop-target'));
    };
    w.el.addEventListener('drop', (e) => {
      const r = row(e);
      if (from >= 0 && r) {
        e.preventDefault();
        const to = Number(r.dataset.i);
        if (to !== from) w.spec.onReorder?.(from, to);
      }
      clear();
    });
    w.el.addEventListener('dragend', clear);
  }

  /** タイトルをその場で書き換える（Enter・欄の外を押すと決定、Esc で取り消し） */
  private startRename(w: Win) {
    const r = w.spec.rename;
    if (!r || w.editing) return;
    w.editing = true;
    const input = document.createElement('input');
    input.className = 'win-rename-input';
    input.value = r.get();
    input.maxLength = 20;
    input.setAttribute('aria-label', '新しい名前');
    w.titleEl.textContent = '';
    w.titleEl.appendChild(input);
    w.el.classList.add('renaming');
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      const ok = save ? r.set(input.value) : true;
      if (!ok) {
        // うまくいかなかったら（空の名前など）もう一度
        done = false;
        input.focus();
        return;
      }
      w.editing = false;
      w.el.classList.remove('renaming');
      w.titleEl.textContent = w.spec.title;
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  refreshAll(): void {
    for (const id of this.wins.keys()) this.refresh(id);
  }

  setTouchMode(on: boolean) {
    this.touchMode = on;
    for (const w of this.wins.values()) this.place(w);
    this.updateTouchStack();
  }

  /** スマホ表示ではパネルを一時的に隠す（地図の駅を選ぶときなど） */
  setCollapsed(on: boolean) {
    this.root.classList.toggle('collapsed', on);
  }

  private focus(w: Win) {
    w.el.style.zIndex = String(++this.z);
    this.updateTouchStack();
  }

  private updateTouchStack() {
    const list = [...this.wins.values()].sort((a, b) => +a.el.style.zIndex - +b.el.style.zIndex);
    list.forEach((w, i) => w.el.classList.toggle('behind', this.touchMode && i < list.length - 1));
  }

  private place(w: Win) {
    if (this.touchMode) {
      w.el.style.left = '';
      w.el.style.top = '';
      return;
    }
    const W = this.root.clientWidth,
      H = this.root.clientHeight;
    const ww = w.spec.width ?? 320;
    // いちばん上のウィンドウの横に並べる（重ならないように）
    const top = [...this.wins.values()]
      .filter((x) => x !== w)
      .sort((a, b) => +b.el.style.zIndex - +a.el.style.zIndex)[0];
    if (top) {
      const tl = top.el.offsetLeft,
        tw = top.el.offsetWidth,
        tt = top.el.offsetTop;
      const right = tl + tw + 10,
        left = tl - ww - 10;
      if (right + ww <= W - 8) {
        w.el.style.left = `${right}px`;
        w.el.style.top = `${tt}px`;
        return;
      }
      if (left >= 8) {
        w.el.style.left = `${left}px`;
        w.el.style.top = `${tt}px`;
        return;
      }
    }
    const off = (this.cascade++ % 6) * 28;
    // 最初のウィンドウは画面の右側に（地図の真ん中を空けておく）
    w.el.style.left = `${Math.max(8, W - ww - 16 - off)}px`;
    w.el.style.top = `${Math.max(52, Math.min(H - 200, 104 + off))}px`;
  }

  private makeDraggable(w: Win) {
    const handle = w.el.querySelector('.win-title') as HTMLElement;
    let start: { x: number; y: number; l: number; t: number } | null = null;
    handle.addEventListener('pointerdown', (e) => {
      if (this.touchMode || (e.target as HTMLElement).closest('button')) return;
      start = { x: e.clientX, y: e.clientY, l: w.el.offsetLeft, t: w.el.offsetTop };
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (!start) return;
      const W = this.root.clientWidth,
        H = this.root.clientHeight;
      const l = Math.max(-w.el.offsetWidth + 60, Math.min(W - 60, start.l + e.clientX - start.x));
      const t = Math.max(40, Math.min(H - 40, start.t + e.clientY - start.y));
      w.el.style.left = `${l}px`;
      w.el.style.top = `${t}px`;
    });
    const end = () => (start = null);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
