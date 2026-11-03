/**
 * dsh-qzone 主文件（index.js）里纯函数的零依赖自测。
 *
 * 跑法：`node test-qzone-core.mjs`
 * 每条断言打印 ok / FAIL，最后给通过数。
 *
 * 只测 `export const testing` 里导出来的纯函数（不碰网络、不碰 QQ、不写状态文件）：
 *   - parseScheduleTimes(config)  把「发布时间」配置解析成升序去重的 HH:MM 列表
 *   - cnMinuteOfDay(ms)           给 UTC 毫秒戳，返回 Asia/Shanghai 的 HH:MM
 *
 * 不引任何第三方包：只用 node 内置（node:assert / node:url）。
 *
 * ⚠️ index.js 里 import 了 node:sqlite，Node 会打一条 ExperimentalWarning（stderr），
 *    那是 Node 自己的提示，不是测试失败。
 */
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// ---------------------------------------------------------------------------
// 找到被测模块
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  resolve(HERE, '../../../../.dsh/profiles/desktop/local-plugins/dsh-qzone/index.js'),
  'C:/Users/Lenovo/.dsh/profiles/desktop/local-plugins/dsh-qzone/index.js',
];
const INDEX_PATH = CANDIDATES.find((p) => existsSync(p));
if (INDEX_PATH === undefined) {
  console.error('FAIL - 找不到 index.js（试过：' + CANDIDATES.join(' , ') + '）');
  process.exit(1);
}
const { testing } = await import(pathToFileURL(INDEX_PATH).href);

// ---------------------------------------------------------------------------
// 迷你断言器
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok   - ' + name);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log('FAIL - ' + name + '  ::  ' + (err && err.message ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------
// 前置检查
// ---------------------------------------------------------------------------
console.log('--- 前置检查 ---');

check('index.js 导出了 testing.parseScheduleTimes / testing.cnMinuteOfDay', () => {
  assert.ok(testing !== null && typeof testing === 'object', 'testing 得是对象');
  assert.equal(typeof testing.parseScheduleTimes, 'function');
  assert.equal(typeof testing.cnMinuteOfDay, 'function');
});

// ===========================================================================
// 一、parseScheduleTimes
// ===========================================================================

console.log('');
console.log('--- testing.parseScheduleTimes ---');

check('scheduleAt 三个时刻：按升序返回', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['10:00', '14:37', '22:05'] });
  assert.deepEqual(out, ['10:00', '14:37', '22:05']);
});

check('scheduleAt 输入乱序也按升序返回', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['22:05', '10:00', '14:37'] });
  assert.deepEqual(out, ['10:00', '14:37', '22:05']);
});

check('不补零的 "9:05" → "09:05"', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['9:05'] });
  assert.deepEqual(out, ['09:05']);
});

check('重复的 "10:00" 去重成一个', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['10:00', '10:00'] });
  assert.deepEqual(out, ['10:00']);
});

check('非法的 "25:00" 被丢掉', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['25:00'] });
  assert.deepEqual(out, []);
});

check('非法的 "10:70" 被丢掉', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['10:70'] });
  assert.deepEqual(out, []);
});

check('非法的 "abc" 被丢掉', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['abc'] });
  assert.deepEqual(out, []);
});

check('非法项和合法项混着 → 只留合法的', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['25:00', '09:30', 'abc', '10:70'] });
  assert.deepEqual(out, ['09:30']);
});

check('老配置 scheduleHours:[10,14] → ["10:00","14:00"]', () => {
  const out = testing.parseScheduleTimes({ scheduleHours: [10, 14] });
  assert.deepEqual(out, ['10:00', '14:00']);
});

check('scheduleAt 为空 → 回落老的 scheduleHours:[10]', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: [], scheduleHours: [10] });
  assert.deepEqual(out, ['10:00']);
});

check('scheduleAt 里的项全非法 → 也回落老的 scheduleHours', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['abc'], scheduleHours: [10] });
  assert.deepEqual(out, ['10:00']);
});

check('scheduleAt 有合法项 → 不看 scheduleHours（新的优先）', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['14:37'], scheduleHours: [10] });
  assert.deepEqual(out, ['14:37']);
});

