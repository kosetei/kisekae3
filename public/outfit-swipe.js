// 生成済みの服を左右にたどるための純関数（DOM なし）
(function (root) {
  'use strict';

  const SWIPE_THRESHOLD_PX = 50;

  function swipeableGeneratedDresses(scopedDresses, hasGenerated) {
    if (!Array.isArray(scopedDresses)) return [];
    return scopedDresses.filter((dress) => hasGenerated(dress));
  }

  // currentId が生成済みリストにない（未選択・未生成）ときは、
  // スコープ全体の並びから次／前の生成済みを探す。端まで行ったら先頭／末尾へ戻る。
  function adjacentGeneratedIndex(generatedList, scopedDresses, currentId, delta) {
    if (!generatedList.length) return -1;
    const step = delta < 0 ? -1 : 1;
    if (generatedList.length === 1) {
      return generatedList[0].id === currentId ? -1 : 0;
    }
    const currentIndex = generatedList.findIndex((dress) => dress.id === currentId);
    if (currentIndex >= 0) {
      return (currentIndex + step + generatedList.length) % generatedList.length;
    }
    const scope = Array.isArray(scopedDresses) ? scopedDresses : [];
    if (!currentId) {
      return step > 0 ? 0 : generatedList.length - 1;
    }
    const scopedIndex = scope.findIndex((dress) => dress.id === currentId);
    if (scopedIndex < 0) {
      return step > 0 ? 0 : generatedList.length - 1;
    }
    if (step > 0) {
      for (let i = scopedIndex + 1; i < scope.length; i += 1) {
        const index = generatedList.findIndex((dress) => dress.id === scope[i].id);
        if (index >= 0) return index;
      }
      return 0;
    }
    for (let i = scopedIndex - 1; i >= 0; i -= 1) {
      const index = generatedList.findIndex((dress) => dress.id === scope[i].id);
      if (index >= 0) return index;
    }
    return generatedList.length - 1;
  }

  function positionLabel(generatedList, currentId) {
    if (!generatedList.length) return '';
    const index = generatedList.findIndex((dress) => dress.id === currentId);
    if (index < 0) return `\u2014 / ${generatedList.length}`;
    return `${index + 1} / ${generatedList.length}`;
  }

  function shouldAcceptSwipe(dx, dy, threshold) {
    const limit = threshold == null ? SWIPE_THRESHOLD_PX : threshold;
    return Math.abs(dx) >= limit && Math.abs(dx) > Math.abs(dy);
  }

  // 左フリック（dx < 0）で次、右フリックで前
  function swipeDelta(dx, dy, threshold) {
    if (!shouldAcceptSwipe(dx, dy, threshold)) return 0;
    return dx < 0 ? 1 : -1;
  }

  function isTypingTarget(target) {
    if (!target) return false;
    const tag = String(target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
    return Boolean(target.isContentEditable);
  }

  function createSwipeTracker(options) {
    const threshold = options && options.threshold != null ? options.threshold : SWIPE_THRESHOLD_PX;
    const onSwipe = options && options.onSwipe;
    let active = null;
    const pointers = new Set();

    function cancelActive() {
      if (active) active.canceled = true;
    }

    return {
      pointerdown(event) {
        pointers.add(event.pointerId);
        if (pointers.size > 1) {
          cancelActive();
          return;
        }
        if (event.isPrimary === false) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        active = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          canceled: false,
        };
      },
      pointermove(event) {
        if (pointers.size > 1) {
          cancelActive();
          return { prevent: false };
        }
        if (!active || active.canceled || event.pointerId !== active.pointerId) {
          return { prevent: false };
        }
        const dx = event.clientX - active.startX;
        const dy = event.clientY - active.startY;
        return { prevent: Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 8 };
      },
      pointerup(event) {
        pointers.delete(event.pointerId);
        if (!active || event.pointerId !== active.pointerId) return 0;
        const session = active;
        active = null;
        if (session.canceled) return 0;
        const dx = event.clientX - session.startX;
        const dy = event.clientY - session.startY;
        const delta = swipeDelta(dx, dy, threshold);
        if (delta && typeof onSwipe === 'function') onSwipe(delta);
        return delta;
      },
      pointercancel(event) {
        pointers.delete(event.pointerId);
        if (active && event.pointerId === active.pointerId) active = null;
      },
      reset() {
        active = null;
        pointers.clear();
      },
    };
  }

  root.OutfitSwipe = {
    SWIPE_THRESHOLD_PX,
    swipeableGeneratedDresses,
    adjacentGeneratedIndex,
    positionLabel,
    shouldAcceptSwipe,
    swipeDelta,
    isTypingTarget,
    createSwipeTracker,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
