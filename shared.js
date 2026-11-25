/**
 * shared.js —— 扩展内各运行环境（service worker / content script / popup / options）
 * 共用的一份常量与工具。通过 importScripts 或 <script> 引入，挂到 globalThis.DSK。
 */
(function (g) {
  'use strict';

  const DEFAULTS = {
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    targetLang: 'zh-CN',
    mode: 'bilingual', // bilingual | replace
    shortTextReplace: true, // 导航/按钮等短文案直接用译文替换原文
    concurrency: 2,
    chunkChars: 2400,
    chunkItems: 30,
    showFloatButton: true,
    selectionTranslate: true,
    autoTranslate: false,
    autoResume: true, // 同一标签页跳到新页面 / 站内切页时，自动接着翻，不用再点一次
    customPrompt: '',
    temperature: 0.2
  };

  const LANGS = [
    { code: 'zh-CN', name: '简体中文' },
    { code: 'zh-TW', name: '繁体中文' },
    { code: 'en', name: 'English / 英语' },
    { code: 'ja', name: '日本語 / 日语' },
    { code: 'ko', name: '한국어 / 韩语' },
    { code: 'fr', name: 'Français / 法语' },
    { code: 'de', name: 'Deutsch / 德语' },
    { code: 'es', name: 'Español / 西班牙语' },
    { code: 'ru', name: 'Русский / 俄语' },
    { code: 'pt', name: 'Português / 葡萄牙语' },
    { code: 'it', name: 'Italiano / 意大利语' },
    { code: 'ar', name: 'العربية / 阿拉伯语' },
    { code: 'th', name: 'ไทย / 泰语' },
    { code: 'vi', name: 'Tiếng Việt / 越南语' },
    { code: 'id', name: 'Bahasa Indonesia / 印尼语' },
    { code: 'tr', name: 'Türkçe / 土耳其语' },
    { code: 'hi', name: 'हिन्दी / 印地语' }
  ];

  const MODEL_PRESETS = [
    { id: 'deepseek-chat', label: 'deepseek-chat — 通用对话模型（默认，速度快、成本低）' },
    { id: 'deepseek-reasoner', label: 'deepseek-reasoner — 推理模型（更准，但慢且贵一些）' }
  ];

  function langName(code) {
    const hit = LANGS.find((l) => l.code === code);
    return hit ? hit.name.split(' / ')[0] : code;
  }

  async function getSettings() {
    const stored = await chrome.storage.local.get(DEFAULTS);
    return Object.assign({}, DEFAULTS, stored);
  }

  async function saveSettings(patch) {
    await chrome.storage.local.set(patch);
    return getSettings();
  }

  function normalizeBaseUrl(url) {
    let u = String(url || '').trim().replace(/\s+/g, '');
    if (!u) return DEFAULTS.baseUrl;
    u = u.replace(/\/+$/, '');
    // 允许用户直接粘贴完整 endpoint
    u = u.replace(/\/chat\/completions$/i, '');
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u;
  }

  function friendlyError(status, body) {
    const snippet = String(body || '').slice(0, 300);
    switch (status) {
      case 400:
        return '请求参数有误（400）：' + snippet;
      case 401:
        return 'API Key 无效或未填写（401）。请到设置页检查密钥。';
      case 402:
        return '账户余额不足（402），请到 DeepSeek 开放平台充值。';
      case 403:
        return '无权访问该模型（403）：' + snippet;
      case 404:
        return '接口地址或模型不存在（404）。请检查 Base URL 与模型名：' + snippet;
      case 422:
        return '请求格式被拒绝（422）：' + snippet;
      case 429:
        return '请求太频繁被限流（429），请稍后重试或降低并发数。';
      case 500:
      case 502:
      case 503:
        return '服务端暂时不可用（' + status + '），请稍后重试。';
      default:
        return '请求失败（' + status + '）：' + snippet;
    }
  }

  g.DSK = {
    DEFAULTS,
    LANGS,
    MODEL_PRESETS,
    langName,
    getSettings,
    saveSettings,
    normalizeBaseUrl,
    friendlyError,
    VERSION: '1.0.6'
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
