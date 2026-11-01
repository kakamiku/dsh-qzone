/**
 * dsh-qzone/sources.js 的零依赖自测。
 *
 * 跑法：`node test-sources.mjs`
 * 每条断言打印 ok / FAIL，最后给通过数。
 *
 * 不引任何第三方包：只用 node 内置（node:fs / node:os / node:path / node:url / node:assert）。
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// 找到被测模块
// ---------------------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [
  resolve(HERE, '../../../../.dsh/profiles/desktop/local-plugins/dsh-qzone/sources.js'),
  'C:/Users/Lenovo/.dsh/profiles/desktop/local-plugins/dsh-qzone/sources.js',
];
const SOURCES_PATH = CANDIDATES.find((p) => existsSync(p));
if (SOURCES_PATH === undefined) {
  console.error('FAIL - 找不到 sources.js（试过：' + CANDIDATES.join(' , ') + '）');
  process.exit(1);
}
const { DEFAULT_NEWS_FEEDS, collectNewsMaterial, pickLocalImage } = await import(pathToFileURL(SOURCES_PATH).href);

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

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('ok   - ' + name);
  } catch (err) {
    failed += 1;
    failures.push(name);
    console.log('FAIL - ' + name + '  ::  ' + (err && err.message ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------
// 测试用的假 fetch / 假 feed
// ---------------------------------------------------------------------------

/** 造一个 Response 一样的对象。 */
function fakeResponse(text, ok = true, status = 200) {
  return {
    ok,
    status,
    headers: { get: () => 'application/rss+xml; charset=utf-8' },
    text: async () => text,
  };
}

/**
 * 假 fetch：urls → 字符串（正文）/ Error（抛错）/ 函数（自定义响应）。
 */
function mockFetch(table) {
  return async (url) => {
    const entry = table[String(url)];
    if (entry === undefined) throw new Error('mock 没有这个 url: ' + url);
    if (entry instanceof Error) throw entry;
    if (typeof entry === 'function') return entry(String(url));
    return fakeResponse(String(entry));
  };
}

const FEED_A = { id: 'a', name: '测试源', url: 'https://example.com/a.xml', kind: 'rss' };
const FEED_B = { id: 'b', name: '另一个源', url: 'https://example.com/b.xml', kind: 'rss' };
const FEED_BAD = { id: 'bad', name: '坏源', url: 'https://example.com/bad.xml', kind: 'rss' };

/** 一条正常的 RSS。 */
const RSS_NORMAL = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>测试源</title>
    <item>
      <title><![CDATA[国产大模型开源新进展]]></title>
      <link>https://example.com/news/1</link>
      <pubDate>Sun, 01 Nov 2026 10:00:00 +0800</pubDate>
      <description><![CDATA[<p>今天发布了一个新版本，推理速度提升明显。</p>]]></description>
    </item>
    <item>
      <title><![CDATA[第二条只有标题没有摘要]]></title>
      <link>https://example.com/news/2</link>
      <pubDate>Sun, 01 Nov 2026 09:00:00 +0800</pubDate>
    </item>
  </channel>
</rss>`;

/** 同一条新闻在一个 feed 里出现两次（标题一样，链接不一样）。 */
const RSS_DUP = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>同一条新闻</title>
    <link>https://example.com/dup/1</link>
    <pubDate>Sun, 01 Nov 2026 10:00:00 +0800</pubDate>
    <description>第一次出现</description>
  </item>
  <item>
    <title>同一条新闻</title>
    <link>https://example.com/dup/2</link>
    <pubDate>Sun, 01 Nov 2026 08:00:00 +0800</pubDate>
    <description>第二次出现</description>
  </item>
</channel></rss>`;

