/**
 * 从源码里提取函数体，在 vm 沙箱里跑断言。
 * 只测纯逻辑：分段、分批、语言判定、模型返回解析。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = fs.existsSync(path.join(__dirname, 'content.js'))
  ? __dirname
  : path.join(__dirname, '..');
const contentSrc = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');

function extract(src, name) {
  const key = 'function ' + name + '(';
  const start = src.indexOf(key);
  if (start < 0) throw new Error('找不到函数 ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  let inStr = null;
  let inBlock = false;
  let inLine = false;
  for (; i < src.length; i++) {
    const c = src[i];
    const prev = src[i - 1];
    if (inLine) {
      if (c === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === '/' && prev === '*') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '/' && prev === '/') {
      inLine = true;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      inBlock = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('函数 ' + name + ' 大括号不匹配');
}

/* ------------------------------------------------------------------ */

const contentFns = ['isAlreadyTarget', 'worthTranslating', 'splitLongText', 'makeBatches'];
const backgroundFns = ['parseItems'];

const CONSTS = ['CJK_RE', 'KANA_RE'];

function extractConst(src, name) {
  const re = new RegExp('const\\s+' + name + '\\s*=\\s*(\\/[^\\/\\n]*\\/[gimsuy]*)\\s*;');
  const m = src.match(re);
  if (!m) throw new Error('找不到常量 ' + name);
  return 'const ' + name + ' = ' + m[1] + ';';
}

const sandbox = {
  S: {
    settings: {
      targetLang: 'zh-CN',
      chunkChars: 100,
      chunkItems: 3
    }
  },
  Math,
  Number,
  String,
  Array,
  Object,
  JSON,
  console
};
vm.createContext(sandbox);

const code =
  CONSTS.map((n) => extractConst(contentSrc, n)).join('\n') +
  '\n\n' +
  contentFns.map((n) => extract(contentSrc, n)).join('\n\n') +
  '\n\n' +
  backgroundFns.map((n) => extract(bgSrc, n)).join('\n\n') +
  '\n\nthis.API = { isAlreadyTarget, worthTranslating, splitLongText, makeBatches, parseItems };';

vm.runInContext(code, sandbox);
const API = sandbox.API;

/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;
const failures = [];

function ok(name, cond, extra) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(name + (extra ? ' → ' + extra : ''));
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  ok(name, a === b, 'got ' + a + ', want ' + b);
}

/* 1. 语言判定 ------------------------------------------------------ */
ok('中文段落判定为已是目标语言', API.isAlreadyTarget('这是一个中文段落，不需要翻译。') === true);
ok('英文段落判定为需要翻译', API.isAlreadyTarget('This is an English paragraph.') === false);
ok('数字符号不算需要翻译', API.isAlreadyTarget('12345 !!! 6789') === true);
ok('中英混排以英文为主需翻译', API.isAlreadyTarget('DeepSeek V4.1 released a new model today') === false);

sandbox.S.settings.targetLang = 'en';
ok('目标英文时英文段落跳过', API.isAlreadyTarget('This is plain English text.') === true);
ok('目标英文时中文段落需翻译', API.isAlreadyTarget('这是一个中文段落，需要翻译成英文。') === false);
sandbox.S.settings.targetLang = 'zh-CN';

/* 2. 是否需要翻译 -------------------------------------------------- */
ok('纯 URL 跳过', API.worthTranslating('https://example.com/a/b?c=1') === false);
ok('单字符跳过', API.worthTranslating('a') === false);
ok('邮箱跳过', API.worthTranslating('me@example.com') === false);
ok('普通英文句子接受', API.worthTranslating('Hello there, how are you?') === true);
ok('中文句子拒绝', API.worthTranslating('今天天气不错，我们出门吧。') === false);

/* 3. 长文本切分 ---------------------------------------------------- */
const longText = Array.from({ length: 40 }, (_, i) => 'This is sentence number ' + i + '. ').join('');
const parts = API.splitLongText(longText, 300);
ok('长文本被切成多段', parts.length > 1, 'parts=' + parts.length);
ok('切分后总量不丢失太多', parts.join('').length >= longText.length - 40, parts.join('').length + ' vs ' + longText.length);
ok('每段不超过 1.5 倍上限', parts.every((p) => p.length <= 450), Math.max(...parts.map((p) => p.length)));

/* 4. 分批 ---------------------------------------------------------- */
sandbox.S.settings.chunkChars = 600;
sandbox.S.settings.chunkItems = 5;
const units = Array.from({ length: 10 }, (_, i) => ({ el: i, text: 'x'.repeat(200) }));
const batches = API.makeBatches(units);
ok('每批条目数不超上限', batches.every((b) => b.length <= 5), batches.map((b) => b.length).join(','));
ok(
  '每批字符数不超上限',
  batches.every((b) => b.reduce((s, u) => s + u.text.length, 0) <= 600 || b.length === 1),
  batches.map((b) => b.reduce((s, u) => s + u.text.length, 0)).join(',')
);
ok('分批后条目总数不变', batches.reduce((s, b) => s + b.length, 0) === 10);

const emptyBatches = API.makeBatches([]);
eq('空数组返回空批次', emptyBatches, []);

/* 5. 解析模型返回 -------------------------------------------------- */
const std = JSON.stringify({ items: [{ i: 0, t: '你好' }, { i: 1, t: '世界' }] });
eq('标准 JSON 解析', API.parseItems(std, 2), [{ i: 0, t: '你好' }, { i: 1, t: '世界' }]);

const fenced = '```json\n' + std + '\n```';
eq('去代码围栏', API.parseItems(fenced, 2), [{ i: 0, t: '你好' }, { i: 1, t: '世界' }]);

const chatty = '好的，以下是翻译结果：\n' + std + '\n希望有帮助！';
eq('前后有多余文字也能解析', API.parseItems(chatty, 2), [{ i: 0, t: '你好' }, { i: 1, t: '世界' }]);

const arrOnly = '[{"i":0,"t":"甲"},{"i":1,"t":"乙"}]';
eq('裸数组解析', API.parseItems(arrOnly, 2), [{ i: 0, t: '甲' }, { i: 1, t: '乙' }]);

const objMap = '{"0":"甲","1":"乙"}';
eq('数字键对象解析', API.parseItems(objMap, 2), [{ i: 0, t: '甲' }, { i: 1, t: '乙' }]);

eq('垃圾内容返回 null', API.parseItems('对不起，我无法完成。', 2), null);
eq('空字符串返回 null', API.parseItems('', 2), null);

const halfMissing = JSON.stringify({ items: [{ i: 0, t: '只有一条' }] });
eq('漏译过半判定失败以触发重试', API.parseItems(halfMissing, 10), null);

const altKeys = JSON.stringify({ items: [{ index: 0, translation: '甲' }, { index: 1, translation: '乙' }] });
eq('兼容 index/translation 字段', API.parseItems(altKeys, 2), [{ i: 0, t: '甲' }, { i: 1, t: '乙' }]);

const reordered = JSON.stringify({ items: [{ i: 1, t: 'B' }, { i: 0, t: 'A' }] });
eq('乱序按 i 还原', API.parseItems(reordered, 2), [{ i: 1, t: 'B' }, { i: 0, t: 'A' }]);

/* ------------------------------------------------------------------ */

console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败明细：');
  failures.forEach((f) => console.log(' - ' + f));
  process.exit(1);
}
