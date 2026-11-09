// 入力変換レイヤー：マウス・タッチを「操作の意味」に変換する
//
// PC（OpenTTD式）：右ドラッグ＝スクロール、ホイール＝ズーム、左クリック/ドラッグ＝建設、
//                  Ctrl＝撤去など、Shift＝見積もりのみ
// スマホ：1本指ドラッグ＝スクロール（ツール選択中は建設プレビュー）、2本指＝スクロール＋ピンチズーム、
//         タップ＝選択、長押し＝情報

export interface Mods {
  ctrl: boolean;
  shift: boolean;
}

export interface InputTarget {
  /** 建設ツールなど「ドラッグで何かをする」状態か */
  toolActive(): boolean;
  pan(dx: number, dy: number): void;
  zoomAt(sx: number, sy: number, factor: number): void;
  zoomStep(sx: number, sy: number, dir: 1 | -1): void;
  hover(sx: number, sy: number, mods: Mods): void;
  dragStart(sx: number, sy: number, mods: Mods, touch: boolean): void;
  dragMove(sx: number, sy: number, mods: Mods, touch: boolean): void;
  dragEnd(sx: number, sy: number, mods: Mods, touch: boolean): void;
  dragCancel(): void;
  tap(sx: number, sy: number, mods: Mods, touch: boolean): void;
  longPress(sx: number, sy: number): void;
}

const TAP_SLOP = 10;
const LONG_PRESS_MS = 500;

