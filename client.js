/**
 * dsh-qzone —— client bundle（QQ 空间设置面板）
 *
 * 结构模板：dsh-onebot-qq/lib/client.js（CJS 包裹 + slots/remote 挂载模式），
 * 契约对齐本包的 settings-remote.js（Host 侧 Remote 服务）。
 *
 * 宿主装载契约：
 *   - CJS 包裹：banner `window.__ModuleLoader__.load({ id, factory: (require) => {`，
 *     footer `return module.exports; } });`；externals 仅 react（平台冻结模块表）。
 *   - 入口导出 `inject`（宿主客户端服务名数组）与 `apply(ctx) => disposer`。
 *   - 面板注册：`ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register(
 *     { name, key, locale }, render))`（keyed，key = 组合包 npm 包名 `dsh-qzone`）。
 *   - 数据通道：Typert Remote（`ctx.remote.$mount(QZONE_SETTINGS_REMOTE)` 之后
 *     `ctx.get('remote.qzoneSettings')`）；所有读写经 Remote 调 host 侧，host 经
 *     configEditor.edit 写 profile patch 里 dsh-qzone 条目的 config 覆盖行。
 *
 * descriptor 同步说明：host 侧 settings-remote.js 导出的是常量与服务实现，**没有**
 * 导出客户端 Typert descriptor 数组（descriptor 是浏览器侧的挂载清单，两侧各持一份）。
 * 本文件内联定义 QZONE_SETTINGS_DESCRIPTORS，与 host 侧逐字对齐：
 *   - namespace / cordis 服务名 = `qzoneSettings`；
 *   - 方法集 = getSettings() / updateSettings(patch, expectedRevision) / getStatus()，
 *     全 positional（宿主网关拒绝解构 / 默认值 / rest 参数）；
 *   - 快照结构 = { revision, entryActive, config(26 键), groups(4 组), effect='restart' }；
 *   - 状态结构 = { date, posts, likes, comments, replies, seenCount, repliedCount,
 *     lastPostAt, lastLogAt }。
 * 任一侧变更 descriptor / 分组 / 键集 / 默认值时，必须同步另一侧。
 *
 * 生效语义：保存经宿主 configEditor.edit → Loader reconcile → 插件 fiber 秒级原地
 * 重启，所有 26 键统一「保存即热生效」。保存冲突（qzone-settings/conflict）时提示并
 * 重拉快照（revision 语义与 host 侧一致：任何来源的已提交变更都 +1）。
 */