check('空配置 {} → []', () => {
  const out = testing.parseScheduleTimes({});
  assert.deepEqual(out, []);
});

check('undefined / null 配置 → []', () => {
  assert.deepEqual(testing.parseScheduleTimes(undefined), []);
  assert.deepEqual(testing.parseScheduleTimes(null), []);
});

check('scheduleAt 不是数组 → []', () => {
  assert.deepEqual(testing.parseScheduleTimes({ scheduleAt: '10:00' }), []);
  assert.deepEqual(testing.parseScheduleTimes({ scheduleAt: 10 }), []);
});

check('全角冒号 "10：00" 也认', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['10：00'] });
  assert.deepEqual(out, ['10:00']);
});

check('带空格的 "10 : 00" 也认', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['10 : 00'] });
  assert.deepEqual(out, ['10:00']);
});

check('Volatile 配置（{ get() } 形状）也能读', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: { get: () => ['10:00', '22:05'] } });
  assert.deepEqual(out, ['10:00', '22:05']);
});

check('结果全是 HH:MM 的形状（正则全过）', () => {
  const out = testing.parseScheduleTimes({ scheduleAt: ['0:0', '23:59'] });
  for (const item of out) {
    assert.match(item, /^([01]\d|2[0-3]):[0-5]\d$/, '形状不对：' + item);
  }
  assert.deepEqual(out, ['00:00', '23:59']);
});

// ===========================================================================
// 二、cnMinuteOfDay
// ===========================================================================

console.log('');
console.log('--- testing.cnMinuteOfDay ---');

check('Date.UTC(2026,0,1,4,30) → "12:30"（Asia/Shanghai = UTC+8）', () => {
  const ms = Date.UTC(2026, 0, 1, 4, 30);
  assert.equal(testing.cnMinuteOfDay(ms), '12:30');
});

check('UTC 16:30 → "00:30"（跨到第二天，分钟照旧）', () => {
  const ms = Date.UTC(2026, 0, 1, 16, 30);
  assert.equal(testing.cnMinuteOfDay(ms), '00:30');
});

check('UTC 15:59 → "23:59"（当天最后一分钟）', () => {
  const ms = Date.UTC(2026, 0, 1, 15, 59);
  assert.equal(testing.cnMinuteOfDay(ms), '23:59');
});

check('UTC 16:00 → "00:00"（跨天那一刻）', () => {
  const ms = Date.UTC(2026, 0, 1, 16, 0);
  assert.equal(testing.cnMinuteOfDay(ms), '00:00');
});

check('带秒和毫秒也不影响（只看时:分）', () => {
  const ms = Date.UTC(2026, 0, 1, 4, 30, 45, 123);
  assert.equal(testing.cnMinuteOfDay(ms), '12:30');
});

check('返回值形如 HH:MM（正则全过）', () => {
  const out = testing.cnMinuteOfDay(Date.UTC(2026, 5, 15, 3, 7));
  assert.match(out, /^([01]\d|2[0-3]):[0-5]\d$/, '形状不对：' + out);
  assert.equal(out, '11:07');
});

check('不传参数时用当前时间（不抛，返回 HH:MM）', () => {
  const out = testing.cnMinuteOfDay();
  assert.match(out, /^([01]\d|2[0-3]):[0-5]\d$/, '形状不对：' + out);
});

// ===========================================================================
// 三、parseSocialTimes（好友动态定点互动：精确到分钟）
// ===========================================================================

console.log('');
console.log('--- testing.parseSocialTimes ---');

check('index.js 导出了 testing.parseSocialTimes', () => {
  assert.equal(typeof testing.parseSocialTimes, 'function');
});

check('socialAt 三个时刻：按升序返回', () => {
  const out = testing.parseSocialTimes({ socialAt: ['11:07', '17:23', '21:41'] });
  assert.deepEqual(out, ['11:07', '17:23', '21:41']);
});

check('socialAt 输入乱序也按升序返回', () => {
  const out = testing.parseSocialTimes({ socialAt: ['21:41', '11:07'] });
  assert.deepEqual(out, ['11:07', '21:41']);
});

