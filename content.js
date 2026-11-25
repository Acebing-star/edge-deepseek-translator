/**
 * content.js —— 页面内翻译引擎
 * 职责：找出页面上"该翻译的段落" → 分批送给 background 调用 DeepSeek → 把译文写回页面。
 */
(function () {
  'use strict';

  if (window.__dskLoaded) return;
  window.__dskLoaded = true;
  if (!window.DSK) return;

  /* ================================================================ */
  /* 常量                                                              */
  /* ================================================================ */

  const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG',
    'MATH', 'CODE', 'PRE', 'KBD', 'SAMP', 'VAR', 'TEXTAREA', 'INPUT', 'SELECT',
    'OPTION', 'OPTGROUP', 'TITLE', 'META', 'LINK', 'HEAD', 'VIDEO', 'AUDIO',
    'TEMPLATE'
  ]);

  const UNSAFE_SELECTOR = '.notranslate,[translate="no"],[data-dsk-skip],.dsk-trans,.dsk-orig,.dsk-ui';
  const UNSAFE_CLASS_RE = /(^|\s)(notranslate|dsk-trans|dsk-orig|dsk-ui)(\s|$)/;

  const LEAF_DISPLAY_RE = /^(block|flow-root|list-item|table-cell|table-caption|inline-block)$/;
  const CHILD_BLOCK_RE = /^(block|flow-root|list-item|table|table-row|table-row-group|table-header-group|table-footer-group|table-cell|table-caption|flex|grid)$/;
  // 查找「最近块级祖先」用：包含 flex/grid/-webkit-box（卡片标题常被行数截断）
  const BLOCK_DISPLAY_RE = /^(block|flow-root|list-item|table|table-row|table-cell|table-caption|flex|grid|-webkit-box|inline-block)$/;

  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;
  const KANA_RE = /[\u3040-\u30ff]/g;

  /* ================================================================ */
  /* 状态                                                              */
  /* ================================================================ */

  const S = {
    settings: Object.assign({}, DSK.DEFAULTS),
    enabled: false,
    cache: new Map(),
    doneEls: new WeakSet(),
    doneTexts: new WeakSet(),
    observer: null,
    scanTimer: null,
    chain: Promise.resolve(),
    stats: { total: 0, done: 0, failed: 0 },
    // 一次翻译的细分统计：排查「明明跑完了，页面上却没变」时看这里
    diag: { replaced: 0, appended: 0, recovered: 0, sameText: 0, missing: 0, missed: 0, rescued: 0, samples: [] },
    lastError: '',
    floatHost: null,
    floatRoot: null,
    bubbleHost: null,
    started: false,
    auditRan: false,
    // 站内跳转（SPA / 点链接换页）后的自动续翻
    navUrl: location.href,
    navTimer: null, // URL 轮询
    navPending: null, // 等待页面稳定的定时器
    navCount: 0, // 已处理的跳转次数（诊断用）
    lastNavAt: 0, // 上次重扫的时间（限流用）
    revived: 0, // 因节点被复用而重翻的数量（诊断用）
    // 处理完成时的内容快照：框架复用同一批 DOM 节点换内容时，靠它识别出「已翻过但内容变了」
    elSnap: new Map(), // Element -> 完成时的 innerText
    textSnap: new Map(), // Text -> 完成时的 nodeValue
    // 诊断：开启后 collectUnits 会记录每条被跳过的文字及原因（只在 DSK_SCAN_DEBUG 时启用）
    skipLog: null,
    // 累计统计（跨多次 doRun 累加），诊断「整体翻了但没有全覆盖」时看这里
    agg: { runs: 0, units: 0, done: 0, failed: 0, replaced: 0, appended: 0, recovered: 0, sameText: 0, missing: 0, rescued: 0 },
    // 已被翻译覆盖过的文字节点（诊断覆盖率用）
    covered: new WeakSet()
  };

  const MAX_CACHE = 4000;

  /* ================================================================ */
  /* 设置                                                              */
  /* ================================================================ */

  async function loadSettings() {
    try {
      S.settings = await DSK.getSettings();
    } catch (_) {
      S.settings = Object.assign({}, DSK.DEFAULTS);
    }
    return S.settings;
  }

  /* ================================================================ */
  /* 文本筛选                                                          */
  /* ================================================================ */

  function isAlreadyTarget(text) {
    const target = S.settings.targetLang || 'zh-CN';
    const letters = text.match(/\p{L}/gu);
    if (!letters || !letters.length) return true;

    const cjk = (text.match(CJK_RE) || []).length;

    if (target === 'zh-CN' || target === 'zh-TW') {
      return cjk / letters.length > 0.6;
    }
    if (target === 'ja') {
      const kana = (text.match(KANA_RE) || []).length;
      return kana > 2 || cjk / letters.length > 0.9;
    }
    if (target === 'ko') {
      const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length;
      return hangul / letters.length > 0.8;
    }
    if (target === 'en') {
      const latin = (text.match(/[A-Za-z]/g) || []).length;
      return cjk === 0 && latin / letters.length > 0.9;
    }
    if (target === 'ru') {
      const cyr = (text.match(/[\u0400-\u04ff]/g) || []).length;
      return cyr / letters.length > 0.8;
    }
    // 其他目标语言：只要不是中文堆就算需要翻译
    return cjk / letters.length > 0.95;
  }

  function worthTranslating(raw) {
    const t = String(raw || '').replace(/\s+/g, ' ').trim();
    if (t.length < 2) return false;
    if (!/\p{L}/u.test(t)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(t)) return false;
    if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(t)) return false;
    if (isAlreadyTarget(t)) return false;
    return true;
  }

  /* ================================================================ */
  /* 元素判定                                                          */
  /* ================================================================ */

  /**
   * 交互元素：链接、按钮、可点标签。
   * 译文一旦把这些元素替换掉、或者被挪到它们外面，页面上的中文就成了
   * 「一段点不动的死文字」—— 这是翻译类扩展最常见、也最容易被投诉的副作用。
   */
  const INTERACTIVE_SEL =
    'a[href],area[href],button,label,summary,select,[role="link"],[role="button"],[onclick]';

  /** 最近的交互祖先（可能返回元素自己） */
  function closestInteractive(el) {
    if (!el || !el.closest) return null;
    try {
      const hit = el.closest(INTERACTIVE_SEL);
      return hit && !isOwnNode(hit) ? hit : null;
    } catch (_) {
      return null;
    }
  }

  /** 元素内部还有链接/按钮 —— 这种容器不能整块替换（会把它们一起藏掉） */
  function hasInteractiveDescendant(el) {
    if (!el || !el.querySelector) return false;
    try {
      return !!el.querySelector(INTERACTIVE_SEL);
    } catch (_) {
      return false;
    }
  }

  /**
   * 「正文段落里夹着链接」的容器。
   * 这类块不能整块替换（链接会变成点不动的死文字），但也不该拆成
   * 「This starter build revolves around / and scales into…」这种半句半句的碎片 ——
   * 读起来完全不成句。正确做法：整段发出去翻译，译文另起一段放在原文下面，
   * 原文不动，链接照样能点。
   */
  function isProseWithLinks(el, text) {
    if (!text || text.length < 80) return false;
    if (text.split(/\s+/).length < 12) return false;
    let links = 0;
    try {
      links = el.querySelectorAll(INTERACTIVE_SEL).length;
    } catch (_) {
      return false;
    }
    // 链接太多的多半是导航/列表，不是正文
    return links > 0 && links <= 6;
  }

  /** 译文落在链接/按钮里面时，别把它做成点击目标，让事件落到外层元素上 */
  function markInsideLink(span) {
    if (!span || !span.parentElement) return span;
    if (closestInteractive(span.parentElement)) span.classList.add('dsk-inhit');
    return span;
  }

  function hasUnsafeAncestor(el) {
    let n = el;
    while (n && n.nodeType === 1) {
      if (n.hasAttribute && n.hasAttribute('data-dsk-done')) return true;
      if (n.hasAttribute && n.hasAttribute('translate') && n.getAttribute('translate') === 'no') return true;
      const cls = n.className;
      if (typeof cls === 'string' && cls && UNSAFE_CLASS_RE.test(cls)) return true;
      n = n.parentElement;
    }
    return false;
  }

  function isLeafBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
    if (el.isContentEditable) return false;

    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (_) {
      return false;
    }
    if (cs.visibility === 'hidden') return false;
    if (!LEAF_DISPLAY_RE.test(cs.display)) return false;

    const kids = el.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (k.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
      if (SKIP_TAGS.has(k.tagName)) continue;
      let kcs;
      try {
        kcs = getComputedStyle(k);
      } catch (_) {
        continue;
      }
      if (CHILD_BLOCK_RE.test(kcs.display)) return false;
    }
    return true;
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rects = el.getClientRects();
    if (rects.length === 0) return false;
    // 尺寸为 0 的（纯装饰）跳过
    for (let i = 0; i < rects.length; i++) {
      if (rects[i].width > 0 || rects[i].height > 0) return true;
    }
    return false;
  }

  /* ================================================================ */
  /* 采集翻译单元                                                      */
  /* ================================================================ */

  function collectUnits(root) {
    const out = [];
    if (!root) return out;

    const scope = root.nodeType === 1 ? root : document.body;
    if (!scope) return out;

    if (hasUnsafeAncestor(scope) && scope !== document.body) return out;

    const log = S.skipLog;
    const note = (reason, text, el) => {
      if (!log) return;
      log.counts[reason] = (log.counts[reason] || 0) + 1;
      if (log.samples.length < 90 && text) {
        log.samples.push({
          r: reason,
          t: String(text).replace(/\s+/g, ' ').slice(0, 80),
          tag: el ? el.tagName : '',
          cls: el && typeof el.className === 'string' ? el.className.slice(0, 70) : ''
        });
      }
    };

    const candidates = [];
    if (isLeafBlock(scope)) candidates.push(scope);
    const all = scope.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (isLeafBlock(all[i])) candidates.push(all[i]);
    }

    // 真正产出了翻译单元的块（文字节点级采集时用来避免重复）
    const handledBlocks = new Set();
    // 因为内部含链接/按钮而被跳过的块：它们的文字必须交给文字节点级处理，
    // 否则这些文字就彻底没人管了（这正是「页面上很多段落没翻」的主因）
    const skippedBlocks = new Set();

    for (const el of candidates) {
      const dbgText = log ? (el.textContent || '') : '';
      if (S.doneEls.has(el)) {
        note('done', dbgText, el);
        continue;
      }
      if (el.hasAttribute('data-dsk-done')) {
        note('done', dbgText, el);
        continue;
      }
      if (hasUnsafeAncestor(el.parentElement)) {
        note('unsafe', dbgText, el);
        continue;
      }
      if (!isVisible(el)) {
        note('invisible', dbgText, el);
        continue;
      }

      // 里面有链接/按钮的容器不能整块翻译：
      // 导航条最常见 —— 外层是个 flex div，里面是几个 inline-block 的 <a>，
      // 整块替换会把链接全部塞进隐藏层，中文变成一行点不动的死文字。
      // 这类容器跳过，交给下面的文字节点级逐个处理（链接结构不动）。
      if (hasInteractiveDescendant(el)) {
        // 正文段落里夹一两个链接：整段翻，译文另起一段放在下面（链接原样保留）
        const full = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
        if (isProseWithLinks(el, full)) {
          if (full.length > 3000) {
            const parts = splitLongText(full, 3000);
            for (const p of parts) {
              if (worthTranslating(p)) out.push({ el, text: p, partial: true, prose: true });
            }
          } else if (worthTranslating(full)) {
            out.push({ el, text: full, partial: false, prose: true });
          }
          handledBlocks.add(el);
          continue;
        }
        skippedBlocks.add(el);
        note('has-interactive', dbgText, el);
        continue;
      }

      const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!worthTranslating(text)) {
        note('not-worth', text, el);
        continue;
      }

      // 超长段落切段，避免单条撑爆上下文
      if (text.length > 3000) {
        const parts = splitLongText(text, 3000);
        for (const p of parts) {
          if (worthTranslating(p)) out.push({ el, text: p, partial: true });
        }
      } else {
        out.push({ el, text, partial: false });
      }
      handledBlocks.add(el);
    }

    // ---- 补充：文字节点级采集 --------------------------------------
    // 「块级叶子」覆盖不到三类常见文案：
    //   1) 导航/列表行是 display:flex，文字只有一个内联节点（图标 + 文字）
    //   2) 卡片标题用 display:-webkit-box + line-clamp 截断显示省略号
    //   3) 块里夹着链接/按钮 —— 整块不能替换，只能逐段文字处理
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    let tn;
    while ((tn = walker.nextNode())) {
      const raw = tn.nodeValue;
      if (!raw || raw.trim().length < 2) continue;

      const p = tn.parentElement;
      if (!p) continue;
      if (p.closest(UNSAFE_SELECTOR)) continue;
      if (SKIP_TAGS.has(p.tagName)) continue;
      if (p.isContentEditable) continue;
      if (S.doneTexts.has(tn)) continue;

      const block = nearestBlock(p, scope);
      if (block && (handledBlocks.has(block) || S.doneEls.has(block))) continue;
      if (block && skippedBlocks.has(block) && p !== block) {
        // 走到这里说明容器被跳过、文字节点还能单独翻 —— 这是正常路径，不用记
      }
      if (!isVisible(p)) {
        note('tn-invisible', raw, p);
        continue;
      }

      const text = raw.replace(/\s+/g, ' ').trim();
      if (!worthTranslating(text)) continue;

      out.push({
        el: block || p,
        node: tn,
        text,
        textNode: true,
        clipAt: findClipBoundary(p),
        partial: false
      });
    }

    return out;
  }

  /** 从元素往上找最近的块级祖先（含 flex/grid/-webkit-box），限定在 scope 内 */
  function nearestBlock(el, scope) {
    let a = el;
    while (a && a.nodeType === 1) {
      let cs;
      try {
        cs = getComputedStyle(a);
      } catch (_) {
        return null;
      }
      if (BLOCK_DISPLAY_RE.test(cs.display)) return a;
      if (a === scope) return a;
      a = a.parentElement;
    }
    return null;
  }

  function splitLongText(text, size) {
    const sentences = text.match(/[^.!?。！？;；\n]+[.!?。！？;；]*/g) || [text];
    const parts = [];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > size && buf) {
        parts.push(buf);
        buf = '';
      }
      buf += s;
    }
    if (buf) parts.push(buf);
    // 极端情况：单句超长，硬切
    return parts.flatMap((p) => {
      if (p.length <= size * 1.5) return [p];
      const arr = [];
      for (let i = 0; i < p.length; i += size) arr.push(p.slice(i, i + size));
      return arr;
    });
  }

  /* ================================================================ */
  /* 写回页面                                                          */
  /* ================================================================ */

  /**
   * 短文案 + 行内/弹性布局：译文接在原文后面（"Home · 首页"），
   * 否则会把导航条撑成上下两行。
   */
  function shouldInline(el, text) {
    if (text.length > 46) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch (_) {
      return false;
    }
    if (/^inline/.test(cs.display)) return true;
    const p = el.parentElement;
    if (p) {
      try {
        if (/flex|grid/.test(getComputedStyle(p).display)) return true;
      } catch (_) {}
    }
    return false;
  }

  /** 页面级容器，裁切判定不能越过它们，否则会把译文甩到页面根节点外面 */
  const CLIP_STOP_TAGS = new Set([
    'BODY', 'HTML', 'MAIN', 'ARTICLE', 'SECTION', 'ASIDE', 'NAV',
    'HEADER', 'FOOTER', 'FORM', 'UL', 'OL', 'TABLE', 'TBODY'
  ]);

  /**
   * 元素是否真的把内容裁掉了。三种常见做法都要认：
   *   1) -webkit-line-clamp 多行截断（省略号）
   *   2) text-overflow: ellipsis + white-space: nowrap 单行截断（游戏标题最常见）
   *   3) 固定高度 + overflow: hidden
   * 因为 overflow:hidden 的容器到处都是（大多没有溢出），所以必须做溢出测量，
   * 只看样式会把普通容器误判成裁切盒子。
   */
  function isClipped(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      const cs = getComputedStyle(el);

      const lc = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp');
      if (lc && lc !== 'none' && lc !== '0') return true;
      if (/^-webkit-box$/.test(cs.display) && /hidden|clip/.test(cs.overflowY || cs.overflow)) {
        return true;
      }

      const overX = el.scrollWidth > el.clientWidth + 2;
      const overY = el.scrollHeight > el.clientHeight + 2;
      if (cs.textOverflow === 'ellipsis' && overX) return true;

      const clipsX = /hidden|clip/.test(cs.overflowX);
      const clipsY = /hidden|clip/.test(cs.overflowY);
      if ((clipsX && overX) || (clipsY && overY)) return true;
    } catch (_) {}
    return false;
  }

  /** 从元素往上找到「最外层的裁切盒子」，译文插到它后面才不会被裁掉 */
  function findClipBoundary(el) {
    if (!el || el.nodeType !== 1) return null;
    let node = el;
    for (let i = 0; i < 4 && node && node.nodeType === 1; i++) {
      if (isClipped(node)) {
        let boundary = node;
        let up = node.parentElement;
        for (let j = 0; j < 3 && up && up.nodeType === 1; j++) {
          if (CLIP_STOP_TAGS.has(up.tagName)) break;
          if (!isClipped(up)) break;
          boundary = up;
          up = up.parentElement;
        }
        return boundary;
      }
      if (CLIP_STOP_TAGS.has(node.tagName)) return null;
      node = node.parentElement;
    }
    return null;
  }

  /** 把译文放到裁切盒子的外侧（通常是卡片标题下方） */
  function insertAfterBoundary(boundary, span) {
    if (!boundary || !boundary.parentNode) return false;
    const parent = boundary.parentElement;
    if (!parent) return false;
    let pd = '';
    try {
      pd = getComputedStyle(parent).display;
    } catch (_) {}
    if (/grid/.test(pd)) span.style.setProperty('grid-column', '1 / -1', 'important');
    try {
      boundary.insertAdjacentElement('afterend', span);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** 解除裁切，保证塞进去的译文能显示出来 */
  function relaxClip(el) {
    if (!el) return;
    try {
      el.style.setProperty('-webkit-line-clamp', 'unset', 'important');
      el.style.setProperty('line-clamp', 'unset', 'important');
      el.style.setProperty('overflow', 'visible', 'important');
      el.style.setProperty('max-height', 'none', 'important');
      el.style.setProperty('text-overflow', 'clip', 'important');
      el.style.setProperty('white-space', 'normal', 'important');
    } catch (_) {}
  }

  /**
   * 短文案（导航、按钮、标签、作品名）要不要用译文顶替原文。
   * 双语对照在正文里很有用，但侧栏导航挂一遍俄语再挂一遍中文会很乱，
   * 卡片标题被省略号截断后原文也看不全，所以短文案统一替换，原文留在 title 里可悬停查看。
   */
  /** 是不是「界面元素」：链接、按钮、标签，或 flex/grid 行里的文字。
   *  正文里的短句、列表项不算，那些保持双语对照。 */
  function isUiLike(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      if (el.closest('a,button,label,summary,option,select,legend')) return true;
    } catch (_) {}
    // 只看直接父级：再往上找就会把「放在 flex 布局大容器里的正文段落」也算成界面元素
    const p = el.parentElement;
    if (p) {
      let d = '';
      try {
        d = getComputedStyle(p).display;
      } catch (_) {}
      if (/flex|grid|inline/.test(d)) return true;
    }
    return false;
  }

  /**
   * 追加进去的译文会不会根本看不见。
   * 典型场景：轮播卡片有固定高度 + overflow:hidden，标题下面再塞一行中文
   * 就被裁在盒子外面了 —— 代码以为写成功了，用户看到的还是原文。
   */
  function isEffectivelyVisible(el) {
    if (!el || !el.isConnected) return false;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      return true;
    }
    if (r.width <= 0.5 && r.height <= 0.5) return false;

    let a = el.parentElement;
    for (let i = 0; i < 14 && a; i++, a = a.parentElement) {
      if (a === document.body || a === document.documentElement) break;
      let cs;
      try {
        cs = getComputedStyle(a);
      } catch (_) {
        break;
      }
      const cutX = /hidden|clip/.test(cs.overflowX);
      const cutY = /hidden|clip/.test(cs.overflowY);
      if (!cutX && !cutY) continue;
      const ar = a.getBoundingClientRect();
      if (ar.width <= 0 || ar.height <= 0) continue;
      if (cutY && (r.bottom > ar.bottom + 2 || r.top < ar.top - 2)) return false;
      if (cutX && (r.right > ar.right + 2 || r.left < ar.left - 2)) return false;
    }
    return true;
  }

  /** 短文案顶替：文字节点版本（原文收进隐藏层） */
  function replaceNodeText(node, text) {
    const wrap = document.createElement('span');
    wrap.className = 'dsk-orig';
    wrap.setAttribute('aria-hidden', 'true');
    node.parentNode.insertBefore(wrap, node);
    wrap.appendChild(node);

    const span = document.createElement('span');
    span.className = 'dsk-trans dsk-replaced';
    span.setAttribute('dir', 'auto');
    span.textContent = text;
    wrap.insertAdjacentElement('afterend', span);
    return markInsideLink(span);
  }

  /** 短文案顶替：整元素版本 */
  function replaceElementText(el, text, orig) {
    const wrap = document.createElement('span');
    wrap.className = 'dsk-orig';
    wrap.setAttribute('aria-hidden', 'true');
    while (el.firstChild) wrap.appendChild(el.firstChild);
    el.appendChild(wrap);

    const span = document.createElement('span');
    span.className = 'dsk-trans dsk-replaced';
    span.setAttribute('dir', 'auto');
    span.textContent = text;
    el.appendChild(span);
    if (orig && !el.getAttribute('title')) {
      el.setAttribute('title', orig);
      el.setAttribute('data-dsk-title', '1'); // 还原时清掉，别把 hover 提示留在页面上
    }
    relaxClip(el);
    return markInsideLink(span);
  }

  /**
   * 元素是否处在「一旦变长就会被截」的盒子里。
   * 和 isClipped 的区别：这里不要求当前已经溢出 —— 中文通常比原文长，
   * 追加进去才被裁是最常见的坑，所以宁可提前按截断处理。
   */
  function inTruncatingBox(el) {
    let n = el;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++, n = n.parentElement) {
      let cs;
      try {
        cs = getComputedStyle(n);
      } catch (_) {
        return false;
      }
      const lc = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp');
      if (lc && lc !== 'none' && lc !== '0') return true;

      const cutX = /hidden|clip/.test(cs.overflowX);
      const cutY = /hidden|clip/.test(cs.overflowY);
      if (cutX && /nowrap|pre$/.test(cs.whiteSpace)) return true;
      if ((cutX || cutY) && cs.textOverflow === 'ellipsis') return true;

      if (CLIP_STOP_TAGS.has(n.tagName)) break;
    }
    return false;
  }

  /** 把外层「会截断」的祖宗也解开，否则译文换行后照样被切 */
  function relaxTruncatingAncestors(el) {
    let n = el && el.parentElement;
    for (let i = 0; i < 4 && n && n.nodeType === 1; i++, n = n.parentElement) {
      if (CLIP_STOP_TAGS.has(n.tagName)) break;
      let cs;
      try {
        cs = getComputedStyle(n);
      } catch (_) {
        break;
      }
      const lc = cs.webkitLineClamp || cs.getPropertyValue('-webkit-line-clamp');
      const cut = /hidden|clip/.test(cs.overflowX) || /hidden|clip/.test(cs.overflowY);
      const isCut =
        (lc && lc !== 'none' && lc !== '0') ||
        (cut && /nowrap|pre$/.test(cs.whiteSpace)) ||
        (cut && cs.textOverflow === 'ellipsis');
      if (!isCut) break;
      relaxClip(n);
    }
  }

  function shouldReplaceInline(unit, text, clipAt) {
    if (S.settings.mode === 'replace') return true;
    if (!S.settings.shortTextReplace) return false;
    const orig = String(unit.text || '').trim();
    if (!orig || orig.length > 60) return false;
    if (text.length > 100) return false;
    if (isUiLike(unit.el)) return true;
    // 被裁切的短文本（卡片标题、列表项）：追加进去会被省略号或固定高度容器吞掉，
    // 用户看到的就是「怎么还是原文」，所以直接顶替
    if (clipAt) return true;
    if (inTruncatingBox(unit.el)) return true;
    return false;
  }

  /**
   * 标题常写成 <h3><a>文字</a></h3>。替换 <h3> 会把 <a> 一起塞进隐藏层，
   * 标题就点不动了；这种情况把处理下移到 <a> 上，只换文字、保留链接。
   */
  function soleInlineChild(el) {
    const kids = [];
    for (const k of el.children) {
      if (isOwnNode(k)) continue;
      kids.push(k);
      if (kids.length > 1) return null;
    }
    if (kids.length !== 1) return null;
    const k = kids[0];
    if (k.tagName !== 'A' && k.tagName !== 'SPAN') return null;
    let cs;
    try {
      cs = getComputedStyle(k);
    } catch (_) {
      return null;
    }
    if (/^(block|flex|grid)$/.test(cs.display)) return null;
    const a = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const b = (k.innerText || '').replace(/\s+/g, ' ').trim();
    return a && a === b ? k : null;
  }

  /** 把 el 里所有文字节点记为「已覆盖」，仅用于诊断覆盖率 */
  function markCovered(el) {
    if (!el) return;
    if (el.nodeType === 3) {
      S.covered.add(el);
      return;
    }
    if (!el.nodeType || !el.querySelectorAll) return;
    try {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
      let t;
      while ((t = w.nextNode())) S.covered.add(t);
    } catch (_) {}
  }

  function applyTranslation(unit, translated) {
    if (!unit) return;
    applyTranslationCore(unit, translated);
    // 无论走哪条分支，这条文字都算「处理过」了 —— 事后统计覆盖率靠它
    if (unit.textNode && unit.node) S.covered.add(unit.node);
    else if (unit.el) markCovered(unit.el);
  }

  function applyTranslationCore(unit, translated) {
    let el = unit.el;
    if (!translated) return;

    const text = String(translated).replace(/\s+/g, ' ').trim();
    if (!text) return;

    const orig = String(unit.text || '').replace(/\s+/g, ' ').trim();
    // 译文和原文一样（品牌名、模型原样返回）时不要重复插入，否则会出现「Steam Steam」
    if (orig && text.toLowerCase() === orig.toLowerCase()) {
      S.diag.sameText++;
      if (S.diag.samples.length < 12) S.diag.samples.push(orig.slice(0, 40));
      if (unit.textNode && unit.node) {
        S.doneTexts.add(unit.node);
        S.textSnap.set(unit.node, normSpace(unit.node.nodeValue));
      } else if (el) {
        S.doneEls.add(el);
        el.setAttribute('data-dsk-done', '1');
        S.elSnap.set(el, elSignature(el));
      }
      return;
    }

    // ---- 文字节点级：译文插到该文字节点后面（被截断的放到元素外侧） ----
    if (unit.textNode) {
      const node = unit.node;
      if (!node || !node.isConnected || !node.parentNode) return;

      // 文字在链接/按钮里时，译文必须留在同一个交互元素内部：
      // 一旦被挪到链接外面，链接就成了空壳，页面上中文点不动。
      const holder = closestInteractive(node.parentElement);
      let clipAt = unit.clipAt || null;
      if (clipAt && holder && !holder.contains(clipAt)) clipAt = null;

      // 链接/按钮里的短文案一律用译文顶替：
      // 追加「·译文」会让链接文字变长、还容易挤出按钮外，顶替最稳。
      const inLink = !!holder && String(unit.text || '').trim().length <= 60 && text.length <= 120;

      if (inLink || shouldReplaceInline(unit, text, clipAt)) {
        // 短文案：原文节点收进隐藏层（还原时再放出来），页面上只留译文
        replaceNodeText(node, text);
        if (clipAt) relaxClip(clipAt);
        relaxTruncatingAncestors(node.parentElement);
        S.diag.replaced++;
        S.doneTexts.add(node);
        S.textSnap.set(node, normSpace(node.nodeValue));
        return;
      }

      const tspan = document.createElement('span');
      tspan.setAttribute('dir', 'auto');
      tspan.textContent = text;

      if (clipAt) {
        // 被截断的元素：塞进去会被省略号裁掉，放到裁切盒子外侧
        tspan.className = 'dsk-trans dsk-after';
        if (!insertAfterBoundary(clipAt, tspan)) {
          relaxClip(clipAt);
          tspan.className = 'dsk-trans';
          node.parentNode.insertBefore(tspan, node.nextSibling);
        }
      } else {
        tspan.className = 'dsk-trans dsk-inline';
        node.parentNode.insertBefore(tspan, node.nextSibling);
      }
      markInsideLink(tspan);

      // 追加的译文被祖先容器裁掉了（固定高度的轮播卡片等）：改成顶替，别让它白写
      if (!isEffectivelyVisible(tspan)) {
        tspan.remove();
        replaceNodeText(node, text);
        if (clipAt) relaxClip(clipAt);
        relaxTruncatingAncestors(node.parentElement);
        S.diag.recovered++;
      } else {
        S.diag.appended++;
      }
      S.doneTexts.add(node);
      S.textSnap.set(node, normSpace(node.nodeValue));
      return;
    }

    if (!el || !el.isConnected) return;

    // ---- 正文段落（内部有链接）：整段译文另起一段放在下面，原文和链接都不动 ----
    if (unit.prose) {
      const prev = el.querySelector(':scope > .dsk-trans.dsk-prose');
      if (prev) {
        if (unit.partial) prev.textContent += ' ' + text;
        return;
      }
      const pspan = document.createElement('span');
      pspan.setAttribute('dir', 'auto');
      pspan.textContent = text;
      pspan.className = 'dsk-trans dsk-prose';
      el.appendChild(pspan);
      if (!isEffectivelyVisible(pspan)) {
        // 容器本身是固定高度/裁切的，塞进去看不见 —— 挪到容器外侧
        pspan.remove();
        pspan.className = 'dsk-trans dsk-after';
        if (el.parentElement) el.parentElement.insertBefore(pspan, el.nextSibling);
      }
      S.diag.appended++;
      S.doneEls.add(el);
      el.setAttribute('data-dsk-done', '1');
      S.elSnap.set(el, elSignature(el));
      return;
    }

    const inner = soleInlineChild(el);
    if (inner) {
      if (S.doneEls.has(inner)) return;
      el = inner;
    }

    // 兜底：这个元素里还有链接/按钮（老版本采集残留、动态插入的卡片组等），
    // 整块替换会把它们一起藏进隐藏层。改成把里面的文字节点逐个补翻。
    if (hasInteractiveDescendant(el)) {
      const subs = collectUnits(el).filter((u) => u.textNode && u.text);
      if (subs.length) runUnits(subs, { silent: true });
      return;
    }

    // 分段翻译的：拼接到已存在的译文后面
    if (unit.partial) {
      const existing = el.querySelector(':scope > .dsk-trans');
      if (existing) {
        existing.textContent += ' ' + text;
        return;
      }
    } else if (el.querySelector(':scope > .dsk-trans')) {
      return;
    }

    // 元素本身在链接/按钮里时，译文同样不能跑到它外面
    const holder = closestInteractive(el);
    let clipAt = findClipBoundary(el);
    if (clipAt && holder && !holder.contains(clipAt)) clipAt = null;

    // 短文案：译文顶替原文（原文进隐藏层，悬停可看）
    if (shouldReplaceInline(unit, text, clipAt)) {
      replaceElementText(el, text, orig);
      // 原文已隐藏，剩下的译文如果还被裁切就会看不见，这里一定要解开
      if (clipAt && clipAt !== el) relaxClip(clipAt);
      relaxTruncatingAncestors(el);
      S.diag.replaced++;
    } else if (clipAt) {
      // 被截断的长块（摘要、正文）：塞进去会被裁掉，放外面另起一行
      const span = document.createElement('span');
      span.setAttribute('dir', 'auto');
      span.textContent = text;
      span.className = 'dsk-trans dsk-after';
      if (!insertAfterBoundary(clipAt, span)) {
        relaxClip(clipAt);
        span.className = 'dsk-trans' + (shouldInline(el, text) ? ' dsk-inline' : '');
        el.appendChild(span);
      }
      markInsideLink(span);
      if (!isEffectivelyVisible(span)) {
        span.remove();
        replaceElementText(el, text, orig);
        if (clipAt !== el) relaxClip(clipAt);
        relaxTruncatingAncestors(el);
        S.diag.recovered++;
      } else {
        S.diag.appended++;
      }
    } else {
      const span = document.createElement('span');
      span.setAttribute('dir', 'auto');
      span.textContent = text;
      span.className = 'dsk-trans' + (shouldInline(el, text) ? ' dsk-inline' : '');
      el.appendChild(span);
      markInsideLink(span);
      if (!isEffectivelyVisible(span)) {
        span.remove();
        replaceElementText(el, text, orig);
        relaxTruncatingAncestors(el);
        S.diag.recovered++;
      } else {
        S.diag.appended++;
      }
    }

    S.doneEls.add(el);
    el.setAttribute('data-dsk-done', '1');
    S.elSnap.set(el, elSignature(el));
  }

  function restorePage() {
    const trans = document.querySelectorAll('.dsk-trans');
    for (const n of trans) n.remove();

    const origs = document.querySelectorAll('.dsk-orig');
    for (const wrap of origs) {
      const p = wrap.parentElement;
      if (!p) continue;
      while (wrap.firstChild) p.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    }

    const marked = document.querySelectorAll('[data-dsk-done]');
    for (const n of marked) n.removeAttribute('data-dsk-done');

    const titled = document.querySelectorAll('[data-dsk-title]');
    for (const n of titled) {
      n.removeAttribute('title');
      n.removeAttribute('data-dsk-title');
    }

    S.doneEls = new WeakSet();
    S.doneTexts = new WeakSet();
    S.elSnap.clear();
    S.textSnap.clear();
    document.documentElement.classList.remove('dsk-on');
  }

  /* ================================================================ */
  /* 分批 + 调度                                                       */
  /* ================================================================ */

  function makeBatches(units) {
    const maxChars = Math.max(600, Number(S.settings.chunkChars) || 2400);
    const maxItems = Math.max(5, Number(S.settings.chunkItems) || 30);

    const out = [];
    let cur = [];
    let curLen = 0;

    for (const u of units) {
      const len = u.text.length;
      if (cur.length && (curLen + len > maxChars || cur.length >= maxItems)) {
        out.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(u);
      curLen += len;
    }
    if (cur.length) out.push(cur);
    return out;
  }

  function runUnits(units, opts) {
    const options = opts || {};
    S.chain = S.chain
      .then(() => doRun(units, options))
      .catch((e) => {
        S.lastError = String((e && e.message) || e);
        // 出错必须让用户看见，不能静默停在「翻译中 0/N」
        updateFloat('error');
        toast('翻译中断：' + S.lastError, 'error', 8000);
      });
    return S.chain;
  }

  async function doRun(units, options) {
    if (!S.enabled || !units || !units.length) return;

    S.stats = { total: units.length, done: 0, failed: 0 };
    S.diag = { replaced: 0, appended: 0, recovered: 0, sameText: 0, missing: 0, missed: 0, rescued: 0, samples: [] };
    updateFloat('working');

    const todo = [];
    for (const u of units) {
      if (S.cache.has(u.text)) {
        applyTranslation(u, S.cache.get(u.text));
        S.stats.done++;
      } else {
        todo.push(u);
      }
    }

    const batches = makeBatches(todo);
    if (!batches.length) {
      finishRun(options);
      return;
    }

    const conc = Math.min(4, Math.max(1, Number(S.settings.concurrency) || 2));
    let cursor = 0;

    const worker = async () => {
      while (cursor < batches.length) {
        if (!S.enabled) return;
        const idx = cursor++;
        try {
          await runBatch(batches[idx]);
        } catch (e) {
          // 单批异常不能让整个任务卡死
          S.stats.failed += batches[idx].length;
          S.lastError = String((e && e.message) || e);
        }
        updateFloat('working');
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(conc, batches.length) }, () => worker())
    );

    finishRun(options);
  }

  /**
   * 兜底修复：如果链接/按钮被藏进了隐藏层（整块替换的副作用），把它放回来。
   * 修过就让补翻再跑一轮，把这些元素里的文字按「文字节点」重新翻一遍。
   */
  function rescueInteractive() {
    let fixed = 0;
    for (const wrap of document.querySelectorAll('.dsk-orig')) {
      if (!wrap.querySelector(INTERACTIVE_SEL)) continue;
      const p = wrap.parentElement;
      if (!p || !p.isConnected) continue;

      // 同一次「顶替」产生的译文紧跟在隐藏层后面，先删掉，免得还原后中英重复
      for (const t of p.querySelectorAll(':scope > .dsk-trans')) {
        if (t.classList.contains('dsk-replaced')) t.remove();
      }
      while (wrap.firstChild) p.insertBefore(wrap.firstChild, wrap);
      wrap.remove();

      p.removeAttribute('data-dsk-done');
      if (p.getAttribute('data-dsk-title')) {
        p.removeAttribute('title');
        p.removeAttribute('data-dsk-title');
      }
      S.doneEls.delete(p);
      S.auditRan = false;
      fixed++;
    }
    if (fixed) {
      S.diag.rescued += fixed;
      try {
        console.info('[DeepSeek 翻译] 修复了 %d 处被翻译藏起来的链接/按钮', fixed);
      } catch (_) {}
    }
    return fixed;
  }

  function finishRun(options) {
    if (!S.enabled) {
      sendBadge('');
      return;
    }
    // 快照表只对「还在页面上」的节点有意义，顺手清掉已被移除的，避免越攒越大
    for (const el of S.elSnap.keys()) {
      if (!el.isConnected) S.elSnap.delete(el);
    }
    for (const n of S.textSnap.keys()) {
      if (!n.isConnected) S.textSnap.delete(n);
    }
    dumpDiag();

    // 累计统计：doRun 每次都会重置 S.diag，跨轮的总量只有这里能看全
    S.agg.runs++;
    S.agg.units += S.stats.total || 0;
    S.agg.done += S.stats.done || 0;
    S.agg.failed += S.stats.failed || 0;
    for (const k of ['replaced', 'appended', 'recovered', 'sameText', 'missing', 'rescued']) {
      S.agg[k] = (S.agg[k] || 0) + (S.diag[k] || 0);
    }

    updateFloat(S.stats.failed && !S.stats.done ? 'error' : 'done');
    sendBadge('译');

    // 兜底：先把被藏起来的链接/按钮放回来，再决定要不要补翻
    const rescued = rescueInteractive();

    // 首轮跑完自查一次，把漏掉的文字补翻（只做一轮）
    if (!S.auditRan || rescued) {
      S.chain = S.chain.then(() => auditPass());
    }

    if (options && options.silent) return;
    if (S.stats.failed) {
      toast('翻译完成 ' + S.stats.done + ' 段，' + S.stats.failed + ' 段失败。' + (S.lastError || ''), 'error', 6000);
    } else if (S.stats.done) {
      let extra = '';
      if (S.diag.sameText) extra = '，其中 ' + S.diag.sameText + ' 段模型判断无需翻译';
      toast('已翻译 ' + S.stats.done + ' 段' + extra, 'ok', 2600);
    }
  }

  /** 控制台打一份细分统计，方便排查「跑完了但页面上没变化」 */
  function dumpDiag() {
    try {
      console.info(
        '[DeepSeek 翻译] 替换 %d / 追加 %d / 裁切回退 %d / 原样返回 %d / 缺失 %d / 补翻 %d / 救回链接 %d',
        S.diag.replaced, S.diag.appended, S.diag.recovered,
        S.diag.sameText, S.diag.missing, S.diag.missed, S.diag.rescued
      );
      if (S.diag.samples.length) {
        console.info('[DeepSeek 翻译] 模型原样返回的条目：', S.diag.samples);
      }
    } catch (_) {}
  }

  /**
   * 补翻：首轮采集难免有盲区（布局怪异的卡片标题、后渲染的列表……），
   * 这里直接按「还没被处理的文字节点」重扫一遍，把漏掉的捡回来再翻一次。
   * 只跑一轮，避免和 MutationObserver 互相触发。
   */
  function collectMissed() {
    const out = [];
    if (!document.body) return out;

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
    let tn;
    let guard = 0;
    while ((tn = walker.nextNode())) {
      if (++guard > 60000) break;
      if (out.length >= 150) break;

      const raw = tn.nodeValue;
      if (!raw || raw.trim().length < 2) continue;

      const p = tn.parentElement;
      if (!p) continue;
      if (S.doneTexts.has(tn)) continue;
      if (p.closest(UNSAFE_SELECTOR)) continue;
      if (p.closest('[data-dsk-done]')) continue;
      if (SKIP_TAGS.has(p.tagName)) continue;
      if (p.isContentEditable) continue;
      if (!isVisible(p)) continue;

      const text = raw.replace(/\s+/g, ' ').trim();
      if (!worthTranslating(text)) continue;

      const block = nearestBlock(p, document.body) || p;
      out.push({
        el: block,
        node: tn,
        text,
        textNode: true,
        clipAt: findClipBoundary(p),
        partial: false
      });
    }
    return out;
  }

  async function auditPass() {
    if (S.auditRan || !S.enabled) return;
    S.auditRan = true;

    const units = collectMissed();
    if (!units.length) return;

    S.diag.missed = units.length;
    try {
      console.info('[DeepSeek 翻译] 首轮遗漏 %d 处，正在补翻…', units.length);
    } catch (_) {}
    await doRun(units, { silent: true });
    S.diag.missed = units.length;
  }

  async function runBatch(batch) {
    const items = batch.map((u, i) => ({ i, t: u.text }));
    let resp;
    try {
      // 看门狗：后台若被浏览器回收（MV3 可能休眠），消息 Promise 会永远不返回，
      // 这里主动超时，避免页面一直卡在 0/N。
      resp = await Promise.race([
        chrome.runtime.sendMessage({
          type: 'DSK_TRANSLATE',
          items,
          settings: S.settings
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('__TIMEOUT__')), 100000)
        )
      ]);
    } catch (e) {
      const timeout = e && e.message === '__TIMEOUT__';
      resp = {
        ok: false,
        error: timeout
          ? '后台 100 秒没有响应（浏览器可能休眠了扩展），请再点一次悬浮球重试。'
          : '与扩展后台通信失败：' + String((e && e.message) || e)
      };
    }

    if (!resp || !resp.ok) {
      S.stats.failed += batch.length;
      S.lastError = (resp && resp.error) || '未知错误';
      return;
    }

    const map = new Map();
    for (const it of resp.items || []) map.set(Number(it.i), it.t);

    batch.forEach((u, i) => {
      const tr = map.get(i);
      if (tr == null || !String(tr).trim()) {
        S.stats.failed++;
        S.diag.missing++;
        return;
      }
      const clean = String(tr).trim();
      if (S.cache.size > MAX_CACHE) S.cache.clear();
      S.cache.set(u.text, clean);
      // 单条写入失败不应让整批中断，否则进度会永远停在 0
      try {
        applyTranslation(u, clean);
        S.stats.done++;
      } catch (err) {
        S.stats.failed++;
        S.lastError = '写入译文失败：' + String((err && err.message) || err);
      }
    });
  }

  /* ================================================================ */
  /* 动态内容监听                                                      */
  /* ================================================================ */

  let pendingRoots = new Set();

  function startObserver() {
    if (S.observer) return;
    S.observer = new MutationObserver((muts) => {
      if (!S.enabled) return;
      let touched = false;
      for (const m of muts) {
        if (m.type === 'characterData') {
          const p = m.target.parentElement;
          if (p && !isOwnNode(p) && !p.closest(UNSAFE_SELECTOR)) {
            pendingRoots.add(p);
            touched = true;
          }
          continue;
        }
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (isOwnNode(n)) continue;
            pendingRoots.add(n);
            touched = true;
          } else if (n.nodeType === 3) {
            const p = n.parentElement;
            if (p && !isOwnNode(p)) {
              pendingRoots.add(p);
              touched = true;
            }
          }
        }
      }
      if (touched) scheduleScan();
    });

    S.observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  function isOwnNode(n) {
    if (!n || n.nodeType !== 1 || !n.classList) return false;
    return (
      n.classList.contains('dsk-trans') ||
      n.classList.contains('dsk-orig') ||
      n.classList.contains('dsk-ui') ||
      n.id === 'dsk-float-host' ||
      n.id === 'dsk-bubble-host'
    );
  }

  function scheduleScan() {
    clearTimeout(S.scanTimer);
    S.scanTimer = setTimeout(async () => {
      if (!S.enabled) return;
      const roots = Array.from(pendingRoots).filter((r) => r && r.isConnected);
      pendingRoots = new Set();
      const units = [];
      const seenEls = new Set();
      for (const root of roots) {
        if (root.nodeType !== 1) continue;
        if (root.closest(UNSAFE_SELECTOR)) continue;
        for (const u of collectUnits(root)) {
          if (seenEls.has(u.el) && !u.partial) continue;
          seenEls.add(u.el);
          units.push(u);
        }
      }
      if (units.length) runUnits(units, { silent: true });
    }, 700);
  }

  /* ================================================================ */
  /* 站内跳转自动续翻                                                  */
  /* ================================================================ */

  /**
   * 告诉后台「这个标签页当前是否开着翻译」。
   * 同标签页跳到新文档时 content script 会重新注入，内存状态全丢，
   * 新页面就是靠这条记录自动接着翻的。
   */
  function notifyTabAuto(on) {
    try {
      chrome.runtime.sendMessage(
        { type: 'DSK_TAB_AUTO_SET', on: !!on, host: location.host },
        () => void chrome.runtime.lastError
      );
    } catch (_) {}
  }

  /** 问后台：本标签页上一次是不是开着翻译 */
  function askTabAuto() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'DSK_TAB_AUTO_GET' }, (r) => {
          void chrome.runtime.lastError;
          resolve(r && r.ok ? r : { on: false, host: '' });
        });
      } catch (_) {
        resolve({ on: false, host: '' });
      }
    });
  }

  /**
   * 监视页面内跳转。
   * 不用改写 history.pushState：content script 跑在隔离环境里，
   * 页面主世界调用的是它自己那份 History 引用，改了也拦不到。
   * 轮询 location.href 最土但最可靠，成本只是一次字符串比较。
   */
  function watchNavigation() {
    if (S.navTimer) return;
    S.navUrl = location.href;
    S.navTimer = setInterval(checkNav, 600);
    window.addEventListener('popstate', checkNav, true);
    window.addEventListener('hashchange', checkNav, true);
  }

  function unwatchNavigation() {
    if (S.navTimer) {
      clearInterval(S.navTimer);
      S.navTimer = null;
    }
    clearTimeout(S.navPending);
    S.navPending = null;
    window.removeEventListener('popstate', checkNav, true);
    window.removeEventListener('hashchange', checkNav, true);
  }

  function checkNav() {
    if (location.href === S.navUrl) return;
    S.navUrl = location.href;
    // 页面没开翻译就只记录地址，不做事
    if (!S.enabled) return;
    scheduleNavRescan();
  }

  function scheduleNavRescan() {
    clearTimeout(S.navPending);
    // 新页面/新路由的内容往往是异步渲染的，等到不再变化再扫，避免扫到空壳。
    // 同时限制最小间隔：有些站点一滚动就 replaceState 改 hash，
    // 不设下限会变成反复全页扫描。
    const wait = Math.max(900, (S.lastNavAt || 0) + 2500 - Date.now());
    S.navPending = setTimeout(runNavRescan, wait);
  }

  async function runNavRescan() {
    S.navPending = null;
    S.lastNavAt = Date.now();
    if (!S.enabled) return;

    // 框架切换路由时常复用同一批 DOM 节点、只改文字内容，
    // 这些节点还带着「已翻过」的标记，会被直接跳过 → 新内容永远不翻。
    // 先把内容变过的标记清掉，再重新采集。
    const revived = pruneStaleMarks();
    S.navCount++;

    try {
      console.info(
        '[DeepSeek 翻译] 检测到页面跳转（第 %d 次）→ %s；复用节点重翻 %d 处',
        S.navCount, location.pathname + location.search, revived
      );
    } catch (_) {}

    S.auditRan = false;
    updateFloat('working');

    const units = collectUnits(document.body || document.documentElement);
    if (!units.length) {
      updateFloat('done');
      sendBadge('译');
      return;
    }
    runUnits(units, { silent: true });
  }

  /** 清掉「翻过但内容已被框架换掉」的标记，返回清掉的数量 */
  function pruneStaleMarks() {
    let revived = 0;

    for (const [el, snap] of S.elSnap) {
      if (!el.isConnected) {
        S.elSnap.delete(el);
        continue;
      }
      const now = elSignature(el);
      if (now === snap) continue;
      S.doneEls.delete(el);
      el.removeAttribute('data-dsk-done');
      S.elSnap.delete(el);
      revived++;
    }

    for (const [node, snap] of S.textSnap) {
      if (!node.isConnected) {
        S.textSnap.delete(node);
        continue;
      }
      const now = normSpace(node.nodeValue);
      if (now === snap) continue;
      reviveTextNode(node);
      revived++;
    }

    S.revived += revived;
    return revived;
  }

  /** 之前用「顶替」模式处理过的文字节点：把原文放回原位、删掉旧译文 */
  function reviveTextNode(node) {
    const wrap = node.parentElement;
    if (wrap && wrap.classList && wrap.classList.contains('dsk-orig')) {
      const p = wrap.parentElement;
      const span = wrap.nextElementSibling;
      if (span && span.classList.contains('dsk-trans') && span.classList.contains('dsk-replaced')) {
        span.remove();
      }
      if (p) {
        p.insertBefore(node, wrap);
        if (!wrap.firstChild) wrap.remove();
      }
    }
    S.doneTexts.delete(node);
    S.textSnap.delete(node);
  }

  function normSpace(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  /**
   * 元素内容指纹，用来判断「翻过之后内容有没有被换掉」。
   * 特意用 textContent 而不是 innerText：后者为了算可见文本会强制同步布局，
   * 每翻一段就 reflow 一次，长页面会明显变卡。
   */
  function elSignature(el) {
    return normSpace(el.textContent);
  }

  /* ================================================================ */
  /* 启动 / 停止                                                       */
  /* ================================================================ */

  async function start(opts) {
    const options = opts || {};
    await loadSettings();

    if (!S.settings.apiKey) {
      toast('还没有填写 DeepSeek API Key，点扩展图标 → 设置。', 'error', 6000);
      updateFloat('error');
      return false;
    }

    S.enabled = true;
    S.auditRan = false;
    S.lastNavAt = 0;
    S.diag = { replaced: 0, appended: 0, recovered: 0, sameText: 0, missing: 0, missed: 0, rescued: 0, samples: [] };
    S.agg = { runs: 0, units: 0, done: 0, failed: 0, replaced: 0, appended: 0, recovered: 0, sameText: 0, missing: 0, rescued: 0 };
    S.covered = new WeakSet();
    document.documentElement.classList.add('dsk-on');
    mountFloat();
    updateFloat('working');
    startObserver();
    watchNavigation();
    sendBadge('…');
    // 记一笔：这个标签页开着翻译。跳到新页面后据此自动续翻。
    notifyTabAuto(true);

    const units = collectUnits(document.body || document.documentElement);
    if (!units.length) {
      updateFloat('done');
      if (!options.resume) toast('这个页面没有找到可翻译的文本', 'warn', 3000);
      return true;
    }
    runUnits(units, { silent: !!options.resume });
    return true;
  }

  function stop(keepAuto) {
    S.enabled = false;
    if (S.observer) {
      S.observer.disconnect();
      S.observer = null;
    }
    unwatchNavigation();
    clearTimeout(S.scanTimer);
    pendingRoots = new Set();
    S.stats = { total: 0, done: 0, failed: 0 };
    restorePage();
    updateFloat('idle');
    sendBadge('');
    // 用户主动关掉了：后续跳转不要再自动翻。
    // 改设置触发的「先停后起」不算，保留标记（否则可能把刚写进去的状态冲掉）。
    if (!keepAuto) notifyTabAuto(false);
  }

  async function toggle() {
    if (S.enabled) {
      stop();
      return { ok: true, enabled: false };
    }
    const ok = await start();
    return { ok, enabled: S.enabled };
  }

  function getStatus() {
    return {
      enabled: S.enabled,
      stats: S.stats,
      error: S.lastError,
      settings: {
        targetLang: S.settings.targetLang,
        mode: S.settings.mode,
        model: S.settings.model,
        hasKey: !!S.settings.apiKey
      }
    };
  }

  /* ================================================================ */
  /* Badge                                                             */
  /* ================================================================ */

  function sendBadge(text) {
    try {
      chrome.runtime.sendMessage({ type: 'DSK_BADGE', text }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  /* ================================================================ */
  /* 悬浮球 UI                                                         */
  /* ================================================================ */

  const FLOAT_STYLE = `
    :host { all: initial; }
    .fab {
      width: 46px; height: 46px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: rgba(24,26,36,.86);
      backdrop-filter: blur(12px);
      border: 1px solid rgba(120,140,255,.35);
      box-shadow: 0 6px 20px rgba(0,0,0,.35);
      color: #c7d2fe; font: 600 15px/1 -apple-system,"Segoe UI",system-ui,sans-serif;
      cursor: pointer; user-select: none;
      transition: transform .15s ease, background .2s ease, border-color .2s ease;
      position: relative;
    }
    .fab:hover { transform: scale(1.06); background: rgba(40,44,66,.94); }
    .fab[data-state="working"] { border-color: #6366f1; color: #a5b4fc; }
    .fab[data-state="working"]::after {
      content: ""; position: absolute; inset: -3px; border-radius: 50%;
      border: 2px solid transparent; border-top-color: #6366f1;
      animation: dsk-spin .9s linear infinite;
    }
    .fab[data-state="done"] { background: rgba(79,70,229,.92); color:#fff; border-color:#818cf8; }
    .fab[data-state="error"] { background: rgba(153,27,27,.92); color:#fff; border-color:#f87171; }
    @keyframes dsk-spin { to { transform: rotate(360deg); } }
  `;

  function mountFloat() {
    if (S.floatHost) return;
    if (S.settings.showFloatButton === false) return;
    if (document.getElementById('dsk-float-host')) return;

    const host = document.createElement('div');
    host.id = 'dsk-float-host';
    host.className = 'dsk-ui';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483646';
    host.style.right = '22px';
    host.style.bottom = '110px';
    host.style.width = '46px';
    host.style.height = '46px';
    host.style.lineHeight = '0';

    if (S.savedPos && typeof S.savedPos.left === 'number') {
      host.style.left = S.savedPos.left + 'px';
      host.style.top = S.savedPos.top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }

    document.documentElement.appendChild(host);

    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + FLOAT_STYLE + '</style><div class="fab" part="fab" role="button" tabindex="0" title="DeepSeek 翻译 / 还原本页">译</div>';

    const fab = root.querySelector('.fab');
    S.floatHost = host;
    S.floatRoot = root;

    setupDrag(host, fab);

    fab.addEventListener('click', (e) => {
      if (fab.__dskDragged) {
        fab.__dskDragged = false;
        return;
      }
      e.stopPropagation();
      toggle().then((r) => {
        if (r && r.enabled) fab.title = 'DeepSeek 还原本页';
        else fab.title = 'DeepSeek 翻译本页';
      });
    });
  }

  function setupDrag(host, handle) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let down = false;

    handle.addEventListener('pointerdown', (e) => {
      down = true;
      handle.__dskDragged = false;
      startX = e.clientX;
      startY = e.clientY;
      const r = host.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
      handle.__dskDragged = true;
      const maxLeft = window.innerWidth - 54;
      const maxTop = window.innerHeight - 54;
      const left = Math.min(Math.max(6, originLeft + dx), Math.max(6, maxLeft));
      const top = Math.min(Math.max(6, originTop + dy), Math.max(6, maxTop));
      host.style.left = left + 'px';
      host.style.top = top + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    });

    const end = (e) => {
      if (!down) return;
      down = false;
      try {
        handle.releasePointerCapture(e.pointerId);
      } catch (_) {}
      if (handle.__dskDragged) {
        chrome.storage.local.set({
          fabPos: { left: parseInt(host.style.left, 10) || 0, top: parseInt(host.style.top, 10) || 0 }
        });
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function updateFloat(state) {
    if (!S.floatRoot) return;
    const fab = S.floatRoot.querySelector('.fab');
    if (!fab) return;

    if (state === 'working') {
      fab.dataset.state = 'working';
      fab.textContent = '…';
      const total = S.stats.total;
      const done = S.stats.done + S.stats.failed;
      fab.title = total ? '正在翻译 ' + done + '/' + total : '正在翻译…';
      return;
    }
    if (state === 'done') {
      fab.dataset.state = 'done';
      fab.textContent = '译';
      fab.title = '已翻译 ' + S.stats.done + ' 段，点击还原原文';
      return;
    }
    if (state === 'error') {
      fab.dataset.state = 'error';
      fab.textContent = '!';
      fab.title = S.lastError || '翻译出错';
      return;
    }
    fab.dataset.state = 'idle';
    fab.textContent = '译';
    fab.title = 'DeepSeek 翻译本页';
  }

  /* ================================================================ */
  /* 提示条                                                            */
  /* ================================================================ */

  let toastTimer = null;

  function toast(message, kind, ms) {
    let el = document.getElementById('dsk-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'dsk-toast';
      el.className = 'dsk-ui dsk-toast';
      document.documentElement.appendChild(el);
    }
    el.textContent = message;
    el.dataset.kind = kind || 'ok';
    el.classList.add('dsk-toast-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('dsk-toast-show'), ms || 3000);
  }

  /* ================================================================ */
  /* 划词翻译                                                          */
  /* ================================================================ */

  const BUBBLE_STYLE = `
    :host { all: initial; }
    .box {
      max-width: 380px; min-width: 180px;
      background: #1b1d27; color: #e5e7eb;
      border: 1px solid rgba(120,140,255,.28);
      border-radius: 12px; padding: 10px 12px;
      box-shadow: 0 12px 32px rgba(0,0,0,.45);
      font: 14px/1.6 -apple-system,"Segoe UI",system-ui,sans-serif;
      word-break: break-word;
    }
    .src { font-size: 11px; color: #8b93a7; margin-bottom: 6px; max-height: 60px; overflow: auto; }
    .dst { white-space: pre-wrap; }
    .err { color: #fca5a5; font-size: 12px; }
    .loading { color: #a5b4fc; font-size: 12px; }
    .bar { display:flex; gap:8px; margin-top:8px; }
    .bar button {
      font: 11px/1 inherit; color:#9ca3af; background:transparent; border:1px solid #374151;
      border-radius:6px; padding:4px 8px; cursor:pointer;
    }
    .bar button:hover { color:#e5e7eb; border-color:#4b5563; }
  `;

  function mountBubble() {
    if (S.bubbleHost) return S.bubbleHost;
    const host = document.createElement('div');
    host.id = 'dsk-bubble-host';
    host.className = 'dsk-ui';
    host.style.position = 'fixed';
    host.style.zIndex = '2147483647';
    host.style.display = 'none';
    document.documentElement.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + BUBBLE_STYLE + '</style><div class="box"></div>';
    S.bubbleHost = host;
    S.bubbleRoot = root;

    document.addEventListener('mousedown', (e) => {
      if (host.style.display !== 'none' && e.target !== host && !host.contains(e.target)) {
        hideBubble();
      }
    }, true);
    return host;
  }

  function hideBubble() {
    if (S.bubbleHost) S.bubbleHost.style.display = 'none';
  }

  function showBubble(x, y, src, content, state) {
    const host = mountBubble();
    const box = S.bubbleRoot.querySelector('.box');
    box.innerHTML = '';

    const srcEl = document.createElement('div');
    srcEl.className = 'src';
    srcEl.textContent = src.slice(0, 400);
    box.appendChild(srcEl);

    const dst = document.createElement('div');
    if (state === 'loading') {
      dst.className = 'loading';
      dst.textContent = '翻译中…';
    } else if (state === 'error') {
      dst.className = 'err';
      dst.textContent = content;
    } else {
      dst.className = 'dst';
      dst.textContent = content;
    }
    box.appendChild(dst);

    host.style.display = 'block';
    host.style.left = '0px';
    host.style.top = '0px';

    // 定位（先渲染再测量，避免超出视口）
    requestAnimationFrame(() => {
      const r = host.getBoundingClientRect();
      let left = x;
      let top = y + 12;
      if (left + r.width > window.innerWidth - 12) left = window.innerWidth - r.width - 12;
      if (top + r.height > window.innerHeight - 12) top = Math.max(8, y - r.height - 12);
      host.style.left = Math.max(8, left) + 'px';
      host.style.top = Math.max(8, top) + 'px';
    });

    return { srcEl, dst };
  }

  async function translateSelectionText(text) {
    const src = String(text || '').trim();
    if (!src) return;
    if (src.length > 2000) {
      showBubble(0, 0, src, '选中的文本太长（超过 2000 字），请分段选择。', 'error');
      return;
    }

    const sel = window.getSelection();
    let x = window.innerWidth / 2 - 150;
    let y = window.innerHeight / 2;
    if (sel && sel.rangeCount) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (rect && rect.width) {
        x = rect.left;
        y = rect.bottom;
      }
    }

    showBubble(x, y, src, '', 'loading');

    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: 'DSK_TRANSLATE',
        items: [{ i: 0, t: src }],
        settings: S.settings
      });
    } catch (e) {
      resp = { ok: false, error: '后台通信失败，请刷新页面' };
    }

    if (!resp || !resp.ok) {
      showBubble(x, y, src, (resp && resp.error) || '翻译失败', 'error');
      return;
    }
    const hit = (resp.items || []).find((it) => Number(it.i) === 0);
    const out = hit ? hit.t : '';
    if (!out) {
      showBubble(x, y, src, '没有拿到译文，请重试', 'error');
      return;
    }
    showBubble(x, y, src, out, 'ok');
  }

  function onMouseUp(e) {
    if (!S.settings.selectionTranslate) return;
    if (e.button !== 0) return;
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) {
      if (n && n.id === 'dsk-bubble-host') return;
      if (n && n.id === 'dsk-float-host') return;
    }

    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel ? sel.toString().trim() : '';
      if (!text || text.length < 2) {
        return;
      }
      // 单行短词才触发，避免整页选中时误弹
      if (text.length > 2000) return;
      if (!worthTranslating(text) && !/\p{L}/u.test(text)) return;
      translateSelectionText(text);
    }, 120);
  }

  /* ================================================================ */
  /* 消息                                                              */
  /* ================================================================ */

  /* ================================================================ */
  /* 采集诊断：回答「这段文字为什么没被翻」                            */
  /* ================================================================ */

  function scanReport() {
    const log = { counts: {}, samples: [] };
    const prev = S.skipLog;
    S.skipLog = log;
    let units = [];
    try {
      units = collectUnits(document.body || document.documentElement);
    } catch (e) {
      return { ok: false, error: String(e && e.message) };
    } finally {
      S.skipLog = prev;
    }

    // Shadow DOM 里的文字普通遍历根本看不见 —— 单独数一下，便于判断是不是这个原因
    let shadowRoots = 0;
    try {
      const all = document.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) if (all[i].shadowRoot) shadowRoots++;
    } catch (_) {}

    // 「看得见但没人翻」的英文句子：这才是用户真正会抱怨的东西。
    // 判定方式：文字节点既不在任何已采集单元的元素内，本身也不是已采集的节点。
    const unitEls = new Set();
    const unitNodes = new Set();
    for (const u of units) {
      if (u.node) unitNodes.add(u.node);
      else if (u.el) unitEls.add(u.el);
    }
    const uncovered = [];
    try {
      const w = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, null);
      let t2;
      while ((t2 = w.nextNode()) && uncovered.length < 60) {
        const raw = t2.nodeValue;
        if (!raw || raw.trim().length < 12) continue;
        const p = t2.parentElement;
        if (!p) continue;
        if (p.closest(UNSAFE_SELECTOR)) continue;
        if (SKIP_TAGS.has(p.tagName)) continue;
        if (unitNodes.has(t2)) continue;
        if (S.covered.has(t2)) continue;
        let covered = false;
        for (let a = p; a; a = a.parentElement) {
          if (unitEls.has(a)) { covered = true; break; }
        }
        if (covered) continue;
        if (!isVisible(p)) continue;
        const t = raw.replace(/\s+/g, ' ').trim();
        const letters = (t.match(/\p{L}/gu) || []).length;
        if (letters < 12) continue;
        if (t.split(' ').length < 3) continue;
        uncovered.push({
          t: t.slice(0, 80),
          tag: p.tagName,
          cls: typeof p.className === 'string' ? p.className.slice(0, 60) : '',
          reason: uncoveredReason(p),
          html: p.outerHTML.slice(0, 260),
          anime: (function () {
            const arr = [];
            for (let a = p.parentElement, i = 0; a && i < 4; a = a.parentElement, i++) {
              arr.push(a.tagName + '.' + (typeof a.className === 'string' ? a.className.slice(0, 40) : '')
                + (a.hasAttribute('data-dsk-done') ? '[done]' : ''));
            }
            return arr.join(' < ');
          })()
        });
      }
    } catch (_) {}

    return {
      ok: true,
      version: DSK.VERSION,
      enabled: S.enabled,
      units: units.length,
      counts: log.counts,
      samples: log.samples,
      stats: S.stats,
      diag: S.diag,
      agg: S.agg,
      shadowRoots,
      uncovered,
      preview: units.slice(0, 30).map((u) => ({
        t: String(u.text).slice(0, 60),
        tag: u.el ? u.el.tagName : '',
        node: !!u.textNode
      }))
    };
  }

  /** 给未覆盖的文本节点一个成因标签，方便对症下药 */
  function uncoveredReason(p) {
    if (!p) return 'unknown';
    const holder = closestInteractive(p);
    if (holder) return 'inside-interactive';
    if (getComputedStyle(p).display === 'none') return 'display-none';
    if (p.parentElement && getComputedStyle(p.parentElement).display === 'none') return 'parent-none';
    return 'plain';
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'DSK_GET_STATUS') {
      sendResponse(getStatus());
      return;
    }

    if (msg.type === 'DSK_TOGGLE') {
      toggle()
        .then((r) => sendResponse(Object.assign({ ok: true }, r, { status: getStatus() })))
        .catch((e) => sendResponse({ ok: false, error: String(e && e.message) }));
      return true;
    }

    if (msg.type === 'DSK_SETTINGS_CHANGED') {
      loadSettings().then(() => {
        if (S.enabled) {
          // 语言 / 模式变化需要重翻
          if (msg.needRetranslate) {
            stop(true);
            start();
          }
        }
        sendResponse({ ok: true, status: getStatus() });
      });
      return true;
    }

    if (msg.type === 'DSK_TRANSLATE_SELECTION') {
      translateSelectionText(msg.text || '');
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DSK_SCAN_DEBUG') {
      try {
        sendResponse(scanReport());
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message) });
      }
      return;
    }
  });

  /* ================================================================ */
  /* 初始化                                                            */
  /* ================================================================ */

  // 诊断钩子：扩展的隔离环境里可读，出问题时能一眼看到设置与状态
  window.__dskDebug = function () {
    return {
      settings: S.settings,
      enabled: S.enabled,
      stats: S.stats,
      lastError: S.lastError,
      floats: !!S.floatHost
    };
  };

  async function init() {
    if (document.contentType && !/html|xml/i.test(document.contentType)) return;
    await loadSettings();

    // 恢复悬浮球上次拖到的位置（必须在挂载前读到）
    try {
      const { fabPos } = await chrome.storage.local.get('fabPos');
      if (fabPos && typeof fabPos.left === 'number' && fabPos.left > 0) {
        S.savedPos = fabPos;
      }
    } catch (_) {}

    // 悬浮球是三种触发方式之一，必须页面一载入就在，否则用户没处点
    mountFloat();

    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideBubble();
    });

    if (S.settings.autoTranslate && S.settings.apiKey) {
      start();
      return;
    }

    // 站内跳转续翻：上一个页面开着翻译，这个页面（同一标签页、同一站点）自动接着翻。
    // 换到别的网站不续，避免点一个外链就开始烧额度。
    if (S.settings.autoResume !== false && S.settings.apiKey) {
      const st = await askTabAuto();
      if (st && st.on && st.host === location.host) {
        start({ resume: true });
      }
    }
  }

  init();
})();