export function attachInput(el: HTMLElement, target: InputTarget) {
  const rect = () => el.getBoundingClientRect();
  const local = (e: { clientX: number; clientY: number }) => {
    const r = rect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const mods = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): Mods => ({
    ctrl: e.ctrlKey || e.metaKey,
    shift: e.shiftKey,
  });

  // ───── マウス ─────
  let mouseMode: 'none' | 'pan' | 'left' = 'none';
  let leftDragging = false;
  let last = { x: 0, y: 0 };
  let downAt = { x: 0, y: 0 };

  // ───── タッチ ─────
  const touches = new Map<number, { x: number; y: number }>();
  let touchMode: 'none' | 'pending' | 'pan' | 'tool' | 'pinch' | 'done' = 'none';
  let touchStart = { x: 0, y: 0 };
  let longTimer = 0;
  let pinchDist = 0;
  let pinchMid = { x: 0, y: 0 };

  const clearLong = () => {
    if (longTimer) window.clearTimeout(longTimer);
    longTimer = 0;
  };

  /** 触っている指を全部忘れる（建設のドラッグ中なら取り消す） */
  function resetTouches() {
    if (touchMode === 'tool') target.dragCancel();
    touches.clear();
    touchMode = 'none';
    clearLong();
  }

  const pinchInfo = () => {
    const pts = [...touches.values()];
    const a = pts[0],
      b = pts[1];
    return { mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  /** ポインタをつかむ（つかめない環境でも止まらないように） */
  const capture = (id: number) => {
    try {
      el.setPointerCapture(id);
    } catch {
      /* 何もしない */
    }
  };

  el.addEventListener('contextmenu', (e) => e.preventDefault());

  el.addEventListener('pointerdown', (e) => {
    const p = local(e);
    if (e.pointerType === 'mouse') {
      capture(e.pointerId);
      last = p;
      if (e.button === 2 || e.button === 1) {
        mouseMode = 'pan';
      } else if (e.button === 0) {
        mouseMode = 'left';
        downAt = p;
        leftDragging = false;
        if (target.toolActive()) {
          leftDragging = true;
          target.dragStart(p.x, p.y, mods(e), false);
        }
      }
      return;
    }
    // タッチ・ペン
    e.preventDefault();
    capture(e.pointerId);
    // 新しい操作の1本目の指（isPrimary）なのに、前の指が残っている：
    // iPhone で指を離した知らせが届かなかった（ホームバーのスワイプ・通知・アプリの切り替えなど）。
    // 残ったままだと、次のスワイプが「2本指＝ピンチ」になってしまうので、ここで忘れる
    if (e.isPrimary && touches.size > 0) resetTouches();
    touches.set(e.pointerId, p);
    if (touches.size === 1) {
      touchMode = 'pending';
      touchStart = p;
      last = p;
      clearLong();
      longTimer = window.setTimeout(() => {
        if (touchMode === 'pending') {
          touchMode = 'done';
          target.longPress(p.x, p.y);
        }
      }, LONG_PRESS_MS);
    } else if (touches.size === 2) {
      clearLong();
      if (touchMode === 'tool') target.dragCancel();
      touchMode = 'pinch';
      const pi = pinchInfo();
      pinchDist = pi.dist;
      pinchMid = pi.mid;
    }
  });

  el.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType === 'mouse') {
      if (mouseMode === 'pan') {
        target.pan(p.x - last.x, p.y - last.y);
      } else if (mouseMode === 'left') {
        if (leftDragging) target.dragMove(p.x, p.y, mods(e), false);
      } else {
        target.hover(p.x, p.y, mods(e));
      }
      last = p;
      return;
    }
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, p);
    if (touchMode === 'pinch' && touches.size >= 2) {
      const pi = pinchInfo();
      target.pan(pi.mid.x - pinchMid.x, pi.mid.y - pinchMid.y);
      if (pinchDist > 0 && pi.dist > 0) target.zoomAt(pi.mid.x, pi.mid.y, pi.dist / pinchDist);
      pinchDist = pi.dist;
      pinchMid = pi.mid;
      return;
    }
    if (touchMode === 'pending') {
      if (Math.hypot(p.x - touchStart.x, p.y - touchStart.y) < TAP_SLOP) return;
      clearLong();
      if (target.toolActive()) {
        touchMode = 'tool';
        target.dragStart(touchStart.x, touchStart.y, { ctrl: false, shift: false }, true);
      } else {
        touchMode = 'pan';
      }
    }
    if (touchMode === 'pan') {
      target.pan(p.x - last.x, p.y - last.y);
    } else if (touchMode === 'tool') {
      target.dragMove(p.x, p.y, { ctrl: false, shift: false }, true);
    }
    last = p;
  });

  const endPointer = (e: PointerEvent, cancelled: boolean) => {
    const p = local(e);
    if (e.pointerType === 'mouse') {
      if (mouseMode === 'left') {
        const moved = Math.hypot(p.x - downAt.x, p.y - downAt.y) >= 4;
        if (leftDragging) {
          if (cancelled) target.dragCancel();
          else target.dragEnd(p.x, p.y, mods(e), false);
        } else if (!moved && !cancelled) {
          target.tap(p.x, p.y, mods(e), false);
        }
      }
      mouseMode = 'none';
      leftDragging = false;
      return;
    }
    if (!touches.has(e.pointerId)) return;
    touches.delete(e.pointerId);
    clearLong();
    if (touchMode === 'pinch') {
      if (touches.size === 0) touchMode = 'none';
      else {
        // 1本指が残った：そのままスクロールを続ける
        touchMode = 'pan';
        last = [...touches.values()][0];
      }
      return;
    }
    if (touches.size > 0) return;
    if (cancelled) {
      if (touchMode === 'tool') target.dragCancel();
    } else if (touchMode === 'pending') {
      target.tap(p.x, p.y, { ctrl: false, shift: false }, true);
    } else if (touchMode === 'tool') {
      target.dragEnd(p.x, p.y, { ctrl: false, shift: false }, true);
    }
    touchMode = 'none';
  };

  el.addEventListener('pointerup', (e) => endPointer(e, false));
  el.addEventListener('pointercancel', (e) => endPointer(e, true));
  // つかんでいたポインタを失った（システムに取られた）ときも、指を離したことにする
  el.addEventListener('lostpointercapture', (e) => {
    if (e.pointerType !== 'mouse' && touches.has(e.pointerId)) endPointer(e, true);
  });
  // アプリが裏に回った・ほかに切り替わったら、触っている指を全部忘れる
  window.addEventListener('blur', resetTouches);
  window.addEventListener('pagehide', resetTouches);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetTouches();
  });
  el.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && mouseMode === 'none') target.hover(-1, -1, mods(e));
  });

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = local(e);
      // トラックパッドのピンチ（ctrlKey 付き）はなめらかに、ホイールは OpenTTD のように段階的に
      if (e.ctrlKey) {
        target.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.01));
      } else {
        wheelAcc += e.deltaY;
        if (Math.abs(wheelAcc) >= 40 || e.deltaMode !== 0) {
          target.zoomStep(p.x, p.y, wheelAcc < 0 ? 1 : -1);
          wheelAcc = 0;
        }
      }
    },
    { passive: false },
  );
  let wheelAcc = 0;

  // iOS Safari のページ全体のピンチ拡大を止める
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
  }
}
