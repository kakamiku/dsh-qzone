/**
 * dsh-qzone —— 素材来源扩展：新闻源 + 本地图片文件夹。
 *
 * 干什么
 * ------
 * dsh-qzone 每天从「素材来源」挑一份素材，交给模型写成 QQ 空间动态。原先只有两个来源：
 *   A. chat —— 当天的 QQ 私聊 / 群聊
 *   B. bili —— 当天 dsh-bili-whale 刷到的 B 站视频（**依赖 dsh-bili-whale 插件**）
 *
 * 这个文件补上两个「没有别的插件也能用」的来源：
 *   C. news —— 从网上拉新闻（RSS / Atom / JSON feed），让**没装 dsh-bili-whale** 的人
 *      也能每天接触到新知识。
 *   D. 本地图片文件夹 —— 没装 dsh-meme 插件时，从用户本地的图片文件夹里随机挑一张配图。
 *
 * 约束（重要）
 * ------------
 *   - **零运行时依赖**：只用 Node 内置（node:fs / node:path）+ 全局 fetch / AbortSignal，
 *     不引任何第三方包（RSS 解析是自己写的正则，不引 XML 解析器）。
 *   - **不抛异常**：`collectNewsMaterial` / `pickLocalImage` 内部全程兜底。
 *     素材只是锦上添花，网络挂了 / 目录没了，都不应该把整个插件带崩。
 *
 * 导出接口
 * --------
 *   export const DEFAULT_NEWS_FEEDS
 *   export async function collectNewsMaterial(options = {}) -> { lines, items }
 *   export function pickLocalImage(dir, options = {}) -> string | null
 *
 * @module dsh-qzone/sources
 */

import { readdirSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/**
 * 默认新闻源：**国内可直连**的中文 RSS（2026-11 实测全部 HTTP 200 且内容是新鲜日期）。
 *
 * ⚠️ 不要加人民网 / 新华网 / 新浪科技那几家的老 RSS：它们的 feed 还在线，但内容
 *    冻结在 2022~2025 年（人民网最新一条是 2025-06-05，新华网干脆没有 <pubDate>），
 *    拿来做「今天的新闻」会发一堆陈年旧账。
 *
 * 选源标准：能直连、条目带发布时间、当天就有更新、中文正文。
 */
export const DEFAULT_NEWS_FEEDS = [
  { id: 'chinanews-scroll', name: '中国新闻网', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', kind: 'rss' },
  { id: 'jiemian', name: '界面新闻', url: 'https://a.jiemian.com/index.php?m=article&a=rss', kind: 'rss' },
  { id: '36kr', name: '36氪', url: 'https://36kr.com/feed', kind: 'rss' },
  { id: 'tmtpost', name: '钛媒体', url: 'https://www.tmtpost.com/feed', kind: 'rss' },
  { id: 'ithome', name: 'IT之家', url: 'https://www.ithome.com/rss/', kind: 'rss' },
  { id: 'sspai', name: '少数派', url: 'https://sspai.com/feed', kind: 'rss' },
];

/** 拉 feed 时的请求头（不少国内站点不给默认 UA 会直接 403）。 */
const FEED_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, application/json;q=0.9, */*;q=0.8',
};

/** 单个 feed 最多读多少字节（防个别源返回超大页面）。 */
const MAX_FEED_BYTES = 1024 * 1024;
/** 给模型看的每条素材最长多少字。 */
const MAX_LINE_CHARS = 80;
/** 标题最长多少字（写进 lines 前先收一收）。 */
const MAX_TITLE_CHARS = 36;

/** 明显的广告 / 推广 / 垃圾条目（标题或摘要命中就丢）。 */
const AD_PATTERNS = [
  /广告/, /推广/, /赞助/, /软文/, /招商/, /加盟/, /诚招/, /招聘启事/,
  /优惠/, /促销/, /秒杀/, /折扣/, /券后/, /包邮/, /直降/, /特价/,
  /抢购/, /点击购买/, /立即下单/, /扫码/, /二维码/, /进群/, /加群/, /QQ\s*群/i,
  /关注领取/, /回复领取/, /福利来了/, /限时/,
  /sponsored/i, /advertisement/i, /promotion/i, /coupon/i, /buy now/i,
];

/** 目录扫描时跳过的系统文件。 */
const JUNK_FILES = ['thumbs.db', 'desktop.ini'];

// ---------------------------------------------------------------------------
// 文本处理小工具
// ---------------------------------------------------------------------------

/** HTML 实体解码（顺序有讲究：&amp; 必须最后解）。 */
function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => codePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => codePoint(parseInt(dec, 10)))
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&hellip;/gi, '…')
    .replace(/&mdash;/gi, '—')
    .replace(/&ndash;/gi, '–')
    .replace(/&amp;/gi, '&');
}

