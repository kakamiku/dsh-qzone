/**
 * dsh-qzone —— `qzoneSettings` Typert Remote 服务（设置面板的 Host 半边）
 *
 * 干什么
 * ------
 * 给 Web GUI 里「QQ 空间」的设置面板提供唯一读写通道（方法全 positional，宿主网关
 * 按 descriptor 位置序调用；网关拒绝解构 / 默认值 / rest 参数）：
 *
 *   getSettings()                            → 快照
 *     { revision, entryActive, config, groups, effect }
 *   updateSettings(patch, expectedRevision)  → 同形状快照
 *   getStatus()                              → 只读运行时状态（不写任何东西）
 *     { date, posts, likes, comments, replies, seenCount, repliedCount, lastPostAt, lastLogAt }
 *
 * 持久层 = profile patch 里 `dsh-qzone` 条目的 config 覆盖行（桌面 profile 的
 * cordis.patch.yml 顶层 `- id: dsh-qzone` + `config:`）。本模块**不发明第二条写路径**：
 * 所有写入都走宿主 configEditor.edit（文件锁 + 原子写 + reconcile 热生效 + 激活失败
 * 自动回滚），设置页 / 手改 patch / 宿主原生设置页三方同源。
 *
 * revision 语义（对齐 dsh-onebot 的 settings-remote.js）：
 *   - 每个宿主进程一份内存计数器，从 0 开始，不持久化；
 *   - 读侧每次把条目的 config 覆盖行序列化成指纹跟上次比，**任何来源**的已提交变更
 *     （本 Remote / 宿主原生设置页 / 手改 patch / HMR）都 +1；
 *   - updateSettings 的 expectedRevision ≠ 当前值 → 拒写，抛
 *     RemoteError('qzone-settings/conflict', { expected, actual })；
 *     expectedRevision 传 undefined → 无条件写；
 *   - 不递增：入参校验失败、宿主拒绝写入、以及 no-op（合并结果与当前**生效** config
 *     全等 → 跳过 edit）。
 *
 * 敏感字段：本插件**没有**密钥类字段（OneBot 凭据从 dsh-onebot 那侧读，面板也不碰），
 * 所以快照不做脱敏。
 *
 * @deepseek-ai/dsh-typert-protocol 不可解析时（裸 dev checkout）降级为普通 cordis
 * 服务而不是炸掉插件加载（照抄 dsh-onebot/lib/settings-remote.js 的降级骨架）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/**
 * 自诊断日志：跟主插件写同一个 qzone.log，
 * 这样「设置面板连不上宿主」时，宿主控制台外面也能看到原因。
 */
const DIAG_LOG = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'media', 'onebot', 'qzone.log');
function diag(message) {
  try {
    mkdirSync(join(DIAG_LOG, '..'), { recursive: true });
    appendFileSync(DIAG_LOG, new Date().toISOString() + ' [info] 设置页 Remote：' + String(message) + '\n');
  } catch { /* 日志写不了就算了 */ }
}

/** profile patch 里 dsh-qzone 主条目的 id（唯一持久层条目）。 */
export const ENTRY_ID = 'dsh-qzone';
/** Typert Remote 命名空间 = cordis 服务键（= 客户端 ctx.get('remote.qzoneSettings')）。 */
export const NAMESPACE = 'qzoneSettings';
/** 快照固定值：24 键统一插件级热生效（保存后插件秒级原地重启）。 */
export const REMOTE_EFFECT = 'restart';

/**
 * 设置页四组 24 键（面板分组；与客户端 client.js 的 GROUPS 逐字对齐）。
 *   post   发动态
 *   social 好友动态
 *   reply  回评论
 *   access 主人与开关
 */
export const SETTINGS_GROUPS = {
  post: [
    'dailyLimit', 'scheduleEnabled', 'scheduleAt', 'scheduleIntervalMs',
    'imageRatio', 'ugcRight', 'persona', 'writerPrompt', 'defaultSource',
    'newsLimit', 'newsFeeds', 'newsLike', 'newsDislike', 'newsKeywords',
    'newsFollowBiliPreferences', 'localImageDir', 'writerTimeoutMs',
  ],
  social: [
    'socialEnabled', 'socialAt', 'socialPollIntervalMs', 'socialLikeLimit',
    'socialCommentLimit', 'socialMaxPerPoll', 'socialFreshHours', 'socialFeedCount',
    'socialAllowUsers', 'socialBlockUsers',
  ],
  reply: ['replyEnabled', 'replyIntervalMs', 'replyDailyLimit', 'replyMaxPerPoll', 'replySkipSelf'],
  access: ['enabled', 'ownerUsers'],
};

