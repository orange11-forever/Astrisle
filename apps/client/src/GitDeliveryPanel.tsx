import { useEffect, useState } from 'react';
import type { GitDeliveryReceipt, GitPullRequestStatus, HostAPI } from '@astrisle/contracts';

const deliveryNames = {
  prepared: '待确认',
  published: '已推送',
  blocked: '需要处理',
  unknown: '待核查',
};
const ciNames = {
  none: '尚无检查结果',
  pending: '检查中',
  passed: '检查通过',
  failed: '检查失败',
  unavailable: '检查状态暂不可用',
};

export function GitDeliveryPanel({ host, commissionId }: { host: HostAPI; commissionId: string }) {
  const [receipt, setReceipt] = useState<GitDeliveryReceipt | null>(null);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');
  const [pr, setPr] = useState<GitPullRequestStatus | null>();
  useEffect(() => {
    let active = true;
    setBusy(true);
    host.latestGitDelivery!(commissionId)
      .then((r) => {
        if (active) setReceipt(r);
      })
      .catch((e) => {
        if (active) setMessage(String(e.message ?? e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [commissionId, host]);
  async function run(work: () => Promise<void>) {
    setMessage('');
    setBusy(true);
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    const prepared = await host.prepareGitDelivery!(commissionId);
    setPr(undefined);
    const current = await host.latestGitDelivery!(commissionId);
    if (current?.preview.operationId !== prepared.operationId)
      throw new Error('预览已更新，请重新读取。');
    setReceipt(current);
  }
  const op = receipt?.preview.operationId;
  return (
    <section className="git-delivery" aria-label="Git 分支交付">
      <h3>Git 分支交付</h3>
      {!receipt && <p>从导入仓库的 origin 准备一条新分支，仅提交本次已验收的改动。</p>}
      {receipt && (
        <>
          <p>
            <strong>{deliveryNames[receipt.status]}</strong>
            {receipt.message && ` · ${receipt.message}`}
          </p>
          <dl>
            <dt>远端</dt>
            <dd>{receipt.preview.remote}</dd>
            <dt>基线</dt>
            <dd>
              {receipt.preview.baseBranch} · <code>{receipt.preview.baseCommit.slice(0, 12)}</code>
            </dd>
            <dt>目标分支</dt>
            <dd>
              <code>{receipt.preview.targetBranch}</code>
            </dd>
            {receipt.commit && (
              <>
                <dt>提交</dt>
                <dd>
                  <code>{receipt.commit}</code>
                </dd>
              </>
            )}
          </dl>
          <details key={op}>
            <summary>查看文件差异（{receipt.preview.changes.length}）</summary>
            <ul>
              {receipt.preview.changes.map((change) => (
                <li key={change.path}>
                  {change.action === 'add' ? '新增' : '修改'} · {change.path}（{change.size} 字节）
                </li>
              ))}
            </ul>
            {receipt.preview.diff && <pre>{receipt.preview.diff}</pre>}
            {receipt.preview.diffTruncated && <p>差异预览已截断。</p>}
          </details>
        </>
      )}
      <div className="button-row">
        {(!receipt || receipt.status === 'blocked' || receipt.status === 'published') && (
          <button disabled={busy} onClick={() => void run(preview)}>
            {receipt?.status === 'published' ? '预览当前验收成果' : '预览 Git 推送'}
          </button>
        )}
        {(receipt?.status === 'prepared' || receipt?.status === 'unknown') && op && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await host.publishGitDelivery!(commissionId, op);
                if (result) setReceipt(result);
                else setMessage('已取消本次推送。');
              })
            }
          >
            {receipt.status === 'unknown' ? '核查并重试原推送' : '确认并推送新分支'}
          </button>
        )}
        {(receipt?.status === 'unknown' || receipt?.status === 'published') && op && (
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                setReceipt(await host.inspectGitDelivery!(commissionId, op));
              })
            }
          >
            核查远端分支
          </button>
        )}
      </div>
      {receipt?.status === 'published' && receipt.compareUrl && op && (
        <>
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() =>
                void run(() =>
                  host.openGitDeliveryOnGitHub!(commissionId, op, pr ? 'pr' : 'compare'),
                )
              }
            >
              {pr ? `打开 PR #${pr.number}` : '在 GitHub 创建或查看 PR'}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => setPr(await host.getGitPullRequestStatus!(commissionId, op)))
              }
            >
              查询 PR 与 CI
            </button>
          </div>
          {pr === null && <p>尚未找到关联到这个提交和目标分支的公开 PR。</p>}
          {pr && (
            <p>
              PR #{pr.number} · {{ open: '已打开', closed: '已关闭', merged: '已合并' }[pr.state]} ·{' '}
              已推送提交：{ciNames[pr.checks]}
            </p>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