/** 数字实体 → 字符（非法码位直接丢掉）。 */
function codePoint(num) {
  if (!Number.isFinite(num) || num < 0 || num > 0x10ffff) return '';
  try {
    return String.fromCodePoint(num);
  } catch {
    return '';
  }
}

/** 去掉 <![CDATA[...]]> 包装。 */
function stripCdata(text) {
  return String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/**
 * 把一段「可能带 HTML」的文本洗成干净的一行。
 * 顺序：先剥标签（描述里常有 <p> <img>），再解实体（少数派把整段 HTML 转义了），最后压空白。
 */
function cleanText(raw) {
  let out = stripCdata(String(raw ?? ''));
  out = out.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  out = out.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  out = out.replace(/<[^>]*>/g, ' ');
  out = decodeEntities(out);
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

/** 压掉多余空白（不剥标签，用于标题这种本来就干净的字段）。 */
function squeeze(raw) {
  return decodeEntities(stripCdata(String(raw ?? ''))).replace(/\s+/g, ' ').trim();
}

/** 标题归一化：去掉标点空白后用于去重比较。 */
function titleKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/[\s·・.,，、。!！?？:：;；"'“”‘’()（）\[\]【】{}<>《》\-—–_|｜/\\+*~`]/g, '');
}

/** 取标签内容（不分大小写，忽略属性）。 */
function tagText(block, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i');
  const m = re.exec(block);
  if (m === null) return '';
  return squeeze(m[1]);
}

/** 取标签的某个属性值（Atom 的 <link href="…"/> 就靠这个）。 */
function tagAttr(block, tag, attr) {
  const re = new RegExp('<' + tag + '\\b[^>]*\\b' + attr + '\\s*=\\s*["\']([^"\']+)["\']', 'i');
  const m = re.exec(block);
  return m === null ? '' : m[1].trim();
}

// ---------------------------------------------------------------------------
// 日期解析
// ---------------------------------------------------------------------------

/** 解析发布时间，返回毫秒时间戳；解析不出来返回 null。 */
function parseDate(raw) {
  const text = squeeze(raw);
  if (text === '') return null;
  // 先走 Date.parse：RFC 822 / ISO 8601 / 纯日期 都能吃
  const direct = Date.parse(text);
  if (Number.isFinite(direct)) return direct;
  // "2026-10-31 09:09:53 +0800" 这类带空格的变体
  const m = /(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{2}:?\d{2})?/.exec(text);
  if (m !== null) {
    const [, y, mo, d, h, mi, s, off] = m;
    const base = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0'));
    if (!Number.isFinite(base)) return null;
    if (off === undefined) return base;
    const sign = off.startsWith('-') ? -1 : 1;
    const digits = off.slice(1).replace(':', '');
    const offsetMs = sign * (Number(digits.slice(0, 2)) * 3600 + Number(digits.slice(2, 4)) * 60) * 1000;
    return base - offsetMs;
  }
  return null;
}

/** 从条目块里挖发布时间（兼容裸日期文本 —— 新华网那种没有 <pubDate> 标签的写法）。 */
function extractDate(block) {
  const candidates = [
    tagText(block, 'pubDate'),
    tagText(block, 'published'),
    tagText(block, 'updated'),
    tagText(block, 'dc:date'),
    tagText(block, 'date'),
  ];
  for (const c of candidates) {
    const ms = parseDate(c);
    if (ms !== null) return ms;
  }
  // 兜底：条目里裸写的 RFC 822 日期
  const bare = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s*\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\s+[\d:]+\s+(?:GMT|UTC|[+-]\d{4})/i.exec(block);
  if (bare !== null) {
    const ms = parseDate(bare[0]);
    if (ms !== null) return ms;
  }
  return null;
}

// ---------------------------------------------------------------------------
// RSS / Atom 解析（自己写的正则解析器，不引 XML 库）
// ---------------------------------------------------------------------------

/**
 * 解析 RSS 2.0 / Atom，返回原始条目数组。
 * @returns {Array<{title:string, summary:string, url:string, publishedMs:number|null}>}
 */
function parseFeedXml(text) {
  const blocks = [];
  const itemRe = /<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = itemRe.exec(text)) !== null) {
    blocks.push(m[2]);
  }
  const out = [];
  for (const block of blocks) {
    const title = cleanText(tagText(block, 'title'));
    const summary = cleanText(
      tagText(block, 'description') !== ''
        ? tagText(block, 'description')
        : (tagText(block, 'summary') !== '' ? tagText(block, 'summary') : tagText(block, 'content')),
    );
    let url = tagAttr(block, 'link', 'href');
    if (url === '') url = tagText(block, 'link');
    if (url === '') url = tagText(block, 'guid');
    const publishedMs = extractDate(block);
    out.push({ title, summary, url: url.trim(), publishedMs });
  }
  return out;
}