/** schema 默认值（快照生效值的底层；与 index.js 的 Config schema 对齐）。 */
export const SCHEMA_DEFAULTS = {
  // --- 发动态 ---
  dailyLimit: 3,
  scheduleEnabled: true,
  scheduleAt: ['10:00', '14:00', '19:00'],
  scheduleIntervalMs: 60000,
  imageRatio: 0,
  ugcRight: 1,
  writerPrompt: '',
  persona: '',
  defaultSource: 'auto',
  newsLimit: 6,
  newsFeeds: [],
  newsLike: [],
  newsDislike: [],
  newsKeywords: [],
  newsFollowBiliPreferences: true,
  localImageDir: '',
  writerTimeoutMs: 120000,
  // --- 好友动态 ---
  socialEnabled: true,
  socialAt: ['11:00', '17:00', '21:00'],
  socialPollIntervalMs: 900000,
  socialLikeLimit: 8,
  socialCommentLimit: 4,
  socialMaxPerPoll: 1,
  socialFreshHours: 24,
  socialFeedCount: 20,
  socialAllowUsers: [],
  socialBlockUsers: [],
  // --- 回评论 ---
  replyEnabled: true,
  replyIntervalMs: 300000,
  replyDailyLimit: 5,
  replyMaxPerPoll: 2,
  replySkipSelf: true,
  // --- 主人与开关 ---
  enabled: true,
  ownerUsers: [],
};

/** 快照返回侧需要脱敏的键（本插件没有，留空数组以对齐通用契约）。 */
export const SECRET_KEYS = [];

/** 全部 24 键（校验与快照的唯一键集；顺序 = 分组声明顺序）。 */
export const ALL_KEYS = Object.values(SETTINGS_GROUPS).flat();

/** 枚举键的取值集合。 */
export const ENUM_KEYS = {
  defaultSource: ['auto', 'chat', 'bili', 'news'],
};
/** 数字键（区间见 NUMBER_RANGE）。 */
export const NUMBER_KEYS = [
  'dailyLimit', 'scheduleIntervalMs', 'writerTimeoutMs', 'newsLimit', 'imageRatio',
  'socialPollIntervalMs', 'socialLikeLimit', 'socialCommentLimit', 'socialFeedCount',
  'replyIntervalMs', 'replyDailyLimit',
];
/** 数字数组键（元素是 0~23 的整点小时）。老配置兼容用，不在面板里。 */
export const NUMBER_ARRAY_KEYS = [];
/** 时刻数组键（元素是 HH:MM 字符串，精确到分钟）。 */
export const TIME_ARRAY_KEYS = ['scheduleAt', 'socialAt'];
/** 布尔键。 */
export const BOOLEAN_KEYS = [
  'enabled', 'scheduleEnabled', 'newsFollowBiliPreferences',
  'socialEnabled', 'replyEnabled', 'replySkipSelf',
];
/** 字符串键。 */
export const STRING_KEYS = ['writerPrompt', 'persona', 'localImageDir'];
/** 字符串数组键（QQ 号列表 / RSS 地址列表 / 偏好关键词）。 */
export const STRING_ARRAY_KEYS = [
  'ownerUsers', 'socialAllowUsers', 'socialBlockUsers',
  'newsFeeds', 'newsLike', 'newsDislike', 'newsKeywords',
];
/** 空间动态可见范围（NapCat 的 ugc_right）。 */
export const UGC_RIGHTS = [1, 4, 16, 64, 128];

/**
 * 数字键取值范围（越界在 Remote 层直接拒绝，不再只依赖宿主回滚兜底）。
 * 区间跟 index.js 里的钳制一致（宿主侧还会再钳一次，这里只是提前给出人话报错）。
 */
export const NUMBER_RANGE = {
  dailyLimit: [1, 20],
  scheduleIntervalMs: [15000, 3600000],
  writerTimeoutMs: [15000, 1800000],
  newsLimit: [1, 20],
  imageRatio: [0, 1],
  socialPollIntervalMs: [0, 86400000],
  socialLikeLimit: [0, 50],
  socialCommentLimit: [0, 50],
  socialMaxPerPoll: [1, 20],
  socialFreshHours: [0, 720],
  socialFeedCount: [1, 50],
  replyIntervalMs: [60000, 86400000],
  replyDailyLimit: [0, 50],
  replyMaxPerPoll: [1, 20],
};

