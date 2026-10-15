import { createHmac } from 'node:crypto';

const webhook = process.env.FEISHU_RELEASE_WEBHOOK_URL;
if (!webhook) {
  console.log('[notify] 未配置飞书机器人，跳过');
} else {
  const success = process.env.RELEASE_RESULT === 'success';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const secret = process.env.FEISHU_RELEASE_WEBHOOK_SECRET;
  const url = `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const body = {
    ...(secret ? { timestamp, sign: createHmac('sha256', `${timestamp}\n${secret}`).update('').digest('base64') } : {}),
    msg_type: 'interactive',
    card: {
      header: { template: success ? 'green' : 'red', title: { tag: 'plain_text', content: `Mobile ${process.env.RELEASE_STAGE} ${success ? '成功' : '失败/未完成'}` } },
      elements: [{ tag: 'markdown', content: `触发人：${process.env.GITHUB_ACTOR}\n结果：${process.env.RELEASE_RESULT}\n[查看流水线与产物](${url})${process.env.BUILD_RUN_ID ? `\n来源构建：${process.env.BUILD_RUN_ID}` : ''}` }],
    },
  };
  const response = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok || (result.code ?? result.StatusCode) !== 0) throw new Error('飞书通知未被接受，请检查机器人配置');
  console.log('[notify] 机器人已接受消息');
}
