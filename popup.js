(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const el = {
    toggle: $('#toggleBtn'),
    status: $('#statusLine'),
    lang: $('#langSel'),
    mode: $('#modeSel'),
    model: $('#modelLine'),
    warn: $('#warn'),
    options: $('#optionsLink'),
    ver: $('#ver')
  };

  let state = { enabled: false, stats: { total: 0, done: 0, failed: 0 }, error: '', settings: {} };
  let pollTimer = null;
  let busy = false;

  /* ---------------------------------------------------------------- */

  function isRestricted(url) {
    if (!url) return true;
    if (/^(chrome|edge|about|devtools|chrome-extension|extension|view-source|data):/i.test(url)) return true;
    if (/^https:\/\/chromewebstore\.google\.com/i.test(url)) return true;
    if (/^https:\/\/microsoftedge\.microsoft\.com\/addons/i.test(url)) return true;
    return false;
  }

  async function getTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab || null;
  }

  async function ensureSend(msg) {
    const tab = await getTab();
    if (!tab || tab.id == null) throw new Error('找不到当前标签页');
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (_) {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content.css'] });
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['shared.js', 'content.js']
      });
      return await chrome.tabs.sendMessage(tab.id, msg);
    }
  }

  /* ---------------------------------------------------------------- */

  function renderStatus() {
    const { enabled, stats, error } = state;
    el.toggle.textContent = enabled ? '还原本页' : '翻译此页';
    el.toggle.classList.toggle('on', !!enabled);
    el.toggle.disabled = busy;

    el.status.classList.remove('err', 'ok');

    if (busy) {
      el.status.textContent = '处理中…';
      return;
    }

    if (!state.settings.hasKey) {
      el.status.textContent = '尚未填写 API Key';
      el.status.classList.add('err');
      return;
    }

    if (enabled) {
      const done = stats.done || 0;
      const total = stats.total || 0;
      if (total && done + (stats.failed || 0) < total) {
        el.status.textContent = `翻译中 ${done}/${total} 段…`;
      } else if (error) {
        el.status.textContent = error;
        el.status.classList.add('err');
      } else if (done) {
        el.status.textContent = `已翻译 ${done} 段`;
        el.status.classList.add('ok');
      } else {
        el.status.textContent = '已启用，等待页面内容…';
      }
    } else if (error) {
      el.status.textContent = error;
      el.status.classList.add('err');
    } else {
      el.status.textContent = '未翻译此页';
    }
  }

  function showWarn(html) {
    el.warn.innerHTML = html;
    el.warn.classList.remove('hidden');
  }

  /* ---------------------------------------------------------------- */

  async function init() {
    el.ver.textContent = 'v' + DSK.VERSION;

    // 填充语言下拉
    for (const l of DSK.LANGS) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      el.lang.appendChild(o);
    }

    const settings = await DSK.getSettings();
    el.lang.value = settings.targetLang;
    el.mode.value = settings.mode;
    el.model.textContent = settings.model + ' · ' + DSK.langName(settings.targetLang);

    state.settings = { hasKey: !!settings.apiKey };

    if (!settings.apiKey) {
      showWarn('还没有填写 API Key。<a id="goOpt">去设置 →</a>');
      const link = $('#goOpt');
      if (link) link.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); window.close(); });
      renderStatus();
      return;
    }

    const tab = await getTab();
    if (!tab || isRestricted(tab.url)) {
      el.toggle.disabled = true;
      el.status.textContent = '当前页面不支持扩展（浏览器内部页面 / 扩展商店）';
      el.status.classList.add('err');
      return;
    }

    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'DSK_GET_STATUS' });
      if (st) {
        state = Object.assign(state, st, { settings: { hasKey: true, ...(st.settings || {}) } });
      }
    } catch (_) {
      // content script 还没注入是正常的，只影响状态显示
    }
    renderStatus();
    startPoll();
  }

  function startPoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (!state.enabled) return;
      try {
        const tab = await getTab();
        if (!tab || tab.id == null) return;
        const st = await chrome.tabs.sendMessage(tab.id, { type: 'DSK_GET_STATUS' });
        if (st) state = Object.assign(state, st);
        renderStatus();
      } catch (_) {}
    }, 900);
  }

  /* ---------------------------------------------------------------- */

  el.toggle.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    renderStatus();
    try {
      const res = await ensureSend({ type: 'DSK_TOGGLE' });
      if (res && res.status) state = Object.assign(state, res.status);
      else state.enabled = !!(res && res.enabled);
      if (res && res.ok === false && res.error) state.error = res.error;
      if (state.enabled) startPoll();
    } catch (e) {
      state.error = '无法在此页面运行：' + (e && e.message ? e.message : e);
      showWarn('这个页面不允许扩展注入脚本。<br>请换一个普通网页（http/https）再试。');
    } finally {
      busy = false;
      renderStatus();
    }
  });

  el.lang.addEventListener('change', async () => {
    const value = el.lang.value;
    await chrome.storage.local.set({ targetLang: value });
    el.model.textContent = (await DSK.getSettings()).model + ' · ' + DSK.langName(value);
    if (state.enabled) {
      try {
        await ensureSend({ type: 'DSK_SETTINGS_CHANGED', needRetranslate: true });
      } catch (_) {}
    }
  });

  el.mode.addEventListener('change', async () => {
    const value = el.mode.value;
    await chrome.storage.local.set({ mode: value });
    if (state.enabled) {
      try {
        await ensureSend({ type: 'DSK_SETTINGS_CHANGED', needRetranslate: true });
      } catch (_) {}
    }
  });

  el.options.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
    window.close();
  });

  window.addEventListener('unload', () => clearInterval(pollTimer));

  init();
})();