/** typert-protocol 不可解析时的降级错误：结构对齐 RemoteError。 */
class FallbackRemoteError extends Error {
  code;
  details;
  isDSHRemoteError = true;
  constructor(code, message, details, options) {
    super(message, options);
    this.code = code;
    this.details = details;
    this.name = 'RemoteError';
  }
}

/**
 * 协议模块的定位顺序（两条腿都要会走路）：
 *
 *   1. 裸 specifier —— 宿主 loader 解析得动时最省事。
 *   2. 宿主安装目录里的绝对路径 —— profile 是装好的 Electron 应用，
 *      `@deepseek-ai/dsh-typert-protocol` 只存在于宿主自己的 node_modules 里
 *      （打包版在 `resources/app.asar/dsh/node_modules`），profile 的 node_modules
 *      根本没有它。HMR 重载过一次之后宿主的解析缓存会被清掉，裸 specifier 就会
 *      解析不到 —— 这时靠 createRequire 从宿主安装目录把真实文件路径捞出来，
 *      再按 file:// 导入（同一个文件 => 同一个模块实例 => 类身份一致）。
 *
 * 两条腿都失败才降级成普通 cordis 服务（网关发现不了，面板变只读）。
 */
/** 协议模块是从哪儿弄到的（裸 specifier 还是宿主安装目录的绝对路径），只用于日志。 */
let protocolSource = '';

/**
 * 进程级缓存：HMR 重载会重新求值本模块，但协议模块本身不该被重新解析 ——
 * 一旦解析成功过一次，就把它留在 globalThis 上，后续重载直接复用同一个模块实例
 * （类身份一致，宿主的 instanceof / Symbol 判断都不会错位）。
 */
const PROTOCOL_CACHE_KEY = Symbol.for('dsh-qzone.typertProtocol');

async function loadProtocol() {
  const cached = globalThis[PROTOCOL_CACHE_KEY];
  if (cached) {
    protocolSource = '进程缓存（上次解析到的同一个模块实例）';
    return cached;
  }

  try {
    const mod = await import('@deepseek-ai/dsh-typert-protocol');
    protocolSource = '裸 specifier（宿主 loader 解析）';
    globalThis[PROTOCOL_CACHE_KEY] = mod;
    return mod;
  }
  catch { /* 换绝对路径再试 */ }

  // 宿主安装目录的各种可能布局：Electron 打包版 = <exe>/resources/app.asar/dsh，
  // 源码跑 = <repo>/packages/...，宿主以 node 子进程跑 = <node>/../dsh ...
  //
  // ⚠️ anchors 只进不出、roots 只进不出：**别把新候选塞回 anchors**。
  //    之前 push() 写的是 anchors，而 for (const anchor of anchors) 又在遍历
  //    anchors —— 每加一个候选就多 6 个候选，for-of 走的是活动数组，
  //    于是永远跑不完（裸 specifier 一失败就死循环，插件整个 fiber 卡住）。
  const anchors = [];
  const roots = [];
  const pushRoot = (value) => {
    if (value && !roots.includes(value)) roots.push(value);
  };
  try { anchors.push(dirname(process.execPath)); } catch { /* ignore */ }
  try { anchors.push(dirname(process.argv[1])); } catch { /* ignore */ }
  try { anchors.push(process.cwd()); } catch { /* ignore */ }
  for (const anchor of anchors) {
    if (!anchor) continue;
    pushRoot(join(anchor, 'resources', 'app.asar', 'dsh'));
    pushRoot(join(anchor, 'resources', 'app.asar'));
    pushRoot(join(anchor, 'resources', 'app'));
    pushRoot(join(anchor, 'dsh'));
    pushRoot(anchor);
    pushRoot(dirname(anchor));
  }

  const tried = [];
  for (const root of roots) {
    if (!root) continue;
    try {
      const req = createRequire(join(root, 'package.json'));
      const resolved = req.resolve('@deepseek-ai/dsh-typert-protocol');
      const mod = await import(pathToFileURL(resolved).href);
      protocolSource = '绝对路径 ' + resolved;
      globalThis[PROTOCOL_CACHE_KEY] = mod;
      return mod;
    }
    catch (reason) {
      tried.push(root + ' → ' + (reason?.code ?? reason?.message ?? String(reason)).split('\n')[0]);
    }
  }
  diag('绝对路径也找不到。execPath=' + process.execPath + ' argv1=' + process.argv[1] + ' cwd=' + process.cwd()
    + ' | 试过：' + tried.join(' ; '));
  return null;
}