/**
 * 解析 JSON feed（常见形状都兜一下：顶层数组 / items / data / stories …）。
 */
function parseFeedJson(text, feedUrl) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  let list = null;
  if (Array.isArray(data)) {
    list = data;
  } else if (data !== null && typeof data === 'object') {
    const keys = ['items', 'data', 'stories', 'results', 'entries', 'articles', 'list', 'feed'];
    for (const key of keys) {
      const value = data[key];
      if (Array.isArray(value)) { list = value; break; }
      if (value !== null && typeof value === 'object') {
        for (const inner of keys) {
          if (Array.isArray(value[inner])) { list = value[inner]; break; }
        }
        if (list !== null) break;
      }
    }
  }
  if (list === null) return [];
  const out = [];
  for (const entry of list) {
    if (entry === null || typeof entry !== 'object') continue;
    const title = cleanText(pickField(entry, ['title', 'name', 'headline', 'subject']));
    const summary = cleanText(pickField(entry, ['summary', 'description', 'abstract', 'excerpt', 'digest', 'content', 'intro']));
    let url = String(pickField(entry, ['url', 'link', 'href', 'permalink', 'guid']) ?? '').trim();
    if (url !== '' && !/^https?:\/\//i.test(url)) {
      try {
        url = new URL(url, feedUrl).href;
      } catch {
        /* 相对地址解析不了就算了 */
      }
    }
    const publishedMs = parseDate(pickField(entry, ['publishedAt', 'published_at', 'pubDate', 'date', 'time', 'created_at', 'updatedAt', 'timestamp']));
    out.push({ title, summary, url, publishedMs });
  }
  return out;
}

/** 从对象里挑第一个非空字段。 */
function pickField(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

/**
 * 抓一个 feed 的正文。**失败就抛**，由调用方兜住（单个 feed 挂掉不影响别人）。
 * @returns {Promise<string>}
 */
async function fetchFeedText(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  timer.unref?.();
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: FEED_HEADERS, redirect: 'follow' });
    if (res === null || typeof res !== 'object') throw new Error('fetch 没有返回 Response');
    if (res.ok === false) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (typeof text !== 'string') throw new Error('Response 没有正文');
    return text.length > MAX_FEED_BYTES ? text.slice(0, MAX_FEED_BYTES) : text;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 新闻素材
// ---------------------------------------------------------------------------

/**
 * 采集新闻素材。
 *
 * @param {object} [options]
 * @param {number} [options.limit=6] 最多留几条
 * @param {Array<{id:string,name:string,url:string,kind:string}>} [options.feeds=DEFAULT_NEWS_FEEDS]
 * @param {number} [options.timeoutMs=8000] 单个 feed 的超时
 * @param {Function} [options.fetchImpl=fetch] 可注入的 fetch（测试用）
 * @param {number} [options.now=Date.now()] 兜底时间戳（feed 没给发布时间时用）
 * @returns {Promise<{lines:string[], items:Array<{title:string,summary:string,url:string,source:string,publishedAt:string}>}>}
 */
export async function collectNewsMaterial(options = {}) {
  const opts = options ?? {};
  const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 6;
  const feeds = Array.isArray(opts.feeds) ? opts.feeds : DEFAULT_NEWS_FEEDS;
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 8000;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null);
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();

  const empty = { lines: [], items: [] };
  if (fetchImpl === null) return empty;

  // 1. 挨个抓（并发），单个失败就跳过 —— **整个函数永远不抛**
  const settled = await Promise.all(
    feeds.map(async (feed) => {
      const url = String(feed?.url ?? '').trim();
      if (url === '') return null;
      try {
        const text = await fetchFeedText(url, { fetchImpl, timeoutMs });
        return { feed, text };
      } catch {
        return null; // 这个源挂了不影响别人
      }
    }),
  );

  // 2. 解析 + 过滤
  const raw = [];
  for (const entry of settled) {
    if (entry === null) continue;
    const { feed, text } = entry;
    const source = String(feed?.name ?? feed?.id ?? '新闻').trim() || '新闻';
    const kind = String(feed?.kind ?? 'rss').toLowerCase();
    let parsed = [];
    try {
      parsed = kind === 'json' ? parseFeedJson(text, String(feed.url)) : parseFeedXml(text);
    } catch {
      parsed = [];
    }
    for (const p of parsed) {
      const title = cleanText(p.title);
      if (title.length < 3) continue;                 // 太短，多半是栏目名/空标题
      if (title.length > 160) continue;               // 太长，多半是整个页面被当成了标题
      if (isAd(title, p.summary)) continue;           // 广告 / 推广
      raw.push({
        title,
        summary: p.summary,
        url: p.url,
        source,
        publishedMs: p.publishedMs ?? now,           // 没给时间就按“现在”排，不至于被砍掉
      });
    }
  }

  // 3. 同标题（同链接）去重
  const seenTitle = new Set();
  const seenUrl = new Set();
  const unique = [];
  for (const item of raw) {
    const key = titleKey(item.title);
    if (key === '') continue;
    if (seenTitle.has(key)) continue;
    if (item.url !== '') {
      if (seenUrl.has(item.url)) continue;
      seenUrl.add(item.url);
    }
    seenTitle.add(key);
    unique.push(item);
  }

  // 4. 按发布时间倒序（新的在前），再截断
  unique.sort((a, b) => b.publishedMs - a.publishedMs);
  const picked = unique.slice(0, limit);

  // 5. 产出给模型看的短句 + 结构化条目
  const items = picked.map((item) => ({
    title: item.title,
    summary: item.summary,
    url: item.url,
    source: item.source,
    publishedAt: new Date(item.publishedMs).toISOString(),
  }));
  const lines = items.map((item) => buildLine(item));
  return { lines, items };
}