/** 广告条目 + 一条正常条目。 */
const RSS_AD = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>广告｜限时优惠全场五折</title>
    <link>https://example.com/ad/1</link>
    <pubDate>Sun, 01 Nov 2026 11:00:00 +0800</pubDate>
    <description>扫码进群领取优惠券</description>
  </item>
  <item>
    <title>正经的一条新闻</title>
    <link>https://example.com/ok/1</link>
    <pubDate>Sun, 01 Nov 2026 07:00:00 +0800</pubDate>
    <description>这条应该留下</description>
  </item>
</channel></rss>`;

/** 时间乱序的 RSS（用来验证倒序）。 */
const RSS_UNSORTED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item><title>旧的那条新闻</title><link>https://example.com/o/1</link><pubDate>Sun, 01 Nov 2026 06:00:00 +0800</pubDate></item>
  <item><title>新的那条新闻</title><link>https://example.com/n/1</link><pubDate>Sun, 01 Nov 2026 12:00:00 +0800</pubDate></item>
  <item><title>中间那条新闻</title><link>https://example.com/m/1</link><pubDate>Sun, 01 Nov 2026 09:00:00 +0800</pubDate></item>
</channel></rss>`;

/**
 * 用来测偏好的 RSS：三条新闻，时间新→旧，但「喜欢」的那条在**摘要**里，
 * 「讨厌」的那条在**标题**里 —— 标题和摘要拼起来一起匹配。
 */
const RSS_PREFS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>最新但我不爱看的那条</title>
    <link>https://example.com/p/1</link>
    <pubDate>Sun, 01 Nov 2026 12:00:00 +0800</pubDate>
    <description>这条讲的是娱乐八卦，跟我没关系</description>
  </item>
  <item>
    <title>中间那条普普通通</title>
    <link>https://example.com/p/2</link>
    <pubDate>Sun, 01 Nov 2026 09:00:00 +0800</pubDate>
    <description>中规中矩的一条消息</description>
  </item>
  <item>
    <title>最旧但我最爱看的那条</title>
    <link>https://example.com/p/3</link>
    <pubDate>Sun, 01 Nov 2026 06:00:00 +0800</pubDate>
    <description>这条讲的是 AI 大模型和推理加速</description>
  </item>