window.__ModuleLoader__.load({
	id: "dsh-qzone",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		//#region 外部模块（平台冻结表内：react）
		var reactModule = require("react");
		var React = reactModule != null && typeof reactModule.createElement === "function"
			? reactModule
			: reactModule.default;
		if (React == null || typeof React.createElement !== "function") {
			throw new Error("dsh-qzone client: react 不可用");
		}
		//#endregion

		//#region 常量
		var PLUGIN_ID = "dsh-qzone";
		var REMOTE_NS = "qzoneSettings"; // Typert Remote 命名空间（= host 侧 cordis 服务键）
		var NS = "dsh-qzone"; // locale 命名空间
		//#endregion

		//#region 四组 23 键字段定义（分组 / 键集 / 类型 / 默认值；与 host 侧
		//  settings-remote.js 的 SETTINGS_GROUPS / SCHEMA_DEFAULTS 逐字对齐）
		//
		// 字段类型：enum（下拉）/ number（数字）/ boolean（开关）/ text（多行文本）/
		//           numberList（逗号分隔的小时数）/ stringList（每行一个 QQ 号）
		var GROUPS = [
			{
				id: "post",
				title: "发动态",
				desc: "每天自动发几条、几点发、配不配图、正文写什么",
				fields: [
					{ key: "dailyLimit", label: "每天最多发几条", type: "number", hint: "按 Asia/Shanghai 自然日算，跨天自动重置。" },
					{ key: "scheduleEnabled", label: "定时发", type: "boolean", hint: "关掉就只在主人下口令或模型调工具时才发。" },
					{ key: "scheduleAt", label: "每天几点发（本地时间）", type: "timeList", hint: "24 小时制、精确到分钟，逗号分隔，例如 10:00, 14:37, 22:05。" },
					{ key: "scheduleIntervalMs", label: "定时器轮询间隔（毫秒）", type: "number", hint: "多久检查一次「到点没」。默认 60000（1 分钟）。" },
					{ key: "imageRatio", label: "带图概率", type: "number", hint: "0 = 只发纯文字，1 = 只发带图，0.5 = 一半一半。每发一条掷一次骰子。图源优先用 dsh-meme 的表情包；没装 dsh-meme 就从下面的「本地图片文件夹」里挑。" },
					{ key: "ugcRight", label: "可见范围", type: "enum", options: [1, 4, 16, 64, 128], optionLabels: { 1: "所有人可见", 4: "仅好友可见", 16: "部分好友可见", 64: "仅自己可见", 128: "部分好友不可见" }, hint: "对应 NapCat 的 ugc_right。1 = 所有人可见（默认）。" },
					{ key: "writerPrompt", label: "动态发布内容", type: "text", hint: "追加到写作提示里的自定义要求，例如「多写深海里的事」「别提工作」「今天想 emo 一点」。留空 = 用插件默认人设。" },
					{ key: "defaultSource", label: "素材来源", type: "enum", options: ["auto", "chat", "bili", "news"], optionLabels: { auto: "自动挑", chat: "当天的 QQ 对话", bili: "当天的 B 站视频", news: "当天的新闻" }, hint: "一条动态只用一个来源，绝不混用。news 不需要装任何插件，插件自带 RSS 抓取。" },
					{ key: "newsLimit", label: "新闻素材最多取几条", type: "number", hint: "只用 news 来源时生效，默认 6 条。" },
					{ key: "newsFeeds", label: "自定义新闻源（RSS）", type: "stringList", hint: "每行一个 RSS/Atom 地址。留空 = 用插件自带的 6 个源。" },
					{ key: "newsFollowBiliPreferences", label: "沿用 dsh-bili-whale 的偏好", type: "boolean", hint: "开 = 把 dsh-bili-whale 配置里的 preferences（喜欢什么 / 讨厌什么 / 关键词）也拿来筛新闻。没装 dsh-bili-whale 时这个开关无效。" },
					{ key: "newsLike", label: "喜欢的题材", type: "stringList", hint: "每行一个关键词。新闻标题/摘要里命中的排前面。" },
					{ key: "newsDislike", label: "不喜欢的题材", type: "stringList", hint: "每行一个关键词。命中的新闻直接丢掉，不当素材。" },
					{ key: "newsKeywords", label: "额外关键词", type: "stringList", hint: "每行一个关键词。跟「喜欢的题材」一样是加分项，命中就排前面。" },
					{ key: "localImageDir", label: "本地图片文件夹", type: "text", hint: "没装 dsh-meme（没有表情包图库）时，从这里随机挑一张配图。例：C:\\Users\\Lenovo\\Pictures。留空 = 不启用。" },
					{ key: "writerTimeoutMs", label: "等模型回话的时限（毫秒）", type: "number", hint: "超过这个时间还没写出来，就换兜底模板。" },
				],
			},
			{
				id: "social",
				title: "好友动态",
				desc: "给好友动态点赞、评论",
				fields: [
					{ key: "socialEnabled", label: "好友动态互动总开关", type: "boolean" },
					{ key: "socialAt", label: "定点互动的时刻", type: "timeList", hint: "24 小时制、精确到分钟，逗号分隔，例如 11:07, 17:23, 21:41。" },
					{ key: "socialPollIntervalMs", label: "轮询间隔（毫秒）", type: "number", hint: "每隔多久扫一次好友动态，新动态一出来就互动。0 = 关掉轮询，只按上面的时刻跑。" },
					{ key: "socialLikeLimit", label: "每天最多点几个赞", type: "number" },
					{ key: "socialCommentLimit", label: "每天最多评几条", type: "number" },
					{ key: "socialFeedCount", label: "每轮拉多少条好友动态", type: "number", hint: "NapCat 上限 50。" },
					{ key: "socialAllowUsers", label: "只跟这些 QQ 号互动", type: "stringList", hint: "每行一个 QQ 号。留空 = 好友动态里谁都互动。" },
					{ key: "socialBlockUsers", label: "绝不跟这些 QQ 号互动", type: "stringList", hint: "每行一个 QQ 号。" },
					{ key: "socialMaxPerPoll", label: "每轮最多跟几条动态互动", type: "number", hint: "别一轮就把当天额度烧光，留给后面新发的动态。" },
					{ key: "socialFreshHours", label: "只互动几小时内的新动态", type: "number", hint: "0 = 不限新旧。默认 24 小时。" },
				],
			},
			{
				id: "reply",
				title: "回评论",
				desc: "回自己动态下面别人留的评论",
				fields: [
					{ key: "replyEnabled", label: "回评论总开关", type: "boolean" },
					{ key: "replyIntervalMs", label: "每隔多久查一次新评论（毫秒）", type: "number", hint: "最小 1 分钟。" },
					{ key: "replyDailyLimit", label: "每天最多回几条", type: "number" },
					{ key: "replyMaxPerPoll", label: "每轮最多回几条", type: "number", hint: "把当天额度摊开，后面来的新评论才排得上。" },
					{ key: "replySkipSelf", label: "要不要回自己留的评论", type: "boolean", hint: "默认不回（自己跟自己对话没意思）。" },
				],
			},
			{
				id: "access",
				title: "主人与开关",
				desc: "总开关与口令触发者",
				fields: [
					{ key: "enabled", label: "插件总开关", type: "boolean", hint: "关掉之后定时发、点赞评论、回评论全停。" },
					{ key: "ownerUsers", label: "可以用口令触发的主人 QQ 号", type: "stringList", hint: "每行一个 QQ 号。私聊里说「发条空间动态」「去互动」「回个评论」就能直接触发。" },
				],
			},
		];

		/** 全部 26 键扁平表（顺序 = 四组声明顺序，与 host ALL_KEYS 语义一致）。 */
		var ALL_FIELDS = [];
		for (var groupIndex = 0; groupIndex < GROUPS.length; groupIndex++) {
			for (var fieldIndex = 0; fieldIndex < GROUPS[groupIndex].fields.length; fieldIndex++) {
				ALL_FIELDS.push(GROUPS[groupIndex].fields[fieldIndex]);
			}
		}

		/** schema 默认值（与 host 侧 SCHEMA_DEFAULTS 逐字对齐）。 */
		var DEFAULTS = {
			dailyLimit: 3,
			scheduleEnabled: true,
			scheduleAt: ["10:00", "14:00", "19:00"],
			scheduleIntervalMs: 60000,
			imageRatio: 0,
			ugcRight: 1,
			writerPrompt: "",
			defaultSource: "auto",
			newsLimit: 6,
			newsFeeds: [],
			newsLike: [],
			newsDislike: [],
			newsKeywords: [],
			newsFollowBiliPreferences: true,
			localImageDir: "",
			writerTimeoutMs: 120000,
			socialEnabled: true,
			socialAt: ["11:00", "17:00", "21:00"],
			socialPollIntervalMs: 900000,
			socialLikeLimit: 8,
			socialCommentLimit: 4,
			socialMaxPerPoll: 1,
			socialFreshHours: 24,
			socialFeedCount: 20,
			socialAllowUsers: [],
			socialBlockUsers: [],
			replyEnabled: true,
			replyIntervalMs: 300000,
			replyDailyLimit: 5,
			replyMaxPerPoll: 2,
			replySkipSelf: true,
			enabled: true,
			ownerUsers: [],
		};

		/** 分组 → 键数组（与 host SETTINGS_GROUPS 同构）。 */
		var GROUP_KEYS = {};
		for (var gk = 0; gk < GROUPS.length; gk++) {
			GROUP_KEYS[GROUPS[gk].id] = GROUPS[gk].fields.map(function (field) { return field.key; });
		}

		/**
		 * 数字键合法区间（逐字抄自 host 侧 NUMBER_RANGE；host 仍会二次校验）。
		 * ugcRight 是枚举（1/4/16/64/128），不在这里。
		 */
		var NUMBER_RANGE = {
			dailyLimit: [1, 20],
			scheduleIntervalMs: [15000, 3600000],
			writerTimeoutMs: [15000, 1800000],
			socialPollIntervalMs: [0, 86400000],
			socialLikeLimit: [0, 50],
			socialCommentLimit: [0, 50],
			socialMaxPerPoll: [1, 20],
			socialFreshHours: [0, 720],
			socialFeedCount: [1, 50],
			newsLimit: [1, 20],
			imageRatio: [0, 1],
			replyIntervalMs: [60000, 86400000],
			replyDailyLimit: [0, 50],
			replyMaxPerPoll: [1, 20],
		};
		//#endregion

		//#region 极简 schema 校验（替代 zod，供 Typert 严格 codec 使用；与 onebot 样板同款）
		function vString(min, max) {
			return {
				parse(value) {
					if (typeof value !== "string" || value.length < min || value.length > max) {
						throw new TypeError("expected string(" + min + ".." + max + ")");
					}
					return value;
				},
			};
		}
		function vInt(min) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
						throw new TypeError("expected int>=" + min);
					}
					return value;
				},
			};
		}
		function vNumber(min, max) {
			return {
				parse(value) {
					if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("expected finite number");
					if (min !== undefined && value < min) throw new TypeError("expected number >= " + min);
					if (max !== undefined && value > max) throw new TypeError("expected number <= " + max);
					return value;
				},
			};
		}
		function vBoolean() {
			return {
				parse(value) {
					if (typeof value !== "boolean") throw new TypeError("expected boolean");
					return value;
				},
			};
		}
		function vArray(item) {
			return {
				parse(value) {
					if (!Array.isArray(value)) throw new TypeError("expected array");
					return value.map(function (entry) { return item.parse(entry); });
				},
			};
		}
		/** 可选字段：缺席（undefined/null）时保持缺席，不参与 parse。 */
		function vOptional(inner) {
			return {
				parse(value) {
					if (value === undefined || value === null) return undefined;
					return inner.parse(value);
				},
			};
		}
		/** 与 zod object 默认行为一致：声明外字段剥离，声明内字段逐个 parse。 */
		function vObject(shape) {
			return {
				parse(value) {
					if (value === null || typeof value !== "object" || Array.isArray(value)) {
						throw new TypeError("expected object");
					}
					var out = {};
					for (var key of Object.keys(shape)) out[key] = shape[key].parse(value[key]);
					return out;
				},
			};
		}
		function vEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "string" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		function vNumberEnum(values) {
			return {
				parse(value) {
					if (typeof value !== "number" || values.indexOf(value) < 0) {
						throw new TypeError("expected one of " + values.join("|"));
					}
					return value;
				},
			};
		}
		//#endregion

		//#region Typert Remote 严格 descriptor（与 host 侧 settings-remote.js 的方法面逐字对齐）
		/** 33 键生效值（host buildSnapshot 的 effectiveConfig 全键返回）。 */
		var configSchema = vObject({
			dailyLimit: vNumber(),
			scheduleEnabled: vBoolean(),
			scheduleAt: vArray(vString(0, 16)),
			scheduleIntervalMs: vNumber(),
			imageRatio: vNumber(),
			ugcRight: vNumberEnum([1, 4, 16, 64, 128]),
			writerPrompt: vString(0, 4096),
			defaultSource: vEnum(["auto", "chat", "bili", "news"]),
			newsLimit: vNumber(),
			newsFeeds: vArray(vString(0, 1024)),
			newsLike: vArray(vString(0, 256)),
			newsDislike: vArray(vString(0, 256)),
			newsKeywords: vArray(vString(0, 256)),
			newsFollowBiliPreferences: vBoolean(),
			localImageDir: vString(0, 4096),
			writerTimeoutMs: vNumber(),
			socialEnabled: vBoolean(),
			socialAt: vArray(vString(0, 16)),
			socialPollIntervalMs: vNumber(),
			socialLikeLimit: vNumber(),
			socialCommentLimit: vNumber(),
			socialMaxPerPoll: vNumber(),
			socialFreshHours: vNumber(),
			socialFeedCount: vNumber(),
			socialAllowUsers: vArray(vString(0, 64)),
			socialBlockUsers: vArray(vString(0, 64)),
			replyEnabled: vBoolean(),
			replyIntervalMs: vNumber(),
			replyDailyLimit: vNumber(),
			replyMaxPerPoll: vNumber(),
			replySkipSelf: vBoolean(),
			enabled: vBoolean(),
			ownerUsers: vArray(vString(0, 64)),
		});
		var snapshotSchema = vObject({
			revision: vInt(0),
			entryActive: vBoolean(),
			config: configSchema,
			groups: vObject({
				post: vArray(vString(1, 64)),
				social: vArray(vString(1, 64)),
				reply: vArray(vString(1, 64)),
				access: vArray(vString(1, 64)),
			}),
			effect: vEnum(["restart"]),
		});
		/** updateSettings 入参（33 键任意子集的扁平 JSON）。 */
		var patchSchema = vObject({
			dailyLimit: vOptional(vNumber()),
			scheduleEnabled: vOptional(vBoolean()),
			scheduleAt: vOptional(vArray(vString(0, 16))),
			scheduleIntervalMs: vOptional(vNumber()),
			imageRatio: vOptional(vNumber()),
			ugcRight: vOptional(vNumberEnum([1, 4, 16, 64, 128])),
			writerPrompt: vOptional(vString(0, 4096)),
			defaultSource: vOptional(vEnum(["auto", "chat", "bili", "news"])),
			newsLimit: vOptional(vNumber()),
			newsFeeds: vOptional(vArray(vString(0, 1024))),
			newsLike: vOptional(vArray(vString(0, 256))),
			newsDislike: vOptional(vArray(vString(0, 256))),
			newsKeywords: vOptional(vArray(vString(0, 256))),
			newsFollowBiliPreferences: vOptional(vBoolean()),
			localImageDir: vOptional(vString(0, 4096)),
			writerTimeoutMs: vOptional(vNumber()),
			socialEnabled: vOptional(vBoolean()),
			socialAt: vOptional(vArray(vString(0, 16))),
			socialPollIntervalMs: vOptional(vNumber()),
			socialLikeLimit: vOptional(vNumber()),
			socialCommentLimit: vOptional(vNumber()),
			socialMaxPerPoll: vOptional(vNumber()),
			socialFreshHours: vOptional(vNumber()),
			socialFeedCount: vOptional(vNumber()),
			socialAllowUsers: vOptional(vArray(vString(0, 64))),
			socialBlockUsers: vOptional(vArray(vString(0, 64))),
			replyEnabled: vOptional(vBoolean()),
			replyIntervalMs: vOptional(vNumber()),
			replyDailyLimit: vOptional(vNumber()),
			replyMaxPerPoll: vOptional(vNumber()),
			replySkipSelf: vOptional(vBoolean()),
			enabled: vOptional(vBoolean()),
			ownerUsers: vOptional(vArray(vString(0, 64))),
		});
		/** getStatus 返回值（只读运行时状态）。 */
		var statusSchema = vObject({
			date: vString(0, 64),
			posts: vInt(0),
			likes: vInt(0),
			comments: vInt(0),
			replies: vInt(0),
			seenCount: vInt(0),
			repliedCount: vInt(0),
			lastPostAt: vString(0, 64),
			lastLogAt: vString(0, 64),
		});
		function strictCodec(typeSymbol, schema) {
			return { mode: "strict", typeSymbol: typeSymbol, create: function () { return schema; }, schema: schema };
		}
		function jsonParameter(name, typeSymbol, schema) {
			return { name: name, wire: name, source: "json", codec: strictCodec(typeSymbol, schema) };
		}
		function qzoneMethod(method, parameters, resultSchema, typeSymbol) {
			return {
				id: PLUGIN_ID + "#" + REMOTE_NS + "/" + method,
				service: REMOTE_NS,
				namespace: REMOTE_NS,
				method: method,
				invocation: { kind: "direct" },
				parameters: parameters,
				result: strictCodec(typeSymbol != null ? typeSymbol : "QzoneSettingsSnapshot", resultSchema || snapshotSchema),
			};
		}
		var QZONE_SETTINGS_DESCRIPTORS = [
			qzoneMethod("getSettings", []),
			qzoneMethod("updateSettings", [
				jsonParameter("patch", "QzoneSettingsPatch", patchSchema),
				jsonParameter("expectedRevision", "number", vOptional(vInt(0))),
			]),
			qzoneMethod("getStatus", [], statusSchema, "QzoneStatus"),
		];
		var QZONE_SETTINGS_REMOTE = { package: PLUGIN_ID, descriptors: QZONE_SETTINGS_DESCRIPTORS };
		//#endregion

		//#region 双语词条（zh 为 key 集真相源，en 逐 key 对齐；占位符用平台 {word} 形式）
		var zh = {
			"settings.title": "QQ 空间设置",
			"settings.desc": "配置持久化为 profile 层 cordis.patch.yml 中 dsh-qzone 条目的 config 覆盖行，与手改 patch、宿主原生设置页同源。",
			"settings.summary": "每天自动发 QQ 空间动态，还能给好友动态点赞评论、回自己动态下面的留言。",
			"nav": "QQ 空间",
			"settings.loading": "正在加载设置…",
			"settings.reload": "重新加载",
			"settings.reset": "恢复默认值",
			"save.submit": "保存设置",
			"save.saving": "正在保存…",
			"save.done": "设置已保存。保存即热生效：插件秒级重启，定时器与互动轮询按新配置重来。",
			"save.noChanges": "没有需要保存的变更。",
			"save.badNumber": "数字字段不合法：{keys}",
			"save.dirtyBadge": "{count} 项未保存",
			"save.noChangesTitle": "没有未保存的修改",
			"effect.hint": "保存即热生效（无需重启宿主）：插件秒级原地重启，定时器、互动轮询与额度计数按新配置重新开始；在途的写作会话会中断。",
			"effect.entryInactive": "dsh-qzone 条目当前未激活，保存后可能无法生效，请检查插件加载状态。",
			"effect.entryInactiveTitle": "插件条目未激活，修改可能无法生效。",
			"conflict.title": "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。",
			"conflict.kept": "已保留 {count} 项未冲突的修改，请核对后重新保存。",
			"status.error": "出错",
			"status.title": "今天的运行情况",
			"status.date": "统计日期",
			"status.posts": "已发动态",
			"status.likes": "已点赞",
			"status.comments": "已评论",
			"status.replies": "已回评论",
			"status.seen": "互动过的动态",
			"status.replied": "回过的评论",
			"status.lastPost": "最后一条动态",
			"status.lastActivity": "最后活动",
			"status.empty": "还没有运行记录（状态文件不存在或读不到）。",
			"status.refresh": "刷新状态",
			"status.loadFailed": "读取运行状态失败：{message}",
			"revision.label": "revision",
			"common.retry": "重试",
			"common.close": "收起",
			"confirm.discardChanges": "将丢弃 {count} 项未保存修改，确定继续吗？",
			"field.numberInvalid": "必须是 {range} 的有限数字",
			"field.hourInvalid": "必须是 0~23 的整点小时，逗号分隔",
			"group.post.desc": "每天自动发几条、几点发、配不配图、正文写什么",
			"group.social.desc": "给好友动态点赞、评论",
			"group.reply.desc": "回自己动态下面别人留的评论",
			"group.access.desc": "总开关与口令触发者",
		};
		var en = {
			"settings.title": "QQ Zone settings",
			"settings.desc": "Settings persist as the config override row of the dsh-qzone entry in the profile-layer cordis.patch.yml — the same source as hand-edited patches and the host's native settings page.",
			"settings.summary": "Posts QQ Zone updates every day, likes and comments on friends' posts, and replies to comments under its own posts.",
			"nav": "QQ Zone",
			"settings.loading": "Loading settings…",
			"settings.reload": "Reload",
			"settings.reset": "Reset to defaults",
			"save.submit": "Save settings",
			"save.saving": "Saving…",
			"save.done": "Settings saved. Hot-applied on save: the plugin restarts within seconds and the timers and interaction polls follow the new configuration.",
			"save.noChanges": "Nothing to save.",
			"save.badNumber": "Invalid number fields: {keys}",
			"save.dirtyBadge": "{count} unsaved",
			"save.noChangesTitle": "No unsaved changes",
			"effect.hint": "Hot-applied on save (no host restart): the plugin fiber restarts in place within seconds; timers, interaction polls and daily quotas restart with the new configuration, and an in-flight writing session is interrupted.",
			"effect.entryInactive": "The dsh-qzone entry is currently inactive; saving may not take effect. Check the plugin's load state.",
			"effect.entryInactiveTitle": "The plugin entry is inactive; changes may not take effect.",
			"conflict.title": "Save conflict: settings were changed by another source (revision mismatch). The latest snapshot has been re-fetched — review and retry.",
			"conflict.kept": "Kept {count} non-conflicting change(s) — review and save again.",
			"status.error": "Error",
			"status.title": "Today's activity",
			"status.date": "Date",
			"status.posts": "posts",
			"status.likes": "likes",
			"status.comments": "comments",
			"status.replies": "replies",
			"status.seen": "posts interacted with",
			"status.replied": "comments answered",
			"status.lastPost": "last post",
			"status.lastActivity": "last activity",
			"status.empty": "No run record yet (the state file is missing or unreadable).",
			"status.refresh": "Refresh status",
			"status.loadFailed": "Couldn't read the run status: {message}",
			"revision.label": "revision",
			"common.retry": "Retry",
			"common.close": "Dismiss",
			"confirm.discardChanges": "Discard {count} unsaved change(s)?",
			"field.numberInvalid": "Must be a finite number {range}",
			"field.hourInvalid": "Must be whole hours between 0 and 23, separated by commas",
			"group.post.desc": "How many posts a day, at which hours, with or without a picture, and what to write about",
			"group.social.desc": "Likes and comments on friends' posts",
			"group.reply.desc": "Answers comments left under its own posts",
			"group.access.desc": "Master switch and who may trigger it by keyword",
		};
		/** 双语 key 集一致性自检：缺漏仅告警不致崩溃。 */
		function assertSameKeys(a, b) {
			var missing = Object.keys(a).filter(function (key) { return !(key in b); });
			var extra = Object.keys(b).filter(function (key) { return !(key in a); });
			if (missing.length > 0 || extra.length > 0) {
				console.warn("[dsh-qzone] 双语词条 key 不齐 zh缺:" + missing.join(",") + " en缺:" + extra.join(","));
			}
		}
		assertSameKeys(zh, en);
		//#endregion

		//#region 面板样式（一次注入，随插件卸载移除；类名前缀 qz-）
		// 颜色全部走宿主主题变量（--dsw-*），带兜底值；不写死具体色值。
		var CSS = [
			".qz-panel{--qz-fg:var(--dsw-alias-label-primary,inherit);--qz-fg-muted:var(--dsw-alias-label-secondary,#6b7280);--qz-border:var(--dsw-alias-border-l1,rgba(128,128,128,.35));--qz-border-strong:var(--dsw-alias-border-l2,rgba(128,128,128,.6));--qz-card:var(--dsw-alias-fill-l1,rgba(128,128,128,.06));--qz-card-2:var(--dsw-alias-fill-l2,rgba(128,128,128,.12));--qz-accent:var(--dsw-alias-brand-primary,var(--dsh-accent,#2563eb));--qz-on-accent:var(--dsw-alias-label-primary-foreground,#fff);--qz-focus:var(--dsw-focus-ring-color,rgba(37,99,235,.45));--qz-error:var(--dsw-alias-state-error-primary,#e5484d);--qz-error-bg:var(--dsw-alias-state-error-secondary,rgba(229,72,77,.12));--qz-warn:var(--dsw-alias-state-warn-primary,#d97706);--qz-warn-bg:var(--dsw-alias-state-warn-secondary,rgba(217,119,6,.12));--qz-ok:var(--dsw-alias-state-success-primary,#2f9e63);--qz-ok-bg:var(--dsw-alias-state-success-secondary,rgba(47,158,99,.12));--qz-radius:10px;--qz-radius-sm:6px;display:flex;flex-direction:column;gap:16px;color:var(--qz-fg);font-size:14px;line-height:1.5;max-width:760px}",
			".qz-title{font-size:16px;font-weight:600;margin:0}",
			".qz-desc{color:var(--qz-fg-muted);font-size:12px;margin:4px 0 0}",
			".qz-toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}",
			".qz-footer{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:16px;padding-top:12px;border-top:1px solid var(--dsh-border,#8883)}",
			".qz-spacer{flex:1}",
			".qz-meta{color:var(--qz-fg-muted);font-size:11px;border:1px solid var(--qz-border);border-radius:999px;padding:1px 8px}",
			".qz-badge{color:var(--qz-fg-muted);font-size:11px;border:1px solid var(--qz-border);border-radius:999px;padding:0 8px}",
			".qz-warn{color:var(--qz-warn);background:var(--qz-warn-bg);border-color:var(--qz-warn)}",
			".qz-error{border:1px solid var(--qz-error);border-left-width:3px;background:var(--qz-error-bg);color:var(--qz-error);border-radius:var(--qz-radius-sm);padding:10px 12px;white-space:pre-wrap}",
			".qz-error::before{content:'!';font-weight:700;margin-right:6px}",
			".qz-notice{border:1px solid var(--qz-ok);border-left-width:3px;background:var(--qz-ok-bg);color:var(--qz-ok);border-radius:var(--qz-radius-sm);padding:10px 12px;white-space:pre-wrap}",
			".qz-notice::before{content:'✓';font-weight:700;margin-right:6px}",
			".qz-effect{border:1px dashed var(--qz-border);border-radius:var(--qz-radius-sm);padding:8px 12px;color:var(--qz-fg-muted);background:var(--qz-card);font-size:12px}",
			".qz-effect::before{content:'ⓘ';margin-right:6px}",
			".qz-group{display:flex;flex-direction:column;gap:12px;background:var(--qz-card);border:1px solid var(--qz-border);border-radius:var(--qz-radius);padding:14px 16px 16px}",
			".qz-group-title{font-size:14px;font-weight:600;margin:0}",
			".qz-group-desc{color:var(--qz-fg-muted);font-size:12px;margin:0}",
			".qz-field{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline}",
			".qz-label{font-size:13px;color:var(--qz-fg-muted);min-width:190px}",
			".qz-control{display:flex;flex-wrap:wrap;gap:8px;align-items:center;flex:1;min-width:240px}",
			".qz-input,.qz-select,.qz-textarea{flex:1;min-width:160px;max-width:420px;box-sizing:border-box;border:1px solid var(--qz-border);border-radius:var(--qz-radius-sm);background:transparent;color:inherit;padding:5px 10px;font-family:inherit;font-size:13px}",
			".qz-input,.qz-select{height:32px}",
			".qz-input--number{max-width:160px}",
			".qz-textarea{max-width:520px;min-height:72px;resize:vertical}",
			".qz-input:hover:not(:disabled),.qz-select:hover:not(:disabled),.qz-textarea:hover:not(:disabled){border-color:var(--qz-border-strong)}",
			".qz-input:focus-visible,.qz-select:focus-visible,.qz-textarea:focus-visible,.qz-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--qz-focus);border-color:var(--qz-accent)}",
			".qz-input:disabled,.qz-select:disabled,.qz-textarea:disabled{opacity:.45;cursor:not-allowed}",
			".qz-input--invalid{border-color:var(--qz-error);box-shadow:0 0 0 2px var(--qz-error)}",
			".qz-hint{color:var(--qz-fg-muted);font-size:12px;flex-basis:100%}",
			".qz-hint--invalid{color:var(--qz-error)}",
			".qz-toggle{position:relative;display:inline-flex;align-items:center;gap:8px;cursor:pointer;font-size:13px}",
			".qz-switch-input{position:absolute;left:6px;top:50%;width:24px;height:24px;margin:0;transform:translateY(-50%);opacity:0;cursor:pointer}",
			".qz-switch-track{position:relative;display:inline-block;flex:none;width:36px;height:20px;border-radius:999px;background:var(--qz-border-strong);transition:background 150ms ease}",
			".qz-switch-track::before{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform 150ms ease}",
			".qz-switch-input:checked + .qz-switch-track{background:var(--qz-accent)}",
			".qz-switch-input:checked + .qz-switch-track::before{transform:translateX(16px)}",
			".qz-switch-input:disabled + .qz-switch-track{opacity:.45;cursor:not-allowed}",
			".qz-switch-input:focus-visible + .qz-switch-track{box-shadow:0 0 0 2px var(--qz-focus)}",
			"@media (prefers-reduced-motion: reduce){.qz-switch-track,.qz-switch-track::before{transition:none}}",
			".qz-btn{cursor:pointer;border:1px solid var(--qz-border);border-radius:var(--qz-radius-sm);background:var(--qz-card-2);color:inherit;padding:6px 12px;height:32px;box-sizing:border-box;font-family:inherit;font-size:13px}",
			".qz-btn:hover:not(:disabled){border-color:currentColor}",
			".qz-btn:disabled{opacity:.45;cursor:not-allowed}",
			".qz-btn--primary{background:var(--qz-accent);color:var(--qz-on-accent);border:none;font-weight:600}",
			".qz-btn--primary:hover:not(:disabled){filter:brightness(1.06)}",
			".qz-stats{display:flex;flex-wrap:wrap;gap:8px}",
			".qz-stat{background:var(--qz-card-2);border:1px solid var(--qz-border);border-radius:var(--qz-radius-sm);padding:6px 10px;font-size:12px;color:var(--qz-fg-muted)}",
			".qz-stat b{color:var(--qz-fg);font-size:14px;margin-right:4px}",
			".qz-stat-row{display:flex;flex-wrap:wrap;gap:12px;color:var(--qz-fg-muted);font-size:12px}",
			"@media (max-width:640px){.qz-label{min-width:auto;width:100%}.qz-input,.qz-select,.qz-textarea{max-width:none}}",
		].join("\n");
		//#endregion

		//#region 工具（纯函数，模块级可测）
		function format(template, params) {
			return String(template).replace(/\{(\w+)\}/g, function (match, key) {
				return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match;
			});
		}
		function messageOf(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		/** RemoteResult 解包：{ok:true,value}|{ok:false,error:{message,code}}。 */
		function unwrap(result) {
			if (result != null && result.ok === true) return result.value;
			var detail = result != null && result.error != null ? result.error.message : "unknown remote error";
			var error = new Error(detail);
			if (result != null && result.error != null && result.error.code != null) error.code = result.error.code;
			throw error;
		}
		/** 保存冲突判定（host 抛 RemoteError('qzone-settings/conflict')）。 */
		var CONFLICT_RE = /qzone-settings\/conflict/i;
		function isConflictError(cause) {
			if (cause == null) return false;
			return cause.code === "qzone-settings/conflict" || CONFLICT_RE.test(String(cause.message || ""));
		}
		/** locale 取词：词条缺失时回落到调用方给的字面量（中文）。 */
		function pick(t, key, fallback) {
			var value = typeof t === "function" ? t(key) : undefined;
			if (value === undefined || value === null || value === "" || value === key) return fallback;
			return String(value);
		}
		/** 快照生效值 → 表单草稿（展示形态：数字 / 列表都是可编辑文本）。 */
		function snapshotValueToDraft(field, value) {
			if (field.type === "boolean") return value === true;
			if (field.type === "numberList") return Array.isArray(value) ? value.join(", ") : "";
			if (field.type === "timeList") return Array.isArray(value) ? value.join(", ") : "";
			if (field.type === "stringList") return Array.isArray(value) ? value.join("\n") : "";
			if (field.type === "number") return value === undefined || value === null ? "" : String(value);
			return value === undefined || value === null ? "" : String(value);
		}
		function draftFromSnapshot(snapshot) {
			var config = snapshot != null && snapshot.config != null ? snapshot.config : {};
			var draft = {};
			for (var field of ALL_FIELDS) draft[field.key] = snapshotValueToDraft(field, config[field.key]);
			return draft;
		}
		function draftFromDefaults() {
			return draftFromSnapshot({ config: DEFAULTS });
		}
		/** 草稿展示值 → patch 值；无法解析时返回 null（该键不进入 patch）。 */
		function coerceValue(field, raw) {
			if (field.type === "boolean") return raw === true;
			if (field.type === "enum") {
				// 下拉的值统一按字符串展示（option 的 value 是字符串），回填时映射回原始
				// option 值（ugcRight 是数字枚举，不能退化成字符串）。
				var text = String(raw == null ? "" : raw);
				if (Array.isArray(field.options)) {
					for (var option of field.options) {
						if (String(option) === text) return option;
					}
					return null;
				}
				return text;
			}
			if (field.type === "number") {
				var n = typeof raw === "number" ? raw : Number(String(raw).trim());
				return Number.isFinite(n) ? n : null;
			}
			if (field.type === "numberList") {
				var parts = String(raw == null ? "" : raw).split(/[\s,，、]+/).filter(function (part) { return part !== ""; });
				var out = [];
				for (var part of parts) {
					var hour = Number(part);
					if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
					out.push(hour);
				}
				return out;
			}
			if (field.type === "stringList") {
				return String(raw == null ? "" : raw).split(/\r?\n/).map(function (line) { return line.trim(); }).filter(function (line) { return line !== ""; });
			}
			if (field.type === "timeList") {
				// HH:MM 列表，逗号 / 空格 / 换行分隔。非法就返回 null（= 校验不通过）。
				var parts2 = String(raw == null ? "" : raw).split(/[\s,，、]+/).filter(function (part) { return part !== ""; });
				var times = [];
				for (var part2 of parts2) {
					var m2 = /^(\d{1,2})\s*[:：]\s*(\d{1,2})$/.exec(part2);
					if (!m2) return null;
					var hh = Number(m2[1]);
					var mm = Number(m2[2]);
					if (!Number.isInteger(hh) || hh < 0 || hh > 23) return null;
					if (!Number.isInteger(mm) || mm < 0 || mm > 59) return null;
					var text2 = String(hh).padStart(2, "0") + ":" + String(mm).padStart(2, "0");
					if (times.indexOf(text2) === -1) times.push(text2);
				}
				return times;
			}
			return String(raw == null ? "" : raw);
		}
		function valueEquals(a, b) {
			return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
		}
		/** 数字键的行内校验：null = 合法；字符串 = 合法范围文案。 */
		function numberRangeInvalid(field, raw) {
			if (field == null || field.type !== "number") return null;
			var range = Object.prototype.hasOwnProperty.call(NUMBER_RANGE, field.key) && Array.isArray(NUMBER_RANGE[field.key])
				? NUMBER_RANGE[field.key]
				: [0, undefined];
			var n = coerceValue(field, raw);
			if (n !== null && n >= range[0] && (range[1] === undefined || n <= range[1])) return null;
			return range[1] === undefined ? "≥" + range[0] : range[0] + "–" + range[1];
		}
		/** 小时数组的行内校验：null = 合法。 */
		function hourListInvalid(field, raw) {
			if (field == null || field.type !== "numberList") return null;
			return coerceValue(field, raw) === null ? "invalid" : null;
		}
		/** HH:MM 时刻数组的行内校验：null = 合法。 */
		function timeListInvalid(field, raw) {
			if (field == null || field.type !== "timeList") return null;
			return coerceValue(field, raw) === null ? "invalid" : null;
		}
		/**
		 * 计算保存 patch（与生效值有差异的键集合）。
		 * @returns { patch, invalidKeys } invalidKeys = 没通过客户端校验的键
		 *          （host validatePatch 仍会二次校验）。
		 */
		function computePatch(draft, config) {
			var current = config == null ? {} : config;
			var patch = {};
			var invalidKeys = [];
			for (var field of ALL_FIELDS) {
				var next = coerceValue(field, draft[field.key]);
				if (next === null) {
					invalidKeys.push(field.key);
					continue;
				}
				if (!valueEquals(next, current[field.key])) patch[field.key] = next;
			}
			return { patch: patch, invalidKeys: invalidKeys };
		}
		/** 脏状态派生：与保存流共用 computePatch 口径。 */
		function computeDirtyKeys(draft, config) {
			return Object.keys(computePatch(draft, config).patch);
		}
		/**
		 * 冲突合并保留：保存遇 revision 冲突重拉快照后，不丢弃未保存的编辑——
		 * 远端没变过的键保留本地草稿，远端变了的键跟随新快照（本地同改的键记为冲突）。
		 */
		function mergeOnConflict(draft, oldConfig, nextConfig) {
			var sourceDraft = draft == null ? {} : draft;
			var oldCfg = oldConfig == null ? {} : oldConfig;
			var nextCfg = nextConfig == null ? {} : nextConfig;
			var merged = {};
			var conflictKeys = [];
			var dirtyCount = 0;
			for (var field of ALL_FIELDS) {
				var remoteChanged = !valueEquals(oldCfg[field.key], nextCfg[field.key]);
				var dirty = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
					&& !valueEquals(coerceValue(field, sourceDraft[field.key]), oldCfg[field.key]);
				if (dirty) dirtyCount += 1;
				if (remoteChanged) {
					merged[field.key] = snapshotValueToDraft(field, nextCfg[field.key]);
					if (dirty) conflictKeys.push(field.key);
				}
				else {
					merged[field.key] = Object.prototype.hasOwnProperty.call(sourceDraft, field.key)
						? sourceDraft[field.key]
						: snapshotValueToDraft(field, nextCfg[field.key]);
				}
			}
			return { draft: merged, conflictKeys: conflictKeys, keptCount: dirtyCount - conflictKeys.length };
		}
		//#endregion

		//#region 渲染
		function h(tag, props) {
			var children = Array.prototype.slice.call(arguments, 2);
			return React.createElement.apply(React, [tag, props].concat(children));
		}
		/**
		 * 渲染一个设置分组（纯函数）。
		 * @param opts.onChange (field, nextDisplayValue) => void
		 * @param opts.draft 表单草稿
		 * @param opts.invalidKeys 已标红的键（行内提示）
		 * @param opts.nonDefaultKeys 与默认值不同的键（已保存状态徽标）
		 */
		function renderGroup(opts) {
			var options = opts == null ? {} : opts;
			var draft = options.draft == null ? {} : options.draft;
			var invalidKeys = Array.isArray(options.invalidKeys) ? options.invalidKeys : [];
			var nonDefaultKeys = Array.isArray(options.nonDefaultKeys) ? options.nonDefaultKeys : [];
			var onChange = typeof options.onChange === "function" ? options.onChange : function () {};
			var disabled = options.disabled === true;
			var fieldNodes = options.group.fields.map(function (field) {
				var value = draft[field.key];
				var invalid = invalidKeys.indexOf(field.key) >= 0;
				var control;
				if (field.type === "boolean") {
					control = h("label", { className: "qz-toggle" },
						h("input", {
							type: "checkbox",
							className: "qz-switch-input",
							checked: value === true,
							disabled: disabled,
							onChange: function (event) { onChange(field, event.target.checked); },
						}),
						h("span", { className: "qz-switch-track", "aria-hidden": "true" }),
						value === true ? "开" : "关");
				}
				else if (field.type === "enum") {
					control = h("select", {
						className: "qz-select",
						value: String(value == null ? "" : value),
						disabled: disabled,
						"aria-label": field.label,
						onChange: function (event) { onChange(field, event.target.value); },
					}, field.options.map(function (option) {
						return h("option", { key: String(option), value: String(option) },
							field.optionLabels[option] != null ? field.optionLabels[option] : String(option));
					}));
				}
				else if (field.type === "numberList") {
					control = h("input", {
						type: "text",
						className: "qz-input qz-input--number" + (invalid ? " qz-input--invalid" : ""),
						value: String(value == null ? "" : value),
						disabled: disabled,
						placeholder: "10, 14, 19",
						"aria-label": field.label,
						"aria-invalid": invalid ? "true" : undefined,
						onChange: function (event) { onChange(field, event.target.value); },
						onBlur: function (event) {
							if (typeof options.onValidate === "function") options.onValidate(field, event.target.value);
						},
					});
				}
				else if (field.type === "timeList") {
					control = h("input", {
						type: "text",
						className: "qz-input qz-input--number" + (invalid ? " qz-input--invalid" : ""),
						value: String(value == null ? "" : value),
						disabled: disabled,
						placeholder: "10:00, 14:37, 22:05",
						"aria-label": field.label,
						"aria-invalid": invalid ? "true" : undefined,
						onChange: function (event) { onChange(field, event.target.value); },
						onBlur: function (event) {
							if (typeof options.onValidate === "function") options.onValidate(field, event.target.value);
						},
					});
				}
				else if (field.type === "stringList") {
					control = h("textarea", {
						className: "qz-textarea",
						rows: 3,
						value: String(value == null ? "" : value),
						disabled: disabled,
						placeholder: "每行一个 QQ 号",
						"aria-label": field.label,
						onChange: function (event) { onChange(field, event.target.value); },
					});
				}
				else if (field.type === "text") {
					control = h("textarea", {
						className: "qz-textarea",
						rows: 3,
						value: String(value == null ? "" : value),
						disabled: disabled,
						placeholder: "例如：多写深海里的事",
						"aria-label": field.label,
						onChange: function (event) { onChange(field, event.target.value); },
					});
				}
				else {
					control = h("input", {
						type: "text",
						className: field.type === "number" ? "qz-input qz-input--number" : "qz-input",
						value: String(value == null ? "" : value),
						disabled: disabled,
						"aria-label": field.label,
						"aria-invalid": invalid ? "true" : undefined,
						onChange: function (event) { onChange(field, event.target.value); },
						onBlur: function (event) {
							if (typeof options.onValidate === "function") options.onValidate(field, event.target.value);
						},
					});
				}
				var hintChildren = [];
				if (field.hint != null) hintChildren.push(field.hint);
				if (invalid) {
					if (hintChildren.length > 0) hintChildren.push("；");
					hintChildren.push(h("span", { className: "qz-hint--invalid" },
						field.type === "numberList" ? "必须是 0~23 的整点小时，逗号分隔"
							: field.type === "timeList" ? "必须是 HH:MM 格式的时刻（00:00~23:59），逗号分隔"
								: "必须是合法数字"));
				}
				return h("div", { className: "qz-field", key: field.key },
					h("span", { className: "qz-label" }, field.label),
					nonDefaultKeys.indexOf(field.key) >= 0
						? h("span", { className: "qz-badge", title: "与默认值不同" }, "非默认")
						: null,
					control,
					hintChildren.length > 0
						? h.apply(null, ["span", { className: "qz-hint" }].concat(hintChildren))
						: null);
			});
			return h("section", { className: "qz-group", "data-group": options.group.id },
				h("h3", { className: "qz-group-title" }, options.group.title),
				options.group.desc != null
					? h("p", { className: "qz-group-desc" }, pick(options.t, "group." + options.group.id + ".desc", options.group.desc))
					: null,
				fieldNodes);
		}
		//#endregion

		//#region 面板组件
		/**
		 * QQ 空间设置面板。
		 * @param props.remote 挂载后的 `remote.qzoneSettings` API（apply 时注入）
		 */
		function QzoneSettingsPanel(props) {
			var remote = props.remote;
			var t = props.t;
			var snapshotState = React.useState(null);
			var snapshot = snapshotState[0];
			var setSnapshot = snapshotState[1];
			var draftState = React.useState(null);
			var draft = draftState[0];
			var setDraft = draftState[1];
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var noticeState = React.useState("");
			var notice = noticeState[0];
			var setNotice = noticeState[1];
			var conflictState = React.useState(false);
			var conflict = conflictState[0];
			var setConflict = conflictState[1];
			var invalidState = React.useState([]);
			var invalidKeys = invalidState[0];
			var setInvalidKeys = invalidState[1];
			var statusState = React.useState(null);
			var status = statusState[0];
			var setStatus = statusState[1];
			var statusErrorState = React.useState(null);
			var statusError = statusErrorState[0];
			var setStatusError = statusErrorState[1];
			var aliveRef = React.useRef(true);
			React.useEffect(function () {
				aliveRef.current = true;
				return function () { aliveRef.current = false; };
			}, []);

			/** 接受新快照：草稿按快照重置。 */
			var accept = function (next) {
				setSnapshot(next);
				setDraft(draftFromSnapshot(next));
				setInvalidKeys([]);
				setConflict(false);
			};

			/** 拉一次运行时状态（只读，失败不炸面板）。 */
			var loadStatus = function () {
				void Promise.resolve().then(function () {
					return remote.getStatus();
				}).then(function (result) {
					if (!aliveRef.current) return;
					setStatus(unwrap(result));
					setStatusError(null);
				}).catch(function (cause) {
					if (!aliveRef.current) return;
					setStatusError(messageOf(cause));
				});
			};

			React.useEffect(function () {
				var alive = true;
				void Promise.resolve().then(function () {
					return remote.getSettings();
				}).then(function (result) {
					if (!alive) return;
					accept(unwrap(result));
				}).catch(function (cause) {
					if (alive) setError(messageOf(cause));
				});
				loadStatus();
				return function () { alive = false; };
			}, [remote]);

			var refetch = function () {
				void Promise.resolve().then(function () {
					return remote.getSettings();
				}).then(function (result) {
					accept(unwrap(result));
					setError(null);
					setNotice("");
				}).catch(function (cause) {
					setConflict(false);
					setError(messageOf(cause));
				});
			};

			/** 冲突后重拉快照并尽量保留未冲突的本地编辑。 */
			var refetchMerged = function () {
				void Promise.resolve().then(function () {
					return remote.getSettings();
				}).then(function (result) {
					var next = unwrap(result);
					var merged = mergeOnConflict(draft, snapshot == null ? null : snapshot.config, next.config);
					setSnapshot(next);
					setDraft(merged.draft);
					setConflict(true);
					setInvalidKeys([]);
					setError(merged.keptCount > 0
						? pick(t, "conflict.title", "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。")
							+ " " + format(pick(t, "conflict.kept", "已保留 {count} 项未冲突的修改，请核对后重新保存。"), { count: merged.keptCount })
						: pick(t, "conflict.title", "保存冲突：设置已被其他来源修改（revision 不一致），已重新拉取最新配置，请检查后重试。"));
				}).catch(function (cause) {
					setConflict(false);
					setError(messageOf(cause));
				});
			};

			/** 保存统一通道：updateSettings(patch, expectedRevision)。 */
			var save = function () {
				if (busy || snapshot == null || draft == null) return;
				setError(null);
				setNotice("");
				setConflict(false);
				var computed = computePatch(draft, snapshot.config);
				if (computed.invalidKeys.length > 0) {
					var labels = computed.invalidKeys.map(function (key) {
						var field = ALL_FIELDS.find(function (item) { return item.key === key; });
						return field != null ? field.label : key;
					});
					setInvalidKeys(computed.invalidKeys);
					setError(format(pick(t, "save.badNumber", "数字字段不合法：{keys}"), { keys: labels.join("、") }));
					return;
				}
				if (Object.keys(computed.patch).length === 0) {
					setNotice(pick(t, "save.noChanges", "没有需要保存的变更。"));
					return;
				}
				setBusy(true);
				void Promise.resolve().then(function () {
					return remote.updateSettings(computed.patch, snapshot.revision);
				}).then(function (result) {
					accept(unwrap(result));
					setNotice(pick(t, "save.done", "设置已保存。"));
				}).catch(function (cause) {
					if (isConflictError(cause)) refetchMerged();
					else setError(messageOf(cause));
				}).finally(function () {
					setBusy(false);
				});
			};

			var dirtyKeys = snapshot === null || draft === null
				? []
				: computeDirtyKeys(draft, snapshot.config);
			var dirtyCount = dirtyKeys.length;

			/** 有未保存修改时先确认再丢弃（浏览器原生 confirm）。 */
			var confirmDiscard = function () {
				if (dirtyCount === 0) return true;
				return window.confirm(format(pick(t, "confirm.discardChanges", "将丢弃 {count} 项未保存修改，确定继续吗？"), { count: dirtyCount }));
			};
			var handleReload = function () {
				if (confirmDiscard()) refetch();
			};
			var handleReset = function () {
				if (!confirmDiscard()) return;
				setDraft(draftFromDefaults());
				setInvalidKeys([]);
			};
			var handleChange = function (field, nextValue) {
				setDraft(Object.assign({}, draft, (function () { var next = {}; next[field.key] = nextValue; return next; })()));
				// 已标红的键随输入重校验，修正后自动消红
				if (invalidKeys.indexOf(field.key) >= 0) {
					var stillInvalid = field.type === "number"
						? numberRangeInvalid(field, nextValue) !== null
						: field.type === "numberList"
							? hourListInvalid(field, nextValue) !== null
							: field.type === "timeList"
								? timeListInvalid(field, nextValue) !== null
								: false;
					if (!stillInvalid) {
						setInvalidKeys(invalidKeys.filter(function (key) { return key !== field.key; }));
					}
				}
			};

			/** 数字 / 小时数组的行内校验（失焦时标红）。 */
			var validateField = function (field, rawValue) {
				var problem = field.type === "number"
					? numberRangeInvalid(field, rawValue)
					: field.type === "numberList"
						? hourListInvalid(field, rawValue)
						: field.type === "timeList"
							? timeListInvalid(field, rawValue)
							: null;
				if (problem === null) {
					if (invalidKeys.indexOf(field.key) < 0) return;
					setInvalidKeys(invalidKeys.filter(function (key) { return key !== field.key; }));
					return;
				}
				if (invalidKeys.indexOf(field.key) >= 0) return;
				setInvalidKeys(invalidKeys.concat([field.key]));
			};

			if (snapshot === null || draft === null) {
				return h("div", { className: "qz-panel" },
					h("p", { className: "qz-hint" }, pick(t, "settings.loading", "正在加载设置…")),
					error === null ? null : h("div", { className: "qz-error", role: "alert" },
						pick(t, "status.error", "出错") + "：" + error),
					error === null ? null : h("button", { className: "qz-btn", type: "button", onClick: refetch },
						pick(t, "common.retry", "重试")));
			}

			// 「非默认」徽标数据源：快照生效值 vs schema 默认值（描述已保存状态）。
			var nonDefaultKeys = [];
			if (snapshot.config != null) {
				for (var field of ALL_FIELDS) {
					if (valueEquals(snapshot.config[field.key], DEFAULTS[field.key]) === false) nonDefaultKeys.push(field.key);
				}
			}

			var statusCard = h("section", { className: "qz-group", "data-group": "status" },
				h("h3", { className: "qz-group-title" }, pick(t, "status.title", "今天的运行情况")),
				statusError !== null
					? h("p", { className: "qz-hint" }, format(pick(t, "status.loadFailed", "读取运行状态失败：{message}"), { message: statusError }))
					: status === null
						? h("p", { className: "qz-hint" }, pick(t, "settings.loading", "正在加载设置…"))
						: h("div", { className: "qz-stats" },
							h("span", { className: "qz-stat" }, h("b", null, String(status.posts)), pick(t, "status.posts", "已发动态")),
							h("span", { className: "qz-stat" }, h("b", null, String(status.likes)), pick(t, "status.likes", "已点赞")),
							h("span", { className: "qz-stat" }, h("b", null, String(status.comments)), pick(t, "status.comments", "已评论")),
							h("span", { className: "qz-stat" }, h("b", null, String(status.replies)), pick(t, "status.replies", "已回评论")),
							h("span", { className: "qz-stat" }, h("b", null, String(status.seenCount)), pick(t, "status.seen", "互动过的动态")),
							h("span", { className: "qz-stat" }, h("b", null, String(status.repliedCount)), pick(t, "status.replied", "回过的评论"))),
				h("div", { className: "qz-stat-row" },
					h("span", null, pick(t, "status.date", "统计日期") + "：" + (status != null && status.date !== "" ? status.date : "—")),
					h("span", null, pick(t, "status.lastPost", "最后一条动态") + "：" + (status != null && status.lastPostAt !== "" ? status.lastPostAt : "—")),
					h("span", null, pick(t, "status.lastActivity", "最后活动") + "：" + (status != null && status.lastLogAt !== "" ? status.lastLogAt : "—"))),
				h("button", { className: "qz-btn", type: "button", onClick: loadStatus }, pick(t, "status.refresh", "刷新状态")));

			return h("div", { className: "qz-panel" },
				h("h2", { className: "qz-title" }, pick(t, "settings.title", "QQ 空间设置")),
				h("p", { className: "qz-desc" }, pick(t, "settings.desc", "")),
				h("div", { className: "qz-toolbar" },
					h("span", { className: "qz-meta" }, pick(t, "revision.label", "revision") + " " + String(snapshot.revision)),
					snapshot.entryActive === true ? null : h("span", {
						className: "qz-meta qz-warn",
						title: pick(t, "effect.entryInactiveTitle", "插件条目未激活，修改可能无法生效。"),
					}, pick(t, "effect.entryInactive", "dsh-qzone 条目当前未激活，保存后可能无法生效，请检查插件加载状态。")),
					h("span", { className: "qz-spacer" }),
					dirtyCount > 0 ? h("span", { className: "qz-badge qz-warn" },
						format(pick(t, "save.dirtyBadge", "{count} 项未保存"), { count: dirtyCount })) : null,
					h("button", { className: "qz-btn", type: "button", disabled: busy, onClick: handleReload },
						pick(t, "settings.reload", "重新加载")),
					h("button", { className: "qz-btn", type: "button", disabled: busy, onClick: handleReset },
						pick(t, "settings.reset", "恢复默认值"))),
				error === null ? null : h("div", { className: "qz-error" + (conflict ? " qz-error--conflict" : ""), role: "alert" },
					pick(t, "status.error", "出错") + "：" + error),
				notice === "" ? null : h("p", { className: "qz-notice" }, notice),
				h("div", { className: "qz-effect" }, pick(t, "effect.hint", "")),
				statusCard,
				GROUPS.map(function (group) {
					return renderGroup({
						group: group,
						t: t,
						draft: draft,
						disabled: busy,
						invalidKeys: invalidKeys,
						nonDefaultKeys: nonDefaultKeys,
						onChange: handleChange,
						onValidate: validateField,
					});
				}),
				// 保存按钮放在**末尾**：改完参数往下一路看，滚到底再点保存。
				h("div", { className: "qz-footer" },
					h("span", { className: "qz-spacer" }),
					dirtyCount > 0 ? h("span", { className: "qz-badge qz-warn" },
						format(pick(t, "save.dirtyBadge", "{count} 项未保存"), { count: dirtyCount })) : null,
					h("button", {
						className: "qz-btn qz-btn--primary",
						type: "button",
						disabled: busy || dirtyCount === 0 || invalidKeys.length > 0,
						title: invalidKeys.length > 0
							? format(pick(t, "save.badNumber", "数字字段不合法：{keys}"), { keys: invalidKeys.length })
							: dirtyCount === 0 ? pick(t, "save.noChangesTitle", "没有未保存的修改") : undefined,
						onClick: save,
					}, busy ? pick(t, "save.saving", "正在保存…") : pick(t, "save.submit", "保存设置"))));
		}
		//#endregion

		//#region 客户端入口
		var inject = ["slots", "locale", "remote"];
		/**
		 * 客户端入口：注入样式与词条、挂载 Typert Remote、注册设置面板。
		 * @returns {() => void} 卸载函数（样式/词条/slot 注册由宿主 ctx.effect 与
		 *          slot 生命周期回收，这里只回收 Remote 挂载）。
		 */
		async function apply(ctx) {
			ctx.effect(function () {
				var tag = document.createElement("style");
				tag.dataset.plugin = PLUGIN_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
				return function () { tag.remove(); };
			}, "qzone-settings: style");

			ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "qzone-settings: dictionaries");
			var t = ctx.locale.bind(NS);

			// namespace 是独立 Cordis 服务：必须挂载后 ctx.get() 获取，
			// 直接读 ctx.remote.qzoneSettings 会要求预先注入并死锁（与 onebot 样板同款）。
			var disposeRemote = await ctx.remote.$mount(QZONE_SETTINGS_REMOTE);
			var remote = ctx.get("remote." + REMOTE_NS);
			// Remote 不在位也别把整个插件页搞崩：照样注册面板，只显示一条提示。
			if (remote === undefined) {
				console.warn("[dsh-qzone] qzoneSettings Remote 挂载后不可用，设置面板将只读");
			}

			// DSH 的「设置」页左侧导航 = settings.section slot 的账本投影。
			// 宿主没有「按 schema 自动生成插件设置页」的机制（dsh-settings 的
			// autoGenerate 只是给未来客户端留的接口位），所以这一页得自己出。
			// 插件管理页那边就不注册了 —— 那边只剩宿主自带的「包含的组件」和「来源信息」。
			ctx.slots.inject("settings.section", function () { return ctx.slots.register(
				{ name: "settings.section", id: "qzone", order: 25, label: function () { return t("nav"); }, locale: NS },
				function (props) {
					if (remote === undefined) {
						return React.createElement("div", { className: "qz-panel" },
							React.createElement("p", { className: "qz-error", role: "alert" },
								"设置面板连不上宿主（qzoneSettings Remote 没挂上），暂时只能看不能改。"));
					}
					return React.createElement(QzoneSettingsPanel, Object.assign({}, props, { remote: remote, t: t }));
				},
			); });

			return function () { void disposeRemote(); };
		}
		//#endregion

		exports.inject = inject;
		exports.apply = apply;
		exports.QZONE_SETTINGS_REMOTE = QZONE_SETTINGS_REMOTE;
		exports.QZONE_SETTINGS_DESCRIPTORS = QZONE_SETTINGS_DESCRIPTORS;
		exports.GROUPS = GROUPS;
		exports.ALL_FIELDS = ALL_FIELDS;
		exports.DEFAULTS = DEFAULTS;
		exports.GROUP_KEYS = GROUP_KEYS;
		exports.NUMBER_RANGE = NUMBER_RANGE;
		exports.computePatch = computePatch;
		exports.computeDirtyKeys = computeDirtyKeys;
		exports.coerceValue = coerceValue;
		exports.snapshotValueToDraft = snapshotValueToDraft;
		exports.draftFromSnapshot = draftFromSnapshot;
		exports.numberRangeInvalid = numberRangeInvalid;
		exports.hourListInvalid = hourListInvalid;
		exports.timeListInvalid = timeListInvalid;
		exports.mergeOnConflict = mergeOnConflict;
		exports.isConflictError = isConflictError;
		exports.unwrap = unwrap;
		exports.renderGroup = renderGroup;
		exports.QzoneSettingsPanel = QzoneSettingsPanel;

		return module.exports;
	}
});
