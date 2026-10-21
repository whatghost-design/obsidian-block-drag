/* 區塊拖曳 Block Drag — by whatghost_design（什麼鬼設計） */
'use strict';

const { Plugin, Menu } = require('obsidian');
const { ViewPlugin } = require('@codemirror/view');

const LIST_RE = /^\s*([-*+]|\d+[.)])\s/;
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
const TABLE_RE = /^\s*\|/;
const QUOTE_RE = /^\s*>/;
const HEADING_RE = /^(#{1,6})\s/;

const DRAG_THRESHOLD = 4; // 移動超過幾 px 才算拖曳（否則算點擊）
const HANDLE_GAP = 26; // 把手離文字左緣的距離
const NEST_OFFSET = 32; // 往右拖超過幾 px 變成子項目
const NEST_INDICATOR_SHIFT = 24;
const SCROLL_EDGE = 48; // 拖到上下邊緣多近開始自動捲動

function indentOf(text) {
  return text.match(/^\s*/)[0];
}

function indentWidth(text) {
  let w = 0;
  for (const ch of indentOf(text)) w += ch === '\t' ? 4 : 1;
  return w;
}

// ── 文件結構：frontmatter、程式碼區塊、公式、表格、引言 ──
// 這些區域要整塊一起搬，不能從中間拆開。
const structureCache = new WeakMap();

function getStructure(doc) {
  const cached = structureCache.get(doc);
  if (cached) return cached;

  const n = doc.lines;
  const group = new Array(n + 2).fill(null);
  let fmEnd = 0;

  if (n > 1 && doc.line(1).text.trim() === '---') {
    for (let i = 2; i <= n; i++) {
      const t = doc.line(i).text.trim();
      if (t === '---' || t === '...') {
        fmEnd = i;
        break;
      }
    }
  }

  let i = fmEnd + 1;
  while (i <= n) {
    const text = doc.line(i).text;
    let end = 0;
    const fence = text.match(FENCE_RE);

    if (fence) {
      const marker = fence[1];
      const closeRe = new RegExp('^\\s*' + (marker[0] === '`' ? '`' : '~') + '{' + marker.length + ',}\\s*$');
      end = n;
      for (let j = i + 1; j <= n; j++) {
        if (closeRe.test(doc.line(j).text)) {
          end = j;
          break;
        }
      }
    } else if (text.trim() === '$$') {
      end = n;
      for (let j = i + 1; j <= n; j++) {
        if (doc.line(j).text.trim() === '$$') {
          end = j;
          break;
        }
      }
    } else if (TABLE_RE.test(text) || QUOTE_RE.test(text)) {
      const re = TABLE_RE.test(text) ? TABLE_RE : QUOTE_RE;
      end = i;
      while (end < n && re.test(doc.line(end + 1).text)) end++;
    }

    if (end) {
      for (let j = i; j <= end; j++) group[j] = [i, end];
      i = end + 1;
    } else {
      i++;
    }
  }

  const structure = { fmEnd, group };
  structureCache.set(doc, structure);
  return structure;
}

// 標題層級（1–6），不是標題回傳 0；程式碼區塊裡的 # 不算
function headingLevel(doc, group, lineNo) {
  if (group[lineNo]) return 0;
  const m = doc.line(lineNo).text.match(HEADING_RE);
  return m ? m[1].length : 0;
}

// 某一行所屬的「區塊」範圍：
// 標題 → 一直到下一個同級或更大的標題為止（整個章節）
// 清單項目 → 連同底下縮排的子項目
function getBlockRange(doc, lineNo) {
  const { fmEnd, group } = getStructure(doc);
  if (lineNo <= fmEnd) return null;
  if (group[lineNo]) return { start: group[lineNo][0], end: group[lineNo][1] };

  const text = doc.line(lineNo).text;
  if (!text.trim()) return null;

  const level = headingLevel(doc, group, lineNo);
  if (level) {
    let end = doc.lines;
    for (let j = lineNo + 1; j <= doc.lines; j++) {
      const l = headingLevel(doc, group, j);
      if (l && l <= level) {
        end = j - 1;
        break;
      }
    }
    while (end > lineNo && !doc.line(end).text.trim()) end--;
    return { start: lineNo, end };
  }

  const base = indentWidth(text);
  let end = lineNo;
  for (let j = lineNo + 1; j <= doc.lines; j++) {
    const t = doc.line(j).text;
    if (!t.trim()) continue;
    if (indentWidth(t) > base) end = j;
    else break;
  }
  if (group[end]) end = Math.max(end, group[end][1]);
  return { start: lineNo, end };
}

function reindent(text, oldIndent, newIndent) {
  if (!text.trim()) return text;
  if (text.startsWith(oldIndent)) return newIndent + text.slice(oldIndent.length);
  return text;
}

function previewText(text) {
  return text
    .trim()
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .replace(/^\[.\]\s+/, '')
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s*(\[![^\]]*\]\s*)?/, '');
}