const protocol = await loadProtocol();
diag(protocol === null
  ? '@deepseek-ai/dsh-typert-protocol 解析不到 → 降级成普通 cordis 服务（网关发现不了 qzoneSettings）'
  : '协议在位 → Typert Remote（网关可发现 qzoneSettings），来源：' + (protocolSource || '?'));

/**
 * RemoteError 统一出口：协议在位用宿主类（跨域识别按 isDSHRemoteError），否则降级类。
 * 宿主类对 code 有 RemoteErrorDetailsMap 泛型约束（类型层），本服务使用自有
 * qzone-settings/* 错误码（运行期任意字符串均可，网关原样透传），故统一收窄。
 */
const RemoteError = (protocol?.RemoteError ?? FallbackRemoteError);

/** 乐观锁/降级以外唯一会抛的宿主依赖缺失情形：configEditor 不在位。 */
function requireConfigEditor(ctx) {
  const editor = ctx?.get?.('configEditor');
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new RemoteError(
      'qzone-settings/no-config-editor',
      'configEditor service is unavailable: the qzone-settings-remote row must mount beside the host bundle\'s dsh-config-editor',
      { entryId: ENTRY_ID },
    );
  }
  return editor;
}

/**
 * 在 profile patch 的可寻址条目中定位 dsh-qzone 主条目；不存在必须显式报错
 * （不得静默返回默认值——那会把主人改的设置悄悄吞掉）。
 */
function findEntry(editor) {
  const entry = editor.entries().find((candidate) => candidate?.options?.id === ENTRY_ID);
  if (!entry) {
    throw new RemoteError(
      'qzone-settings/no-entry',
      `no active "${ENTRY_ID}" entry in the profile patch — mount dsh-qzone first`,
      { entryId: ENTRY_ID },
    );
  }
  return entry;
}

/** 条目 fiber.state === 2 = active（与 configEditor.edit 的活性判据一致）。 */
function entryActiveOf(entry) {
  return entry.fiber !== undefined && entry.fiber.state === 2;
}

/** revision 状态：每进程一个内存计数器，从 0 开始，不持久化。 */
export function createRevisionState() {
  return { revision: 0, fingerprint: null };
}

/** 稳定序列化：键排序后再 stringify（避免只是键顺序变了就误判成一次变更）。 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
}

/** config 指纹（读侧观察 revision 用的原料）。 */
export function fingerprintOf(config) {
  return stableStringify(config ?? null);
}

/**
 * 读侧观察：config 指纹相对上次有差异即 +1（任何来源的已提交变更一视同仁）；
 * 首次调用只建立基线，不递增。
 */
export function observeRevision(state, config) {
  const fingerprint = fingerprintOf(config);
  if (state.fingerprint !== null && fingerprint !== state.fingerprint) state.revision += 1;
  state.fingerprint = fingerprint;
  return state.revision;
}

/** 深拷贝默认值（数组默认值不能被调用方改到）。 */
function cloneDefault(value) {
  return Array.isArray(value) ? value.slice() : value;
}

/**
 * 生效值 = schema 默认值 ← 条目的 config 覆盖行。
 * 覆盖行里没有的键回落到默认值（宿主 schemastery 也是这么合成的）。
 */
export function effectiveConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const effective = {};
  for (const key of ALL_KEYS) {
    const value = source[key];
    effective[key] = value === undefined ? cloneDefault(SCHEMA_DEFAULTS[key]) : value;
  }
  return effective;
}

/** 组 → 键数组（快照里的 groups 字段）。 */
export function groupsOf() {
  return Object.fromEntries(Object.entries(SETTINGS_GROUPS).map(([group, keys]) => [group, [...keys]]));
}

/** 组装快照（getSettings / updateSettings 共用）。 */
export function buildSnapshot(entry, state) {
  const raw = entry.options.config ?? {};
  const revision = observeRevision(state, raw);
  return {
    revision,
    entryActive: entryActiveOf(entry),
    config: effectiveConfig(raw),
    groups: groupsOf(),
    effect: REMOTE_EFFECT,
  };
}

