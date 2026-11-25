(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);

  const el = {
    apiKey: $('#apiKey'),
    toggleKey: $('#toggleKey'),
    baseUrl: $('#baseUrl'),
    model: $('#model'),
    modelList: $('#modelList'),
    testBtn: $('#testBtn'),
    testResult: $('#testResult'),
    targetLang: $('#targetLang'),
    mode: $('#mode'),
    shortTextReplace: $('#shortTextReplace'),
    customPrompt: $('#customPrompt'),
    concurrency: $('#concurrency'),
    chunkChars: $('#chunkChars'),
    showFloatButton: $('#showFloatButton'),
    selectionTranslate: $('#selectionTranslate'),
    autoTranslate: $('#autoTranslate'),
    autoResume: $('#autoResume'),
    saveBtn: $('#saveBtn'),
    resetBtn: $('#resetBtn'),
    saveTip: $('#saveTip')
  };

  let saveTimer = null;
  let lastSaved = null;

  /* ---------------------------------------------------------------- */

  function fillSelects() {
    for (const l of DSK.LANGS) {
      const o = document.createElement('option');
      o.value = l.code;
      o.textContent = l.name;
      el.targetLang.appendChild(o);
    }
    for (const m of DSK.MODEL_PRESETS) {
      const o = document.createElement('option');
      o.value = m.id;
      o.textContent = m.label;
      el.modelList.appendChild(o);
    }
  }

  function applyToForm(s) {
    el.apiKey.value = s.apiKey || '';
    el.baseUrl.value = s.baseUrl || DSK.DEFAULTS.baseUrl;
    el.model.value = s.model || DSK.DEFAULTS.model;
    el.targetLang.value = s.targetLang || DSK.DEFAULTS.targetLang;
    el.mode.value = s.mode || DSK.DEFAULTS.mode;
    el.shortTextReplace.checked = s.shortTextReplace !== false;
    el.customPrompt.value = s.customPrompt || '';
    el.concurrency.value = String(s.concurrency || DSK.DEFAULTS.concurrency);
    el.chunkChars.value = s.chunkChars || DSK.DEFAULTS.chunkChars;
    el.showFloatButton.checked = s.showFloatButton !== false;
    el.selectionTranslate.checked = s.selectionTranslate !== false;
    el.autoTranslate.checked = !!s.autoTranslate;
    el.autoResume.checked = s.autoResume !== false;
  }

  function collectForm() {
    return {
      apiKey: el.apiKey.value.trim(),
      baseUrl: DSK.normalizeBaseUrl(el.baseUrl.value),
      model: el.model.value.trim() || DSK.DEFAULTS.model,
      targetLang: el.targetLang.value,
      mode: el.mode.value,
      shortTextReplace: el.shortTextReplace.checked,
      customPrompt: el.customPrompt.value.trim(),
      concurrency: Number(el.concurrency.value) || 2,
      chunkChars: Math.min(8000, Math.max(600, Number(el.chunkChars.value) || 2400)),
      showFloatButton: el.showFloatButton.checked,
      selectionTranslate: el.selectionTranslate.checked,
      autoTranslate: el.autoTranslate.checked,
      autoResume: el.autoResume.checked
    };
  }

  function tip(text, ok) {
    el.saveTip.textContent = text;
    el.saveTip.style.color = ok === false ? 'var(--danger)' : 'var(--ok)';
    el.saveTip.classList.add('show');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => el.saveTip.classList.remove('show'), 2200);
  }

  async function save(showTip) {
    const data = collectForm();
    if (data.baseUrl !== el.baseUrl.value.trim()) {
      el.baseUrl.value = data.baseUrl;
    }
    await chrome.storage.local.set(data);

    // 只有影响译文结果的字段变化时才让已翻译页面重翻，避免白白烧额度
    const needRetranslate =
      !lastSaved ||
      lastSaved.targetLang !== data.targetLang ||
      lastSaved.mode !== data.mode ||
      lastSaved.customPrompt !== data.customPrompt ||
      lastSaved.model !== data.model;
    lastSaved = data;

    const tabs = await chrome.tabs.query({});
    for (const t of tabs) {
      if (t.id == null) continue;
      chrome.tabs.sendMessage(t.id, { type: 'DSK_SETTINGS_CHANGED', needRetranslate }, () => {
        void chrome.runtime.lastError;
      });
    }

    if (showTip) tip('已保存', true);
    return data;
  }

  /* ---------------------------------------------------------------- */

  el.toggleKey.addEventListener('click', () => {
    const isPwd = el.apiKey.type === 'password';
    el.apiKey.type = isPwd ? 'text' : 'password';
    el.toggleKey.textContent = isPwd ? '隐藏' : '显示';
  });

  el.testBtn.addEventListener('click', async () => {
    const data = collectForm();
    el.testBtn.disabled = true;
    el.testResult.className = 'test-result';
    el.testResult.textContent = '正在请求…';

    try {
      const res = await chrome.runtime.sendMessage({ type: 'DSK_TEST', settings: data });
      if (res && res.ok) {
        el.testResult.className = 'test-result ok';
        el.testResult.textContent =
          '连接成功 · ' + res.model + ' · ' + res.ms + 'ms · 示例译文：' + String(res.sample || '').slice(0, 40);
      } else {
        el.testResult.className = 'test-result err';
        el.testResult.textContent = (res && res.error) || '连接失败';
      }
    } catch (e) {
      el.testResult.className = 'test-result err';
      el.testResult.textContent = '测试失败：' + ((e && e.message) || e);
    } finally {
      el.testBtn.disabled = false;
    }
  });

  el.saveBtn.addEventListener('click', async () => {
    el.saveBtn.disabled = true;
    try {
      await save(true);
    } finally {
      el.saveBtn.disabled = false;
    }
  });

  el.resetBtn.addEventListener('click', async () => {
    if (!confirm('恢复所有设置为默认值？API Key 也会被清空。')) return;
    await chrome.storage.local.remove(Object.keys(DSK.DEFAULTS));
    applyToForm(DSK.DEFAULTS);
    tip('已恢复默认', true);
  });

  // 改动即时保存，避免忘记点保存
  const autoSave = () => save(false);
  ['change'].forEach((ev) => {
    el.baseUrl.addEventListener(ev, autoSave);
    el.model.addEventListener(ev, autoSave);
    el.targetLang.addEventListener(ev, autoSave);
    el.mode.addEventListener(ev, autoSave);
    el.concurrency.addEventListener(ev, autoSave);
    el.chunkChars.addEventListener(ev, autoSave);
    el.showFloatButton.addEventListener(ev, autoSave);
    el.selectionTranslate.addEventListener(ev, autoSave);
    el.autoTranslate.addEventListener(ev, autoSave);
    el.autoResume.addEventListener(ev, autoSave);
    el.customPrompt.addEventListener(ev, autoSave);
    el.apiKey.addEventListener(ev, autoSave);
  });

  /* ---------------------------------------------------------------- */

  (async function init() {
    fillSelects();
    const s = await DSK.getSettings();
    applyToForm(s);
    lastSaved = collectForm();
    if (!s.apiKey) el.apiKey.focus();
  })();
})();
