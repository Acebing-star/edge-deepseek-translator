/**
 * background.js —— Service Worker
 * 负责：调用 DeepSeek API、右键菜单、快捷键、图标角标。
 */
importScripts('shared.js');

const MENU_SELECTION = 'dsk-translate-selection';
const MENU_PAGE = 'dsk-translate-page';

/* ------------------------------------------------------------------ */
/* 生命周期                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'DeepSeek 翻译选中文本',
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_PAGE,
      title: 'DeepSeek 翻译 / 还原此页',
      contexts: ['page']
    });
  });

  if (details.reason === 'install') {
    const s = await DSK.getSettings();
    if (!s.apiKey) chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === MENU_SELECTION) {
    await sendToTab(tab.id, {
      type: 'DSK_TRANSLATE_SELECTION',
      text: String(info.selectionText || '').trim()
    });
  } else if (info.menuItemId === MENU_PAGE) {
    await toggleOnTab(tab.id);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab && tab.id != null) await toggleOnTab(tab.id);
});

/* ------------------------------------------------------------------ */
/* 与内容脚本通信                                                       */
/* ------------------------------------------------------------------ */

async function sendToTab(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (_) {
    return null;
  }
}

/** 确保 content script 已注入，然后切换翻译状态 */
async function toggleOnTab(tabId) {
  let res = await sendToTab(tabId, { type: 'DSK_TOGGLE' });
  if (res == null) {
    // content script 未注入（安装扩展前就打开的标签页 / 受限页面），尝试手动注入
    try {
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
      await chrome.scripting.executeScript({ target: { tabId }, files: ['shared.js', 'content.js'] });
      res = await sendToTab(tabId, { type: 'DSK_TOGGLE' });
    } catch (e) {
      setBadge(tabId, '—', '#9ca3af');
      return { ok: false, error: '该页面不允许扩展运行（浏览器内部页面 / 扩展商店页）' };
    }
  }
  return res || { ok: false, error: '页面未响应' };
}

/* ------------------------------------------------------------------ */
/* 图标角标                                                            */
/* ------------------------------------------------------------------ */