/**
 * updateSettings 入参校验：24 键的任意子集，扁平 JSON。
 * 未知键整单拒绝（不静默丢弃）；类型/枚举/区间不符拒绝。
 * 具体取值合法性再交由宿主 schemastery 校验 + reconcile 失败自动回滚兜底。
 */
export function validatePatch(patch) {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    throw new RemoteError('qzone-settings/bad-request', 'patch must be a flat JSON object keyed by setting names', {
      issues: ['patch 必须是扁平 JSON 对象'],
    });
  }
  const issues = [];
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    // 缺省（undefined）= 这一项不改（客户端 codec 的可选键会带 undefined 过来）。
    if (value === undefined) continue;
    const enums = ENUM_KEYS[key];
    if (enums !== undefined) {
      if (typeof value === 'string' && enums.includes(value)) clean[key] = value;
      else issues.push(`${key} 必须是 ${enums.join(' | ')} 之一`);
    }
    else if (key === 'ugcRight') {
      if (typeof value === 'number' && UGC_RIGHTS.includes(value)) clean[key] = value;
      else issues.push(`ugcRight 必须是 ${UGC_RIGHTS.join(' / ')} 之一（1 所有人 / 4 好友 / 16 部分好友 / 64 仅自己 / 128 部分好友不可见）`);
    }
    else if (NUMBER_KEYS.includes(key)) {
      const range = NUMBER_RANGE[key];
      const min = range[0];
      const max = range[1];
      if (typeof value === 'number' && Number.isFinite(value) && value >= min && (max === undefined || value <= max)) clean[key] = value;
      else issues.push(`${key} 必须是 ${max === undefined ? `≥${min}` : `${min}–${max}`} 的有限数字`);
    }
    else if (NUMBER_ARRAY_KEYS.includes(key)) {
      if (Array.isArray(value) && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 23)) clean[key] = value.slice();
      else issues.push(`${key} 必须是 0~23 的整点小时数组（如 [10, 14, 19]）`);
    }
    else if (TIME_ARRAY_KEYS.includes(key)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string' && /^\d{1,2}:\d{2}$/.test(item)
        && Number(item.split(':')[0]) >= 0 && Number(item.split(':')[0]) <= 23
        && Number(item.split(':')[1]) >= 0 && Number(item.split(':')[1]) <= 59)) clean[key] = value.map((item) => {
        const [h, m] = item.split(':');
        return String(Number(h)).padStart(2, '0') + ':' + String(Number(m)).padStart(2, '0');
      });
      else issues.push(`${key} 必须是 HH:MM 时刻数组（如 ['10:00', '14:37']）`);
    }
    else if (BOOLEAN_KEYS.includes(key)) {
      if (typeof value === 'boolean') clean[key] = value;
      else issues.push(`${key} 必须是布尔值`);
    }
    else if (STRING_KEYS.includes(key)) {
      if (typeof value === 'string') clean[key] = value;
      else issues.push(`${key} 必须是字符串`);
    }
    else if (STRING_ARRAY_KEYS.includes(key)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) clean[key] = value.slice();
      else issues.push(`${key} 必须是字符串数组`);
    }
    else {
      issues.push(`未知设置键 "${key}"（仅支持 ${ALL_KEYS.length} 键：${ALL_KEYS.join(', ')}）`);
    }
  }
  if (issues.length > 0) {
    throw new RemoteError('qzone-settings/bad-request', `invalid settings patch: ${issues.join('; ')}`, { issues });
  }
  return clean;
}

/** getSettings 实现（descriptor 方法体共用；descriptor 参数 0 个）。 */
export function getSettings(editor, state) {
  return buildSnapshot(findEntry(editor), state);
}

/**
 * 宿主 configEditor.edit 的原生失败（文件锁超时 / 条目被替换 / schema 校验不过 /
 * home-patch 守卫 / 激活失败回滚）归一成面板能直接渲染的中文错误。
 * 只翻译、不重试、不补偿写——宿主已保证 patch 文件未被破坏或已逐字节还原。
 */
export const EDIT_FAILED_CODE = 'qzone-settings/edit-failed';

