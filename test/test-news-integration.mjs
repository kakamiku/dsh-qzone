// 集成测试：defaultSource='news' 时，插件能不能真的抓到新闻当素材并写出正文（dryRun，不发）。
import { testing } from 'file:///C:/Users/Lenovo/.dsh/profiles/desktop/local-plugins/dsh-qzone/index.js';

const calls = [];
const fakeClient = {
  call: async (action, params) => { calls.push(action); return { tid: 'dry', time: Date.now() }; },
};
const deps = {
  client: fakeClient,
  config: {
    dailyLimit: 3, ugcRight: 1, withImage: false, publishToPublicFeed: false,
    botQQ: '3148436483', writerPrompt: '', defaultSource: 'news',
    newsLimit: 4, newsFeeds: [], localImageDir: '',
    socialEnabled: false, socialLikeLimit: 0, socialCommentLimit: 0,
    socialFeedCount: 20, socialAllowUsers: [], socialBlockUsers: [],
    socialMaxPerPoll: 1, socialFreshHours: 24,
    replyEnabled: false, replyDailyLimit: 0, replySkipSelf: true, replyMaxPerPoll: 0,
  },
  state: null,
  getController: () => undefined,   // 没有模型 -> 走兜底模板
  log: (level, msg) => { if (level === 'error' || level === 'warn') console.log('  [warn]', msg); },
};

const result = await testing.runOnce(deps, { dryRun: true });
console.log('结果 ok =', result.ok, '| reason =', result.reason ?? '-');
console.log('来源 =', result.source ?? '-', '| 写作方式 =', result.writer ?? '-');
console.log('正文 =', JSON.stringify(result.content ?? result.message ?? ''));
console.log('发出的 action =', JSON.stringify(calls));
