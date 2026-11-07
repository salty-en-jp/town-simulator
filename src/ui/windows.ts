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
}

interface Win {
  spec: WindowSpec;
  el: HTMLElement;
  body: HTMLElement;
  titleEl: HTMLElement;
  sticky: boolean;
  lastHtml: string;
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
        <button class="win-btn win-pin" title="固定（Delete キーで閉じない）" aria-label="固定">${ICONS.pin}</button>
        <button class="win-btn win-close" title="閉じる" aria-label="閉じる">${ICONS.close}</button>
      </header>
      <div class="win-body"></div>`;
    const titleEl = el.querySelector('.win-title-text') as HTMLElement;
    const body = el.querySelector('.win-body') as HTMLElement;
    const win: Win = { spec, el, body, titleEl, sticky: false, lastHtml: '' };
    titleEl.textContent = spec.title;
    this.root.appendChild(el);
    this.wins.set(spec.id, win);
    this.place(win);
    this.focus(win);
    this.refresh(spec.id, true);

    el.querySelector('.win-close')!.addEventListener('click', () => this.close(spec.id));
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
    w.titleEl.textContent = w.spec.title;
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