export function describeEditFailure(cause) {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/timed out waiting for the writer lock/i.test(message)) {
    return '写入失败：配置文件被其他写入方占用（等待文件锁超时），本次修改未落盘，请稍后重试';
  }
  if (/no longer available|changed during reload/i.test(message)) {
    return '写入失败：dsh-qzone 条目在编辑期间被替换或失活，本次修改未落盘，请刷新后重试';
  }
  if (/no longer active/i.test(message)) {
    return '写入失败：dsh-qzone 插件当前未激活，本次修改未落盘，请检查插件加载状态';
  }
  if (/overridden by a home patch|command-line overlay/i.test(message)) {
    return '写入失败：该配置被 home patch 或命令行覆盖层接管，修改被宿主拒绝；请改在对应层修改';
  }
  return `写入失败：宿主 configEditor 拒绝了本次修改（${message}），配置保持不变`;
}

/**
 * updateSettings 实现（descriptor 参数 (patch, expectedRevision)，全 positional）。
 *
 * 流程：定位条目 → 观察当前 revision → 乐观锁校验 → patch 校验 → no-op 短路
 * （合并后的生效值与当前生效值全等 → 不写、不递增）→ configEditor.edit 合并写
 * （next = 当前覆盖行 ∪ patch，未知原键原样保留；等于继承层时宿主整行删除覆盖行）
 * → 成功后返回新快照（指纹变化 → revision +1）。
 */
export async function updateSettings(editor, state, patch, expectedRevision) {
  const entry = findEntry(editor);
  const actual = observeRevision(state, entry.options.config ?? {});
  // expectedRevision 缺省（undefined / null）= 无条件写；给了就必须对上。
  if (expectedRevision !== undefined && expectedRevision !== null
    && (!Number.isInteger(expectedRevision) || expectedRevision !== actual)) {
    throw new RemoteError(
      'qzone-settings/conflict',
      `expectedRevision ${String(expectedRevision)} does not match current revision ${actual}; re-read getSettings() and replay`,
      { expected: expectedRevision, actual },
    );
  }
  const clean = validatePatch(patch);
  const current = entry.options.config ?? {};
  const merged = { ...current, ...clean };
  // no-op：合并结果与当前**生效** config 全等 → 跳过 edit（不递增 revision）。
  if (isDeepStrictEqual(effectiveConfig(merged), effectiveConfig(current))) {
    return buildSnapshot(entry, state);
  }
  try {
    await editor.edit(entry, (fresh) => ({ ...fresh, ...clean }));
  }
  catch (cause) {
    throw new RemoteError(
      EDIT_FAILED_CODE,
      describeEditFailure(cause),
      { hostMessage: cause instanceof Error ? cause.message : String(cause) },
      { cause },
    );
  }
  return buildSnapshot(findEntry(editor), state);
}

// ---------------------------------------------------------------------------
// 运行时状态（只读）
// ---------------------------------------------------------------------------

/** DSH 家目录（跟 index.js 同一口径）。 */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** 状态文件路径：~/.dsh/media/onebot/qzone-state.json。 */
export function stateFilePath() {
  return join(dshHome(), 'media', 'onebot', 'qzone-state.json');
}

/** 读状态文件；不存在 / 读失败 / 解析失败一律返回 null（绝不抛错）。 */
export function readStateFile() {
  try {
    const file = stateFilePath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  }
  catch {
    return null;
  }
}

/** 计数归一（非负整数）。 */
function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
}

/**
 * getStatus 实现：只读运行时状态，**不写任何东西**。
 * 数据源 = 状态文件（插件自己写的运行账本）：
 *   { version, date, count, slots, posts:[…], social:{ date, likeCount, commentCount,
 *     replyCount, slots, seen:{…}, replied:{…} } }
 * 文件不存在 / 读失败 → 返回各计数为 0 的空状态。
 */
export function getStatus() {
  const raw = readStateFile();
  if (raw === null) {
    return {
      date: '', posts: 0, likes: 0, comments: 0, replies: 0,
      seenCount: 0, repliedCount: 0, lastPostAt: '', lastLogAt: '',
    };
  }
  const social = raw.social !== null && typeof raw.social === 'object' ? raw.social : {};
  const posts = Array.isArray(raw.posts) ? raw.posts : [];
  const seen = social.seen !== null && typeof social.seen === 'object' ? social.seen : {};
  const replied = social.replied !== null && typeof social.replied === 'object' ? social.replied : {};
  const last = posts.length > 0 ? posts[posts.length - 1] : null;
  const lastPostAt = last !== null && typeof last.at === 'string' ? last.at : '';
  // 最后活动时间：状态文件里所有时间戳里最新的那个（没有就空串）。
  const stamps = [];
  for (const value of Object.values(seen)) {
    if (value !== null && typeof value === 'object' && typeof value.at === 'string') stamps.push(value.at);
  }
  for (const value of Object.values(replied)) {
    if (value !== null && typeof value === 'object' && typeof value.at === 'string') stamps.push(value.at);
  }
  stamps.sort();
  const lastActivity = stamps.length > 0 ? stamps[stamps.length - 1] : '';
  const lastLogAt = typeof raw.updatedAt === 'string' && raw.updatedAt !== '' ? raw.updatedAt : lastActivity;
  return {
    date: typeof raw.date === 'string' ? raw.date : '',
    posts: toCount(raw.count),
    likes: toCount(social.likeCount),
    comments: toCount(social.commentCount),
    replies: toCount(social.replyCount),
    seenCount: Object.keys(seen).length,
    repliedCount: Object.keys(replied).length,
    lastPostAt,
    lastLogAt,
  };
}