function setBadge(tabId, text, color) {
  try {
    chrome.action.setBadgeText({ tabId, text });
    if (color) chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch (_) {
    /* 忽略 tab 已关闭 */
  }
}

/* ------------------------------------------------------------------ */
/* 标签页级「翻译已开启」状态                                          */
/* 作用：同一标签页跳到新页面（点击链接、站点内导航）时，content script */
/* 是全新的一份，内存状态全丢。这里按 tabId 记一笔，新页面据此自动续翻。 */
/* 用 session 存储：浏览器重启后自然清空，不会莫名其妙一直自动翻。      */
/* ------------------------------------------------------------------ */

const TAB_AUTO_KEY = 'dskTabAuto';
let tabAutoMap = null;
let tabAutoWriting = Promise.resolve();

async function loadTabAuto() {
  if (tabAutoMap) return tabAutoMap;
  tabAutoMap = {};
  for (const area of ['session', 'local']) {
    try {
      const got = await chrome.storage[area].get(TAB_AUTO_KEY);
      const v = got && got[TAB_AUTO_KEY];
      if (v && typeof v === 'object') {
        tabAutoMap = v;
        break;
      }
    } catch (_) {
      /* session 不可用时退回 local */
    }
  }
  return tabAutoMap;
}

function persistTabAuto() {
  const snapshot = Object.assign({}, tabAutoMap);
  tabAutoWriting = tabAutoWriting
    .then(async () => {
      try {
        await chrome.storage.session.set({ [TAB_AUTO_KEY]: snapshot });
      } catch (_) {
        try {
          await chrome.storage.local.set({ [TAB_AUTO_KEY]: snapshot });
        } catch (_) {}
      }
    })
    .catch(() => {});
  return tabAutoWriting;
}

async function setTabAuto(tabId, on, host) {
  if (tabId == null) return;
  const map = await loadTabAuto();
  if (on) map[tabId] = { host: String(host || ''), t: Date.now() };
  else delete map[tabId];
  await persistTabAuto();
}

async function getTabAuto(tabId) {
  if (tabId == null) return { on: false, host: '' };
  const map = await loadTabAuto();
  const rec = map[tabId];
  return { on: !!(rec && rec.host !== undefined), host: (rec && rec.host) || '' };
}

// 标签页关掉就清掉，避免表越攒越大
chrome.tabs.onRemoved.addListener((tabId) => {
  loadTabAuto().then((map) => {
    if (map[tabId]) {
      delete map[tabId];
      persistTabAuto();
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'DSK_TAB_AUTO_GET') {
    const tabId = sender.tab && sender.tab.id;
    getTabAuto(tabId)
      .then((r) => sendResponse(Object.assign({ ok: true }, r)))
      .catch(() => sendResponse({ ok: false, on: false, host: '' }));
    return true;
  }

  if (msg.type === 'DSK_TAB_AUTO_SET') {
    const tabId = sender.tab && sender.tab.id;
    setTabAuto(tabId, !!msg.on, msg.host)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === 'DSK_TRANSLATE') {
    handleTranslate(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 保持消息通道，异步回复
  }

  if (msg.type === 'DSK_BADGE' && sender.tab && sender.tab.id != null) {
    setBadge(sender.tab.id, msg.text || '', msg.color || '#4D6BFE');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'DSK_TEST') {
    testConnection(msg.settings)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

/* ------------------------------------------------------------------ */
/* 翻译核心                                                            */
/* ------------------------------------------------------------------ */

const SYSTEM_TEMPLATE = `你是一个专业的网页翻译引擎，把网页文本翻译成「{LANG}」。

输入是一个 JSON 对象：{"need":[{"i":0,"t":"原文"},...]}
输出必须是一个 JSON 对象：{"items":[{"i":0,"t":"译文"},...]}

硬性规则：
1. 条目数量、i 序号必须与输入完全一致，禁止合并、拆分、遗漏、重排。
2. 译文自然通顺，符合「{LANG}」母语者的表达习惯，不要留下逐词直译的痕迹。
3. 原样保留变量占位符（如 {name}、%s、\${x}）、代码标识符、URL、邮箱、数字与单位格式。
4. 游戏、电影、剧集、书籍、软件、文章等「作品名」必须译成中文，首次出现时在括号内附原名，例如 The Witcher 3: Wild Hunt → 巫师3：狂猎（The Witcher 3: Wild Hunt）。品牌名、公司名、人名保留原文。
5. 导航词、分类名、按钮文字、列表项这类短语也要翻译，不要因为文本短就原样返回。
6. 输出纯 JSON，不要 Markdown 代码围栏，不要任何解释性文字。
7. 某条文本本身无需翻译（纯符号、纯数字、已是目标语言）时，原样返回。`;

function buildMessages(items, settings) {
  const lang = DSK.langName(settings.targetLang);
  let system = SYSTEM_TEMPLATE.replace(/\{LANG\}/g, lang);
  const extra = String(settings.customPrompt || '').trim();
  if (extra) system += `\n\n附加要求（优先遵守）：\n${extra}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ need: items }) }
  ];
}

function parseItems(content, expectedCount) {
  let s = String(content || '').trim();
  if (!s) return null;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  let obj = null;
  try {
    obj = JSON.parse(s);
  } catch (_) {
    const a = s.indexOf('{');
    const b = s.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        obj = JSON.parse(s.slice(a, b + 1));
      } catch (_) {}
    }
  }
  if (!obj) {
    const a = s.indexOf('[');
    const b = s.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try {
        const arr = JSON.parse(s.slice(a, b + 1));
        obj = { items: arr };
      } catch (_) {}
    }
  }

  // 输出被截断（少了结尾括号）时，退到最后一个完整条目再补齐括号，
  // 比整批重试便宜，也能避免偶尔一次截断就把整批判成失败
  if (!obj) {
    const itemRe = new RegExp('\\{\\s*"i"\\s*:', 'g');
    let last = -1;
    let mm;
    while ((mm = itemRe.exec(s))) last = mm.index;
    if (last > 0) {
      const cand = s.slice(0, last).replace(/[\s,]+$/, '') + '}]}';
      try {
        obj = JSON.parse(cand);
      } catch (_) {}
    }
  }

  // 兜底：模型偶尔会输出 {"i":12","t":"..."}（数字后多一个引号）这种畸形 JSON，
  // 整批重试三次也复现同一个位置，于是直接把条目抠出来
  if (!obj) {
    const pairRe = new RegExp('"i"\\s*:\\s*(\\d+)\\s*[",:\\s]*"t"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"', 'g');
    const loose = [];
    let pm;
    while ((pm = pairRe.exec(s))) {
      let val = pm[2];
      try {
        val = JSON.parse('"' + pm[2] + '"');
      } catch (_) {}
      loose.push({ i: Number(pm[1]), t: val });
    }
    if (loose.length) obj = { items: loose };
  }

  if (!obj) return null;

  // 模型偶尔直接返回裸数组 [{i,t},...]
  if (Array.isArray(obj)) obj = { items: obj };

  let list = obj.items || obj.result || obj.data || obj.translations || obj.output;
  if (!Array.isArray(list)) {
    // 兼容 {"0":"译文","1":"译文"} 这类返回
    const vals = Object.values(obj);
    if (vals.length && vals.every((v) => typeof v === 'string')) {
      list = vals.map((t, i) => ({ i, t }));
    } else {
      return null;
    }
  }

  const out = [];
  list.forEach((it, idx) => {
    if (it == null) return;
    if (typeof it === 'string') {
      out.push({ i: idx, t: it });
      return;
    }
    const i = Number(it.i != null ? it.i : it.index != null ? it.index : it.id != null ? it.id : idx);
    const t = it.t != null ? it.t : it.text != null ? it.text : it.translation != null ? it.translation : '';
    if (Number.isFinite(i)) out.push({ i, t: String(t) });
  });

  if (!out.length) return null;
  if (expectedCount && out.length < expectedCount / 2) return null; // 明显漏译，重试
  return out;
}

async function callApi(messages, settings, override) {
  const base = DSK.normalizeBaseUrl(settings.baseUrl);
  const url = base + '/chat/completions';
  const isReasoner = /reasoner|r1/i.test(String(settings.model || ''));

  const body = {
    model: settings.model || 'deepseek-chat',
    messages,
    stream: false,
    max_tokens: 8192
  };
  if (!isReasoner) {
    body.temperature = Number(settings.temperature);
    if (!Number.isFinite(body.temperature)) body.temperature = 0.2;
    body.response_format = { type: 'json_object' };
  }
  if (override) Object.assign(body, override);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + settings.apiKey
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      const err = new Error(DSK.friendlyError(resp.status, text));
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/* 轻量诊断日志：只保留最近 40 条，写到 storage，便于排查卡住的原因 */
async function dbg(entry) {
  try {
    const got = await chrome.storage.local.get({ dbgLog: [] });
    const log = Array.isArray(got.dbgLog) ? got.dbgLog : [];
    log.push(Object.assign({ t: Date.now() }, entry));
    while (log.length > 40) log.shift();
    await chrome.storage.local.set({ dbgLog: log });
  } catch (_) {}
}

async function handleTranslate(msg) {
  const settings = Object.assign({}, await DSK.getSettings(), msg.settings || {});
  // 内容脚本里的设置可能比存储里的旧（页面先打开、后填 Key），空值不覆盖
  if (!settings.apiKey) {
    const stored = await DSK.getSettings();
    settings.apiKey = stored.apiKey;
  }
  if (!settings.apiKey) {
    await dbg({ stage: 'no-key' });
    return { ok: false, error: '还没有填写 DeepSeek API Key，点扩展图标 → 设置里填写。' };
  }
  const items = Array.isArray(msg.items) ? msg.items : [];
  if (!items.length) return { ok: true, items: [] };

  const messages = buildMessages(items, settings);
  const t0 = Date.now();
  const chars = items.reduce((s, it) => s + String(it.t || '').length, 0);
  await dbg({ stage: 'req', items: items.length, chars, model: settings.model,
              base: settings.baseUrl, keyLen: String(settings.apiKey).length });

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const data = await callApi(messages, settings);
      const content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      const parsed = parseItems(content, items.length);
      if (!parsed) {
        await dbg({ stage: 'parse-fail', ms: Date.now() - t0,
                    len: String(content).length,
                    finish: (data && data.choices && data.choices[0] && data.choices[0].finish_reason) || '',
                    head: String(content).slice(0, 120),
                    tail: String(content).slice(-120) });
        lastErr = new Error('模型返回的格式无法解析，正在重试…');
        await sleep(600);
        continue;
      }
      await dbg({ stage: 'ok', ms: Date.now() - t0, items: parsed.length });
      return {
        ok: true,
        items: parsed,
        usage: (data && data.usage) || null,
        model: (data && data.model) || settings.model
      };
    } catch (e) {
      lastErr = e;
      const status = e && e.status;
      if (e && e.name === 'AbortError') {
        lastErr = new Error('请求超时（90 秒），请检查网络或减少单批文本量。');
        await dbg({ stage: 'timeout', ms: Date.now() - t0 });
      } else {
        await dbg({ stage: 'error', ms: Date.now() - t0, status: status || 0,
                    msg: String((e && e.message) || e).slice(0, 200) });
      }
      if (status && RETRYABLE.has(status)) {
        await sleep(1200 * Math.pow(2, attempt));
        continue;
      }
      break;
    }
  }
  return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
}

async function testConnection(settingsOverride) {
  const settings = Object.assign({}, await DSK.getSettings(), settingsOverride || {});
  if (!settings.apiKey) return { ok: false, error: '请先填写 API Key' };
  const t0 = Date.now();
  try {
    const data = await callApi(
      [
        { role: 'system', content: '你是翻译引擎。只输出 JSON：{"items":[{"i":0,"t":"译文"}]}' },
        { role: 'user', content: JSON.stringify({ need: [{ i: 0, t: 'Hello, world.' }] }) }
      ],
      settings,
      { max_tokens: 512 }
    );
    const content = data.choices[0].message.content;
    const parsed = parseItems(content, 1);
    return {
      ok: true,
      model: data.model,
      ms: Date.now() - t0,
      sample: parsed && parsed[0] ? parsed[0].t : content
    };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