check('socialAt 重复的 "17:23" 去重成一个', () => {
  const out = testing.parseSocialTimes({ socialAt: ['17:23', '17:23'] });
  assert.deepEqual(out, ['17:23']);
});

check('socialAt 非法的 "11:99" 被丢掉', () => {
  const out = testing.parseSocialTimes({ socialAt: ['11:99'] });
  assert.deepEqual(out, []);
});

check('socialAt 非法的 "25:00" 被丢掉', () => {
  const out = testing.parseSocialTimes({ socialAt: ['25:00'] });
  assert.deepEqual(out, []);
});

check('老配置 socialHours:[11,17,21] → ["11:00","17:00","21:00"]', () => {
  const out = testing.parseSocialTimes({ socialHours: [11, 17, 21] });
  assert.deepEqual(out, ['11:00', '17:00', '21:00']);
});

check('socialAt 为空 → 回落老的 socialHours', () => {
  const out = testing.parseSocialTimes({ socialAt: [], socialHours: [12] });
  assert.deepEqual(out, ['12:00']);
});

check('socialAt 有合法项 → 不看 socialHours（新的优先）', () => {
  const out = testing.parseSocialTimes({ socialAt: ['18:30'], socialHours: [12] });
  assert.deepEqual(out, ['18:30']);
});

check('全角冒号 / 带空格也认', () => {
  const out = testing.parseSocialTimes({ socialAt: ['11：07', '17 : 23'] });
  assert.deepEqual(out, ['11:07', '17:23']);
});

check('空配置 {} → []', () => {
  assert.deepEqual(testing.parseSocialTimes({}), []);
});

check('socialAt 不是数组 → []', () => {
  assert.deepEqual(testing.parseSocialTimes({ socialAt: '11:00' }), []);
});

check('结果全是 HH:MM 的形状（正则全过）', () => {
  const out = testing.parseSocialTimes({ socialAt: ['0:0', '23:59'] });
  for (const item of out) {
    assert.match(item, /^([01]\d|2[0-3]):[0-5]\d$/, '形状不对：' + item);
  }
  assert.deepEqual(out, ['00:00', '23:59']);
});

// ===========================================================================
// 三、buildWriterPrompt（人设可替换）
// ===========================================================================

console.log('');
console.log('--- buildWriterPrompt（人设） ---');

const SOURCE = { kind: 'bili' };
const MATERIAL = ['【某视频】标题：今天的一天'];

check('留空人设 → 用默认的「大肥鱼」', () => {
  const prompt = testing.buildWriterPrompt(SOURCE, MATERIAL, '');
  assert.ok(prompt.includes('大肥鱼'), '默认人设应该在提示里');
  assert.ok(prompt.includes('【素材】'), '素材段应该在');
});

check('填了自己的人设 → 整段替换掉默认人设', () => {
  const mine = '你是一只柯基，短腿，嘴硬。';
  const prompt = testing.buildWriterPrompt(SOURCE, MATERIAL, '', mine);
  assert.ok(prompt.includes(mine), '自己人设应该在');
  assert.ok(!prompt.includes('大肥鱼'), '默认人设不该再出现');
  assert.ok(!prompt.includes('鲸鱼'), '默认人设的词不该残留');
});

check('自己人设 → 规则里不再说「大肥鱼的味道」', () => {
  const prompt = testing.buildWriterPrompt(SOURCE, MATERIAL, '', '你是一只柯基，短腿，嘴硬。');
  assert.ok(!prompt.includes('大肥鱼的味道'));
});

check('主人特别要求照样拼在最后', () => {
  const prompt = testing.buildWriterPrompt(SOURCE, MATERIAL, '别提工作', '你是一只柯基。');
  assert.ok(prompt.includes('【主人的特别要求】'));
  assert.ok(prompt.indexOf('【主人的特别要求】') > prompt.indexOf('【素材】'), '特别要求应该在素材后面');
});

// ===========================================================================
// 汇总
// ===========================================================================

console.log('');
console.log('通过 ' + passed + ' 条，失败 ' + failed + ' 条。');
if (failed > 0) {
  console.log('失败的用例：');
  for (const name of failures) console.log('  - ' + name);
  process.exit(1);
}
console.log('全部通过 ✅');
