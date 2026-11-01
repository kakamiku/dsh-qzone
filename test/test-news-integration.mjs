// ���ɲ��ԣ�defaultSource='news' ʱ������ܲ������ץ�����ŵ��زĲ�д�����ģ�dryRun����������
import { testing } from 'file:///C:/Users/Lenovo/.dsh/profiles/desktop/local-plugins/dsh-qzone/index.js';

const calls = [];
const fakeClient = {
  call: async (action, params) => { calls.push(action); return { tid: 'dry', time: Date.now() }; },
};
const deps = {
  client: fakeClient,
  config: {
    dailyLimit: 999, ugcRight: 1, imageRatio: 0,
    botQQ: '3148436483', writerPrompt: '', defaultSource: 'news',
    newsLimit: 4, newsFeeds: [], localImageDir: '',
    newsLike: [], newsDislike: [], newsKeywords: [], newsFollowBiliPreferences: false,
    socialEnabled: false, socialLikeLimit: 0, socialCommentLimit: 0,
    socialFeedCount: 20, socialAllowUsers: [], socialBlockUsers: [],
    socialMaxPerPoll: 1, socialFreshHours: 24,
    replyEnabled: false, replyDailyLimit: 0, replySkipSelf: true, replyMaxPerPoll: 0,
  },
  state: null,
  getController: () => undefined,   // û��ģ�� -> �߶���ģ��
  log: (level, msg) => { if (level === 'error' || level === 'warn') console.log('  [warn]', msg); },
};

const result = await testing.runOnce(deps, { dryRun: true });
console.log('��� ok =', result.ok, '| reason =', result.reason ?? '-');
console.log('��Դ =', result.source ?? '-', '| д����ʽ =', result.writer ?? '-');
console.log('���� =', JSON.stringify(result.content ?? result.message ?? ''));
console.log('������ action =', JSON.stringify(calls));