/**
 * 组装 descriptor 方法对象（测试与降级类共用；与类方法同一实现）。
 */
export function createQzoneSettingsMethods(editor, state = createRevisionState()) {
  return {
    getSettings: () => getSettings(editor, state),
    updateSettings: (patch, expectedRevision) => updateSettings(editor, state, patch, expectedRevision),
    getStatus: () => getStatus(),
  };
}

/**
 * 把 typert-protocol 的 Remote 标记应用到类原型（无原生装饰器语法的 shim，
 * 照抄 dsh-onebot/lib/settings-remote.js；mark() 对同一原型幂等）。
 */
function markRemote(klass, methodName) {
  if (!protocol?.Remote) return;
  const initializers = [];
  const decorator = protocol.Remote(methodName);
  decorator(undefined, {
    name: methodName,
    private: false,
    static: false,
    addInitializer(fn) { initializers.push(fn); },
  });
  const receiver = Object.create(klass.prototype);
  for (const fn of initializers) fn.call(receiver);
}

/**
 * 服务装配：协议在位 → TypertRemoteService 子类（网关按 typertRemote 绑定 +
 * 原型 descriptor 发现）；否则降级为普通 cordis 服务（同名方法面，仅无网关发现）。
 * 两个分支共用上方导出的实现函数与同一 descriptor 形状。
 */
let QzoneSettingsService;
if (protocol?.TypertRemoteService) {
  class QzoneSettingsRemote extends protocol.TypertRemoteService {
    static inject = ['configEditor', 'profileContext'];
    state = createRevisionState();
    /** Service 基类的 ctx 为 protected 且跨包声明，此处自存一份只读引用供惰性解析。 */
    ownerCtx;
    constructor(ctx) {
      super(ctx, NAMESPACE);
      this.ownerCtx = ctx;
    }
    /** 惰性解析宿主 configEditor（static inject 保证在位；运行期再校验形状）。 */
    configEditor() {
      return requireConfigEditor(this.ownerCtx);
    }
    async getSettings() {
      return getSettings(this.configEditor(), this.state);
    }
    async updateSettings(patch, expectedRevision) {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
    }
    /** 只读运行时状态：读状态文件，失败一律降级为空状态，不抛错。 */
    async getStatus() {
      return getStatus();
    }
  }
  markRemote(QzoneSettingsRemote, 'getSettings');
  markRemote(QzoneSettingsRemote, 'updateSettings');
  markRemote(QzoneSettingsRemote, 'getStatus');
  QzoneSettingsService = QzoneSettingsRemote;
}
else {
  console.warn('[dsh-qzone] @deepseek-ai/dsh-typert-protocol unavailable — qzoneSettings remote degrades to a plain cordis service');
  class QzoneSettingsPlain {
    static inject = ['configEditor', 'profileContext'];
    name = NAMESPACE;
    state = createRevisionState();
    ctx;
    constructor(ctx) {
      this.ctx = ctx;
    }
    configEditor() {
      return requireConfigEditor(this.ctx);
    }
    getSettings() {
      return getSettings(this.configEditor(), this.state);
    }
    async updateSettings(patch, expectedRevision) {
      return updateSettings(this.configEditor(), this.state, patch, expectedRevision);
    }
    async getStatus() {
      return getStatus();
    }
  }
  QzoneSettingsService = QzoneSettingsPlain;
}

export default QzoneSettingsService;
export { QzoneSettingsService };
// 协议模块定位：裸 specifier -> 宿主安装目录绝对路径 -> 进程级 globalThis 缓存（见 loadProtocol）。