</channel></rss>`;

/** 完全不是 XML 的东西。 */
const NOT_XML = '<html><head><title>404</title></head><body>页面不存在</body></html>';

// ===========================================================================
// 一、collectNewsMaterial
// ===========================================================================

console.log('--- collectNewsMaterial ---');

await checkAsync('坏 XML：返回空结果，不抛异常', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': NOT_XML }),
  });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('坏 XML：feed 整体炸掉（fetch 抛异常）也返回空，不抛', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_BAD],
    fetchImpl: mockFetch({ 'https://example.com/bad.xml': new Error('boom') }),
  });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('HTTP 不 ok 的响应被跳过', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': () => fakeResponse('nope', false, 500) }),
  });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('解析出 title / summary / url / 发布时间 / 来源', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_NORMAL }),
  });
  assert.equal(res.items.length, 2);
  const first = res.items[0];
  assert.equal(first.title, '国产大模型开源新进展');
  assert.equal(first.summary, '今天发布了一个新版本，推理速度提升明显。');
  assert.equal(first.url, 'https://example.com/news/1');
  assert.equal(first.source, '测试源');
  assert.equal(first.publishedAt, '2026-11-01T02:00:00.000Z');
  // 摘要里的 HTML 标签要剥干净
  assert.ok(!first.summary.includes('<'), '摘要里不该有标签：' + first.summary);
  // 没有摘要的条目，摘要就是空串（不是 undefined）
  assert.equal(res.items[1].summary, '');
});

await checkAsync('lines 是中文短句：新闻：标题（来源），带摘要，每条 <= 80 字', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_NORMAL }),
  });
  assert.equal(res.lines.length, res.items.length);
  for (const line of res.lines) {
    assert.ok(line.startsWith('新闻：'), '应以「新闻：」开头：' + line);
    assert.ok(line.includes('（测试源）'), '应带来源：' + line);
    assert.ok(line.length <= 80, '太长（' + line.length + '）：' + line);
  }
  assert.ok(res.lines[0].includes('今天发布了一个新版本'), '有摘要就带上：' + res.lines[0]);
});

await checkAsync('同一个 feed 里重复的标题被去掉', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_DUP }),
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, '同一条新闻');
  assert.equal(res.lines.length, 1);
});

await checkAsync('明显的广告条目被过滤', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_AD }),
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, '正经的一条新闻');
});

await checkAsync('limit 生效（limit=1 只留一条，lines 也只一条）', async () => {
  const res = await collectNewsMaterial({
    limit: 1,
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_NORMAL }),
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.lines.length, 1);
});

await checkAsync('items 按发布时间倒序', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_UNSORTED }),
  });
  assert.deepEqual(res.items.map((i) => i.title), ['新的那条新闻', '中间那条新闻', '旧的那条新闻']);
});

await checkAsync('某个 feed 抛错，不影响其它 feed', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_BAD, FEED_A],
    fetchImpl: mockFetch({
      'https://example.com/bad.xml': new Error('这个源挂了'),
      'https://example.com/a.xml': RSS_NORMAL,
    }),
  });
  assert.equal(res.items.length, 2);
  assert.ok(res.items.every((i) => i.source === '测试源'));
  assert.equal(res.lines.length, 2);
});

await checkAsync('全部 feed 抛错 → 返回 { lines: [], items: [] }', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_BAD, { id: 'c', name: '也坏', url: 'https://example.com/c.xml', kind: 'rss' }],
    fetchImpl: mockFetch({
      'https://example.com/bad.xml': new Error('炸了'),
      'https://example.com/c.xml': new Error('也炸了'),
    }),
  });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('fetch 同步抛异常也不炸', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: () => {
      throw new Error('同步就炸了');
    },
  });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('两个 feed 的重复标题只留一条', async () => {
  const res = await collectNewsMaterial({
    feeds: [FEED_A, FEED_B],
    fetchImpl: mockFetch({
      'https://example.com/a.xml': RSS_NORMAL,
      'https://example.com/b.xml': RSS_NORMAL,
    }),
  });
  assert.equal(res.items.length, 2, '两条新闻各出现两次 = 4 条，去重后 2 条');
});

await checkAsync('没有 feeds / fetchImpl 不存在时也不抛', async () => {
  const res = await collectNewsMaterial({ feeds: [], fetchImpl: mockFetch({}) });
  assert.deepEqual(res, { lines: [], items: [] });
});

await checkAsync('JSON feed 也能解析（kind=json）', async () => {
  const feed = { id: 'j', name: 'JSON 源', url: 'https://example.com/j.json', kind: 'json' };
  const payload = JSON.stringify({
    items: [
      { title: 'JSON 里的标题', description: 'JSON 里的摘要', url: 'https://example.com/j/1', publishedAt: '2026-11-01T01:00:00.000Z' },
    ],
  });
  const res = await collectNewsMaterial({
    feeds: [feed],
    fetchImpl: mockFetch({ 'https://example.com/j.json': payload }),
  });
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].title, 'JSON 里的标题');
  assert.equal(res.items[0].summary, 'JSON 里的摘要');
  assert.equal(res.items[0].url, 'https://example.com/j/1');
  assert.equal(res.items[0].source, 'JSON 源');
});

// ===========================================================================
// 一之二、偏好（preferences）：筛选 + 打分排序
// ===========================================================================

console.log('');
console.log('--- preferences（偏好过滤） ---');

/** 用 RSS_PREFS 跑一次 collectNewsMaterial。 */
function collectWithPrefs(preferences) {
  return collectNewsMaterial({
    feeds: [FEED_A],
    fetchImpl: mockFetch({ 'https://example.com/a.xml': RSS_PREFS }),
    preferences,
  });
}

await checkAsync('dislike 命中的条目被丢掉（不进 items 也不进 lines）', async () => {
  const res = await collectWithPrefs({ dislike: ['娱乐八卦'] });
  assert.equal(res.items.length, 2, '应该剩两条：' + res.items.map((i) => i.title).join(' | '));
  assert.ok(!res.items.some((i) => i.title.includes('娱乐八卦那条')), '不该留着被讨厌的那条');
  assert.ok(!res.items.some((i) => i.title.includes('我不爱看')), '不该留着被讨厌的那条');
  assert.equal(res.lines.length, 2);
  assert.ok(!res.lines.some((l) => l.includes('我不爱看')), 'lines 里也不该有：' + res.lines.join(' | '));
});

await checkAsync('dislike 命中摘要也算命中（匹配文本 = 标题 + 摘要）', async () => {
  const res = await collectWithPrefs({ dislike: ['娱乐八卦'] });
  assert.ok(!res.items.some((i) => i.summary.includes('娱乐八卦')), '摘要命中也要丢');
});

await checkAsync('like 命中的条目排到前面', async () => {
  const res = await collectWithPrefs({ like: ['大模型'] });
  assert.deepEqual(
    res.items.map((i) => i.title),
    ['最旧但我最爱看的那条', '最新但我不爱看的那条', '中间那条普普通通'],
    '命中 like 的那条应该排第一',
  );
});

await checkAsync('keywords 命中的条目也排前面', async () => {
  const res = await collectWithPrefs({ keywords: ['推理加速'] });
  assert.equal(res.items[0].title, '最旧但我最爱看的那条');
});

await checkAsync('得分高的排前面（同分仍按发布时间倒序）', async () => {
  // 这条命中两个不同的关键词（得分 2），其它命中一个（得分 1）或零个（得分 0）
  const res = await collectWithPrefs({ like: ['大模型', '推理加速', 'AI'] });
  assert.equal(res.items[0].title, '最旧但我最爱看的那条', '命中 2 个词的应该第一：' + res.items.map((i) => i.title).join(' | '));
  assert.equal(res.items[1].title, '最新但我不爱看的那条', '剩下的按时间倒序');
  assert.equal(res.items[2].title, '中间那条普普通通');
});

await checkAsync('同一个关键词重复出现只算一次分', async () => {
  const res = await collectWithPrefs({ like: ['大模型', '大模型', ' 大模型 '] });
  assert.equal(res.items[0].title, '最旧但我最爱看的那条');
  // 「大模型」只算 1 分，所以它仍然是第一（命中 1 分 > 命中 0 分）
  assert.equal(res.items.filter((i) => i.title.includes('最爱看')).length, 1);
});

await checkAsync('like 和 keywords 里的同一个词只算一次分', async () => {
  const res = await collectWithPrefs({ like: ['大模型'], keywords: ['大模型'] });
  assert.equal(res.items[0].title, '最旧但我最爱看的那条');
  assert.equal(res.items.length, 3);
});

await checkAsync('preferences 没传 / 三个数组全空 → 排序跟以前一样（只按时间倒序）', async () => {
  const none = await collectWithPrefs(undefined);
  const empty = await collectWithPrefs({});
  const blank = await collectWithPrefs({ like: [], dislike: [], keywords: [] });
  const expected = ['最新但我不爱看的那条', '中间那条普普通通', '最旧但我最爱看的那条'];
  assert.deepEqual(none.items.map((i) => i.title), expected, '没传 preferences');
  assert.deepEqual(empty.items.map((i) => i.title), expected, '空对象');
  assert.deepEqual(blank.items.map((i) => i.title), expected, '三个空数组');
});

await checkAsync('关键词忽略大小写', async () => {
  const lower = await collectWithPrefs({ like: ['大模型'] });
  const upper = await collectWithPrefs({ like: ['AI'.toLowerCase(), '推理加速'.toUpperCase()] });
  assert.equal(lower.items[0].title, '最旧但我最爱看的那条');
  assert.equal(upper.items[0].title, '最旧但我最爱看的那条', '大小写不该影响匹配');
});

await checkAsync('关键词前后空格被 trim 掉', async () => {
  const res = await collectWithPrefs({ like: ['  大模型  '], dislike: ['  娱乐八卦  '] });
  assert.equal(res.items[0].title, '最旧但我最爱看的那条', '空格不该影响匹配');
  assert.equal(res.items.length, 2, 'dislike 也要能 trim：' + res.items.map((i) => i.title).join(' | '));
});

await checkAsync('空关键词 / 非字符串关键词被忽略，不炸', async () => {
  const res = await collectWithPrefs({
    like: ['', '   ', null, undefined, 123, {}, ['嵌套'], '大模型'],
    dislike: ['', null, 42],
  });
  assert.equal(res.items.length, 3, '不该误伤条目');
  assert.equal(res.items[0].title, '最旧但我最爱看的那条');
});

await checkAsync('preferences 传成奇怪的东西也不炸', async () => {
  for (const prefs of [null, '字符串', 42, [], { like: '不是数组' }, { dislike: 123 }]) {
    const res = await collectWithPrefs(prefs);
    assert.equal(res.items.length, 3, '传 ' + JSON.stringify(prefs) + ' 应该什么都不做');
    assert.equal(res.items[0].title, '最新但我不爱看的那条', '传 ' + JSON.stringify(prefs) + ' 应该只按时间倒序');
  }
});

await checkAsync('dislike + like 可以一起用（先丢再排）', async () => {
  const res = await collectWithPrefs({ dislike: ['娱乐八卦'], like: ['大模型'] });
  assert.deepEqual(res.items.map((i) => i.title), ['最旧但我最爱看的那条', '中间那条普普通通']);
  assert.equal(res.lines.length, 2);
});

await checkAsync('偏好只影响 items / lines，不影响条目的字段形状', async () => {
  const res = await collectWithPrefs({ like: ['大模型'] });
  for (const item of res.items) {
    assert.deepEqual(Object.keys(item).sort(), ['publishedAt', 'source', 'summary', 'title', 'url'].sort(),
      'items 的字段不该多出 score 之类：' + Object.keys(item).join(','));
  }
});

// ===========================================================================
// 二、DEFAULT_NEWS_FEEDS
// ===========================================================================

console.log('');
console.log('--- DEFAULT_NEWS_FEEDS ---');

check('默认源数量在 4~6 之间', () => {
  assert.ok(Array.isArray(DEFAULT_NEWS_FEEDS));
  assert.ok(DEFAULT_NEWS_FEEDS.length >= 4 && DEFAULT_NEWS_FEEDS.length <= 6,
    '实际 ' + DEFAULT_NEWS_FEEDS.length + ' 个');
});

check('每个默认源都有 id / name / url / kind=rss', () => {
  for (const feed of DEFAULT_NEWS_FEEDS) {
    assert.equal(typeof feed.id, 'string');
    assert.ok(feed.id.trim() !== '');
    assert.equal(typeof feed.name, 'string');
    assert.ok(feed.name.trim() !== '');
    assert.equal(feed.kind, 'rss');
    assert.ok(/^https?:\/\//.test(feed.url), 'url 得是 http(s)：' + feed.url);
  }
});

check('默认源的 id 不重复', () => {
  const ids = DEFAULT_NEWS_FEEDS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
});

// ===========================================================================
// 三、pickLocalImage
// ===========================================================================

console.log('');
console.log('--- pickLocalImage ---');

const TMP_ROOT = mkdtempSync(resolve(tmpdir(), 'qzone-src-test-'));
/** 建一个目录，返回绝对路径。 */
function makeDir(...parts) {
  const dir = resolve(TMP_ROOT, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** 在目录里放一个（内容无所谓的）假图片文件。 */
function putFile(dir, name) {
  const file = resolve(dir, name);
  writeFileSync(file, 'fake-image-bytes', 'utf8');
  return file;
}

try {
  check('目录不存在 → null', () => {
    assert.equal(pickLocalImage(resolve(TMP_ROOT, 'nope-not-here')), null);
  });

  check('空目录 → null', () => {
    const dir = makeDir('empty');
    assert.equal(pickLocalImage(dir), null);
  });

  check('有图 → 返回绝对路径，在该目录下，扩展名对得上', () => {
    const dir = makeDir('withimg');
    const img = putFile(dir, 'cat.PNG');
    const picked = pickLocalImage(dir);
    assert.ok(picked !== null, '应该挑到一张图');
    assert.equal(picked, img);
    assert.ok(picked.startsWith(dir), '应该在目录下：' + picked);
    // 大写扩展名（.PNG）也要认
    assert.ok(picked.toLowerCase().endsWith('.png'), '扩展名对得上：' + picked);
  });

  check('子目录里的图也能找到', () => {
    const dir = makeDir('nested');
    const sub = makeDir('nested', 'sub');
    const img = putFile(sub, 'dog.jpg');
    const picked = pickLocalImage(dir);
    assert.ok(picked !== null, '应该挑到图');
    assert.equal(picked, img);
    assert.ok(picked.startsWith(dir));
  });

  check('再往下两层（dir/a/b）里的图也能找到', () => {
    const dir = makeDir('deep');
    const deep = makeDir('deep', 'a', 'b');
    const img = putFile(deep, 'bird.webp');
    const picked = pickLocalImage(dir);
    assert.equal(picked, img);
  });

  check('传一个非目录路径（普通文件）→ null', () => {
    const dir = makeDir('plainfile');
    const file = putFile(dir, 'notadir.txt');
    assert.equal(pickLocalImage(file), null);
  });

  check('空字符串 / null / undefined → null', () => {
    assert.equal(pickLocalImage(''), null);
    assert.equal(pickLocalImage('   '), null);
    assert.equal(pickLocalImage(null), null);
    assert.equal(pickLocalImage(undefined), null);
  });

  check('只有非图片文件 → null', () => {
    const dir = makeDir('noimg');
    putFile(dir, 'readme.txt');
    putFile(dir, 'note.md');
    assert.equal(pickLocalImage(dir), null);
  });

  check('非图片和图片混在一起 → 只挑图片', () => {
    const dir = makeDir('mixed');
    putFile(dir, 'a.txt');
    const img = putFile(dir, 'b.jpeg');
    const picked = pickLocalImage(dir);
    assert.equal(picked, img);
    assert.ok(!picked.endsWith('.txt'));
  });

  check('自定义 extensions 生效（只认 .bmp）', () => {
    const dir = makeDir('ext');
    putFile(dir, 'x.png');
    const bmp = putFile(dir, 'y.bmp');
    const picked = pickLocalImage(dir, { extensions: ['.bmp'] });
    assert.equal(picked, bmp);
  });

  check('limit 生效（limit=1 时最多给一张）', () => {
    const dir = makeDir('limited');
    putFile(dir, '1.png');
    putFile(dir, '2.png');
    putFile(dir, '3.png');
    const picked = pickLocalImage(dir, { limit: 1 });
    assert.ok(picked !== null);
    assert.ok(['1.png', '2.png', '3.png'].some((n) => picked.endsWith(n)), picked);
  });

  check('相对路径也能用（返回绝对路径）', () => {
    const dir = makeDir('relative');
    putFile(dir, 'rel.png');
    const picked = pickLocalImage(dir);
    assert.ok(picked !== null);
    assert.ok(resolve(picked) === picked, '应该是绝对路径：' + picked);
  });
} finally {
  try {
    rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

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
