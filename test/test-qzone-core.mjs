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