/** 判断是不是明显的广告 / 推广条目。 */
function isAd(title, summary) {
  const haystack = title + ' ' + String(summary ?? '').slice(0, 200);
  for (const re of AD_PATTERNS) {
    if (re.test(haystack)) return true;
  }
  return false;
}

/**
 * 把一条新闻拼成给模型看的中文短句：`新闻：<标题>（<来源>）——<摘要>`。
 * 总长不超过 MAX_LINE_CHARS 字。
 */
function buildLine(item) {
  const title = item.title.length > MAX_TITLE_CHARS ? item.title.slice(0, MAX_TITLE_CHARS - 1) + '…' : item.title;
  let line = '新闻：' + title + '（' + item.source + '）';
  const summary = String(item.summary ?? '').trim();
  if (summary !== '') {
    const room = MAX_LINE_CHARS - line.length - 2 - 1; // 2 = '——'，1 = 省略号
    if (room >= 6) {
      line += '——' + summary.slice(0, room) + (summary.length > room ? '…' : '');
    }
  }
  if (line.length > MAX_LINE_CHARS) line = line.slice(0, MAX_LINE_CHARS - 1) + '…';
  return line;
}

// ---------------------------------------------------------------------------
// 本地图片文件夹
// ---------------------------------------------------------------------------

/** 目录往下最多递归 2 层（dir 本身算第 0 层）。 */
const MAX_IMAGE_DEPTH = 2;

/**
 * 从本地图片文件夹里随机挑一张图。
 *
 * @param {string} dir 图片文件夹
 * @param {object} [options]
 * @param {number} [options.limit=40] 最多收集多少个候选（顺便限制扫描量）
 * @param {string[]} [options.extensions=['.jpg','.jpeg','.png','.webp','.gif']]
 * @returns {string|null} 图片的**绝对路径**；目录不存在 / 不是目录 / 一张图都没有 → null
 */
export function pickLocalImage(dir, options = {}) {
  try {
    if (typeof dir !== 'string' || dir.trim() === '') return null;
    const opts = options ?? {};
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 40;
    const extensions = normalizeExtensions(opts.extensions);
    const root = resolve(dir);
    const st = statSync(root);
    if (!st.isDirectory()) return null;

    const candidates = [];
    collectImages(root, 0, extensions, candidates, limit);
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  } catch {
    return null; // 目录不存在 / 没权限 / 读不了 —— 一律当“没有图”
  }
}

/** 扩展名列表归一化（补点、统一小写）。 */
function normalizeExtensions(list) {
  const fallback = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
  if (!Array.isArray(list) || list.length === 0) return fallback;
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim().toLowerCase();
    if (text === '') continue;
    out.push(text.startsWith('.') ? text : '.' + text);
  }
  return out.length > 0 ? out : fallback;
}

/**
 * 递归收集图片（深度上限 MAX_IMAGE_DEPTH）。
 * 只跟进真目录，不跟符号链接目录（免得死循环）。
 */
function collectImages(dir, depth, extensions, out, limit) {
  if (out.length >= limit || depth > MAX_IMAGE_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= limit) return;
    const name = entry.name;
    if (name.startsWith('.')) continue;              // 隐藏文件 / 隐藏目录
    if (JUNK_FILES.includes(name.toLowerCase())) continue;
    const abs = join(dir, name);
    if (entry.isDirectory()) {
      collectImages(abs, depth + 1, extensions, out, limit);
      continue;
    }
    let isFile = entry.isFile();
    if (!isFile && entry.isSymbolicLink()) {
      try {
        isFile = statSync(abs).isFile();
      } catch {
        isFile = false;
      }
    }
    if (!isFile) continue;
    if (!extensions.includes(extname(name).toLowerCase())) continue;
    out.push(abs);
  }
}