class BlockDragView {
  constructor(view, plugin) {
    this.view = view;
    this.plugin = plugin;
    this.hoverRange = null;
    this.drag = null;
    this.raf = 0;
    this.lastMouse = null;

    this.handle = document.createElement('div');
    this.handle.className = 'wg-drag-handle';
    this.handle.setAttribute('aria-label', '拖曳搬移，點一下開選單');
    this.handle.innerHTML =
      '<svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true">' +
      '<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/>' +
      '<circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/>' +
      '<circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/>' +
      '</svg>';

    this.indicator = document.createElement('div');
    this.indicator.className = 'wg-drop-indicator';

    this.source = document.createElement('div');
    this.source.className = 'wg-drag-source';

    view.dom.append(this.source, this.indicator, this.handle);

    this.onMouseMove = (e) => {
      if (this.drag) return;
      this.lastMouse = e;
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => {
        this.raf = 0;
        if (this.lastMouse) this.updateHover(this.lastMouse);
      });
    };
    this.onMouseLeave = () => {
      if (!this.drag) this.hideHandle();
    };
    this.onScroll = () => {
      if (!this.drag) this.hideHandle();
    };
    this.onPointerDown = (e) => this.startPointer(e);

    view.dom.addEventListener('mousemove', this.onMouseMove);
    view.dom.addEventListener('mouseleave', this.onMouseLeave);
    view.scrollDOM.addEventListener('scroll', this.onScroll);
    this.handle.addEventListener('pointerdown', this.onPointerDown);
  }

  update(update) {
    if (!update.docChanged) return;
    if (this.drag) this.endDrag(null);
    this.hideHandle();
  }

  destroy() {
    if (this.drag) this.endDrag(null);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.view.dom.removeEventListener('mousemove', this.onMouseMove);
    this.view.dom.removeEventListener('mouseleave', this.onMouseLeave);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.handle.remove();
    this.indicator.remove();
    this.source.remove();
  }

  // ── 座標工具 ──

  lineAtY(clientY) {
    const block = this.view.lineBlockAtHeight(clientY - this.view.documentTop);
    return this.view.state.doc.lineAt(block.from);
  }

  // 第 0 層文字的左緣（沒有縮排的位置）
  baseLeft() {
    const lineEl = this.view.contentDOM.querySelector('.cm-line');
    if (!lineEl) return this.view.contentDOM.getBoundingClientRect().left;
    const rect = lineEl.getBoundingClientRect();
    return rect.left + parseFloat(getComputedStyle(lineEl).paddingLeft || '0');
  }

  textLeft(line) {
    const coords = this.view.coordsAtPos(line.from + indentOf(line.text).length, 1);
    return coords ? coords.left : this.baseLeft();
  }

  indentUnit() {
    const vault = this.plugin.app.vault;
    const useTab = vault.getConfig ? vault.getConfig('useTab') : true;
    if (useTab === false) return ' '.repeat((vault.getConfig && vault.getConfig('tabSize')) || 4);
    return '\t';
  }

  // ── 把手 ──

  updateHover(e) {
    const doc = this.view.state.doc;
    const range = getBlockRange(doc, this.lineAtY(e.clientY).number);
    if (!range) return this.hideHandle();

    const start = doc.line(range.start);
    const coords =
      this.view.coordsAtPos(start.from + indentOf(start.text).length, 1) || this.view.coordsAtPos(start.from, 1);
    if (!coords) return this.hideHandle();

    const box = this.view.dom.getBoundingClientRect();
    const rowHeight = Math.min(coords.bottom - coords.top, 28);
    this.handle.style.top = coords.top - box.top + rowHeight / 2 - 12 + 'px';
    this.handle.style.left = Math.max(2, coords.left - box.left - HANDLE_GAP) + 'px';
    this.handle.classList.add('is-visible');
    this.hoverRange = range;
  }

  hideHandle() {
    this.handle.classList.remove('is-visible');
    this.hoverRange = null;
  }

  // ── 拖曳 ──

  startPointer(e) {
    if (e.button !== 0 || !this.hoverRange) return;
    e.preventDefault();
    e.stopPropagation();
    this.handle.setPointerCapture(e.pointerId);

    const drag = {
      range: this.hoverRange,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      active: false,
      target: null,
      ghost: null,
      scrollRaf: 0,
    };
    drag.onMove = (ev) => this.onDragMove(ev);
    drag.onUp = (ev) => this.endDrag(ev);
    drag.onCancel = () => this.endDrag(null);
    drag.onKey = (ev) => {
      if (ev.key === 'Escape') this.endDrag(null);
    };

    this.handle.addEventListener('pointermove', drag.onMove);
    this.handle.addEventListener('pointerup', drag.onUp);
    this.handle.addEventListener('pointercancel', drag.onCancel);
    window.addEventListener('keydown', drag.onKey, true);
    this.drag = drag;
  }

  onDragMove(e) {
    const d = this.drag;
    if (!d) return;
    d.lastX = e.clientX;
    d.lastY = e.clientY;

    if (!d.active) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return;
      d.active = true;
      this.beginDragVisuals();
    }

    d.ghost.style.left = e.clientX + 14 + 'px';
    d.ghost.style.top = e.clientY + 10 + 'px';
    this.updateDropTarget();
  }

  beginDragVisuals() {
    const d = this.drag;
    const doc = this.view.state.doc;
    const lineCount = d.range.end - d.range.start + 1;

    document.body.classList.add('wg-block-dragging');
    this.handle.classList.remove('is-visible');

    d.ghost = document.createElement('div');
    d.ghost.className = 'wg-drag-ghost';
    const label = previewText(doc.line(d.range.start).text).slice(0, 60) || '（區塊）';
    d.ghost.textContent = lineCount > 1 ? `${label}　+${lineCount - 1} 行` : label;
    document.body.append(d.ghost);

    this.positionSource();
    this.source.style.display = 'block';

    const tick = () => {
      if (!this.drag || !this.drag.active) return;
      const r = this.view.scrollDOM.getBoundingClientRect();
      const y = this.drag.lastY;
      let dy = 0;
      if (y < r.top + SCROLL_EDGE) dy = -Math.ceil((r.top + SCROLL_EDGE - y) / 3);
      else if (y > r.bottom - SCROLL_EDGE) dy = Math.ceil((y - (r.bottom - SCROLL_EDGE)) / 3);
      if (dy) {
        this.view.scrollDOM.scrollTop += dy;
        this.positionSource();
        this.updateDropTarget();
      }
      this.drag.scrollRaf = requestAnimationFrame(tick);
    };
    d.scrollRaf = requestAnimationFrame(tick);
  }

  positionSource() {
    const { range } = this.drag;
    const doc = this.view.state.doc;
    const box = this.view.dom.getBoundingClientRect();
    const top = this.view.lineBlockAt(doc.line(range.start).from).top + this.view.documentTop;
    const bottom = this.view.lineBlockAt(doc.line(range.end).from).bottom + this.view.documentTop;
    const lineEl = this.view.contentDOM.querySelector('.cm-line');
    const lineRect = lineEl ? lineEl.getBoundingClientRect() : this.view.contentDOM.getBoundingClientRect();

    this.source.style.top = top - box.top + 'px';
    this.source.style.height = bottom - top + 'px';
    this.source.style.left = lineRect.left - box.left + 'px';
    this.source.style.width = lineRect.width + 'px';
  }

  // 算出落點：插在第幾行之前（gap），以及搬過去之後的縮排
  updateDropTarget() {
    const d = this.drag;
    const view = this.view;
    const doc = view.state.doc;
    const { fmEnd, group } = getStructure(doc);
    const { range } = d;
    const x = d.lastX;
    const y = d.lastY;

    const line = this.lineAtY(y);
    let gap;
    if (line.number <= fmEnd) {
      gap = fmEnd + 1;
    } else {
      const g = group[line.number];
      const first = g ? g[0] : line.number;
      const last = g ? g[1] : line.number;
      const top = view.lineBlockAt(doc.line(first).from).top;
      const bottom = view.lineBlockAt(doc.line(last).from).bottom;
      gap = y - view.documentTop < (top + bottom) / 2 ? first : last + 1;
    }

    // 拖整個標題章節：只能放在章節交界，不能插進別的章節中間
    const movedLevel = headingLevel(doc, group, range.start);
    if (movedLevel) gap = this.snapHeadingGap(movedLevel, y);

    // 不能放進自己裡面
    if (gap > range.start && gap <= range.end) return this.clearTarget();

    // 跟自己之間只隔空行 → 等於原地不動
    if (gap > range.end + 1) {
      let blankOnly = true;
      for (let j = range.end + 1; j < gap; j++) {
        if (doc.line(j).text.trim()) {
          blankOnly = false;
          break;
        }
      }
      if (blankOnly) gap = range.end + 1;
    }

    let prevNo = gap - 1;
    if (prevNo >= range.start && prevNo <= range.end) prevNo = range.start - 1;
    let nextNo = gap;
    if (nextNo >= range.start && nextNo <= range.end) nextNo = range.end + 1;

    const prev = prevNo > fmEnd && prevNo >= 1 ? doc.line(prevNo) : null;
    const next = nextNo <= doc.lines ? doc.line(nextNo) : null;

    let newIndent = '';
    let indicatorLeft = this.baseLeft();

    if (!movedLevel && prev && prev.text.trim()) {
      const prevIndent = indentOf(prev.text);
      const prevLeft = this.textLeft(prev);
      newIndent = prevIndent;
      indicatorLeft = prevIndent ? prevLeft : indicatorLeft;

      if (LIST_RE.test(prev.text)) {
        const prevHasChildren = next && next.text.trim() && indentWidth(next.text) > indentWidth(prev.text);
        if (prevHasChildren || x > prevLeft + NEST_OFFSET) {
          // 放在上一項底下，變成它的子項目
          newIndent = prevIndent + this.indentUnit();
          indicatorLeft = prevLeft + NEST_INDICATOR_SHIFT;
        } else if (
          next &&
          LIST_RE.test(next.text) &&
          indentWidth(next.text) < indentWidth(prev.text) &&
          x < prevLeft - 8
        ) {
          // 往左拖：跳出一層，跟下一項同層
          newIndent = indentOf(next.text);
          indicatorLeft = this.textLeft(next);
        }
      }
    }

    const oldIndent = indentOf(doc.line(range.start).text);
    const inPlace = gap === range.start || gap === range.end + 1;
    if (inPlace && newIndent === oldIndent) return this.clearTarget();

    d.target = { gap, newIndent };

    const box = view.dom.getBoundingClientRect();
    const gapY = gap <= doc.lines ? view.lineBlockAt(doc.line(gap).from).top : view.lineBlockAt(doc.length).bottom;
    const lineEl = view.contentDOM.querySelector('.cm-line');
    const right = lineEl ? lineEl.getBoundingClientRect().right : view.contentDOM.getBoundingClientRect().right;

    this.indicator.style.top = gapY + view.documentTop - box.top - 1.5 + 'px';
    this.indicator.style.left = indicatorLeft - box.left + 'px';
    this.indicator.style.width = Math.max(40, right - indicatorLeft) + 'px';
    this.indicator.style.display = 'block';
  }

  // 找離滑鼠最近的章節交界：文件開頭、同級或更大的標題前、文件結尾
  snapHeadingGap(level, clientY) {
    const view = this.view;
    const doc = view.state.doc;
    const { fmEnd, group } = getStructure(doc);
    const yDoc = clientY - view.documentTop;
    let best = doc.lines + 1;
    let bestDist = Infinity;

    const consider = (gap) => {
      const top = gap <= doc.lines ? view.lineBlockAt(doc.line(gap).from).top : view.lineBlockAt(doc.length).bottom;
      const dist = Math.abs(top - yDoc);
      if (dist < bestDist) {
        bestDist = dist;
        best = gap;
      }
    };

    if (fmEnd + 1 <= doc.lines) consider(fmEnd + 1);
    for (let j = fmEnd + 2; j <= doc.lines; j++) {
      const l = headingLevel(doc, group, j);
      if (l && l <= level) consider(j);
    }
    consider(doc.lines + 1);
    return best;
  }

  clearTarget() {
    if (this.drag) this.drag.target = null;
    this.indicator.style.display = 'none';
  }

  endDrag(e) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;

    this.handle.removeEventListener('pointermove', d.onMove);
    this.handle.removeEventListener('pointerup', d.onUp);
    this.handle.removeEventListener('pointercancel', d.onCancel);
    window.removeEventListener('keydown', d.onKey, true);
    if (d.scrollRaf) cancelAnimationFrame(d.scrollRaf);
    if (d.ghost) d.ghost.remove();
    document.body.classList.remove('wg-block-dragging');
    this.indicator.style.display = 'none';
    this.source.style.display = 'none';

    if (!e) return;
    if (!d.active) {
      this.openMenu(e, d.range);
      return;
    }
    if (d.target) this.moveBlock(d.range, d.target.gap, d.target.newIndent);
  }

  // ── 編輯動作 ──

  moveBlock(range, gap, newIndent) {
    const view = this.view;
    const doc = view.state.doc;
    const startLine = doc.line(range.start);
    const endLine = doc.line(range.end);
    const oldIndent = indentOf(startLine.text);
    const text = doc
      .sliceString(startLine.from, endLine.to)
      .split('\n')
      .map((t) => reindent(t, oldIndent, newIndent))
      .join('\n');

    // 原地只改縮排
    if (gap === range.start || gap === range.end + 1) {
      view.dispatch({
        changes: { from: startLine.from, to: endLine.to, insert: text },
        selection: { anchor: startLine.from },
        userEvent: 'move.drag',
      });
      view.focus();
      return;
    }

    const del = this.deletionRange(range);
    const insPos = gap <= doc.lines ? doc.line(gap).from : doc.length;
    const insText = gap <= doc.lines ? text + '\n' : '\n' + text;

    const changes = view.state.changes([del, { from: insPos, insert: insText }]);
    const anchor = changes.mapPos(insPos, -1) + (gap > doc.lines ? 1 : 0);
    view.dispatch({ changes, selection: { anchor }, userEvent: 'move.drag' });
    view.focus();
  }

  // 刪掉區塊時連換行一起刪，避免留空行
  deletionRange(range) {
    const doc = this.view.state.doc;
    const startLine = doc.line(range.start);
    if (range.end < doc.lines) return { from: startLine.from, to: doc.line(range.end + 1).from };
    if (range.start > 1) return { from: startLine.from - 1, to: doc.length };
    return { from: 0, to: doc.length };
  }

  // 上一個／下一個同層區塊的位置
  siblingGap(range, dir) {
    const doc = this.view.state.doc;
    const { fmEnd, group } = getStructure(doc);
    const ownWidth = indentWidth(doc.line(range.start).text);
    const level = headingLevel(doc, group, range.start);

    // 標題章節只跟同級標題交換，不跨出上一層章節
    if (level) {
      if (dir < 0) {
        for (let p = range.start - 1; p > fmEnd; p--) {
          const l = headingLevel(doc, group, p);
          if (l === level) return p;
          if (l && l < level) return null;
        }
        return null;
      }
      let n = range.end + 1;
      while (n <= doc.lines && !doc.line(n).text.trim()) n++;
      if (n > doc.lines || headingLevel(doc, group, n) !== level) return null;
      return getBlockRange(doc, n).end + 1;
    }

    if (dir < 0) {
      let p = range.start - 1;
      while (p > fmEnd) {
        const t = doc.line(p).text;
        if (t.trim()) {
          if (group[p]) p = group[p][0];
          if (indentWidth(doc.line(p).text) <= ownWidth) return p;
        }
        p--;
      }
      return null;
    }

    let n = range.end + 1;
    while (n <= doc.lines && !doc.line(n).text.trim()) n++;
    if (n > doc.lines) return null;
    const nextRange = getBlockRange(doc, n);
    return nextRange ? nextRange.end + 1 : null;
  }

  openMenu(e, range) {
    const view = this.view;
    const menu = new Menu();
    const indent = () => indentOf(view.state.doc.line(range.start).text);

    menu.addItem((item) =>
      item
        .setTitle('上移')
        .setIcon('arrow-up')
        .onClick(() => {
          const gap = this.siblingGap(range, -1);
          if (gap) this.moveBlock(range, gap, indent());
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('下移')
        .setIcon('arrow-down')
        .onClick(() => {
          const gap = this.siblingGap(range, 1);
          if (gap) this.moveBlock(range, gap, indent());
        })
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle('複製一份')
        .setIcon('copy')
        .onClick(() => {
          const doc = view.state.doc;
          const endLine = doc.line(range.end);
          const text = doc.sliceString(doc.line(range.start).from, endLine.to);
          view.dispatch({
            changes: { from: endLine.to, insert: '\n' + text },
            selection: { anchor: endLine.to + 1 },
            userEvent: 'input.duplicate',
          });
          view.focus();
        })
    );
    menu.addItem((item) =>
      item
        .setTitle('刪除')
        .setIcon('trash-2')
        .onClick(() => {
          view.dispatch({ changes: this.deletionRange(range), userEvent: 'delete.block' });
          view.focus();
        })
    );
    menu.showAtMouseEvent(e);
  }
}

module.exports = class BlockDragPlugin extends Plugin {
  onload() {
    const plugin = this;
    this.registerEditorExtension(ViewPlugin.define((view) => new BlockDragView(view, plugin)));
  }
};
