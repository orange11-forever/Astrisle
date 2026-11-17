import { FolderOpen, RotateCcw, SearchCheck } from 'lucide-react';
import type { ApplyOperation, ApplyPreview } from '@astrisle/contracts';

const statusNames: Record<string, string> = {
  prepared: '预览已准备',
  applying: '正在写回',
  applied: '写回完成',
  rolling_back: '正在恢复',
  rolled_back: '已恢复',
  interrupted: '写回中断',
  conflict: '未执行／有冲突',
  unknown: '结果待核查',
};
const fileStates: Record<string, string> = {
  before: '写回前状态',
  after: '已写入',
  reserved: '已预留空文件',
  diverged: '内容或身份已变化',
  missing: '文件缺失',
  unknown: '状态未知',
};
export function WritebackHistory({
  operations,
  busy,
  onInspect,
  onRollback,
  onBackups,
}: {
  operations: ApplyOperation[];
  busy: boolean;
  onInspect: (id: string) => void;
  onRollback: (id: string) => void;
  onBackups: (id: string) => void;
}) {
  const visible = operations.filter((op) => op.status !== 'prepared');
  if (!visible.length) return null;
  return (
    <section className="writeback-history" aria-label="写回记录">
      <h3>写回记录</h3>
      <p className="quiet">中断或结果未知时先核查，再决定是否恢复。备份与逐文件记录会保留。</p>
      {visible.map((op) => (
        <details
          className="evidence"
          key={op.operationId}
          open={['unknown', 'interrupted', 'applying', 'rolling_back'].includes(op.status)}
        >
          <summary>
            <span>
              <b>{statusNames[op.status]}</b>
              <small>
                {op.createdAt ? new Date(op.createdAt).toLocaleString('zh-CN') : '时间未知'}
              </small>
            </span>
          </summary>
          <p>{op.message}</p>
          <p className="code-text">{op.sourcePath}</p>
          {op.conflicts.length > 0 && (
            <p className="error-text">需要核对：{op.conflicts.join('、')}</p>
          )}
          {op.files.length > 0 && (
            <ul className="writeback-files">
              {op.files.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code>
                  <span>{fileStates[file.state] ?? file.state}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="button-row">
            <button disabled={busy} onClick={() => onInspect(op.operationId)}>
              <SearchCheck size={15} />
              核查状态
            </button>
            <button
              disabled={busy || op.status === 'rolled_back' || op.status === 'conflict'}
              onClick={() => onRollback(op.operationId)}
            >
              <RotateCcw size={15} />
              准备恢复
            </button>
            <button disabled={busy} onClick={() => onBackups(op.operationId)}>
              <FolderOpen size={15} />
              备份与记录
            </button>
          </div>
          <small className="quiet">记录编号：{op.operationId}</small>
        </details>
      ))}
    </section>
  );
}
export function WritebackPreview({ preview }: { preview: ApplyPreview }) {
  return (
    <>
      <p>
        {preview.mode === 'rollback'
          ? '将恢复下面这些文件，并移除本次新增且仍保持原样的文件。空目录、备份和记录会保留。'
          : '下面列出将写入原项目的更改。请核对目标目录、内容和冲突。'}
      </p>
      {preview.sourcePath && <p className="code-text">{preview.sourcePath}</p>}
      {!preview.supported && (
        <p className="error-text">
          {preview.reason || '当前项目不支持此操作，请先核查或导出成果。'}
        </p>
      )}
      {preview.conflicts.map((path) => (
        <p className="error-text" key={path}>
          {path}
        </p>
      ))}
      <ul className="apply-list">
        {preview.changes.map((change) => (
          <li key={change.path}>
            <b>
              {change.action === 'create'
                ? '新增'
                : change.action === 'modify'
                  ? '修改'
                  : preview.mode === 'rollback'
                    ? '移除本次新增'
                    : '删除'}
            </b>
            <code>{change.path}</code>
            {(change.beforeText !== undefined || change.afterText !== undefined) && (
              <details className="writeback-diff">
                <summary>查看内容对比</summary>
                {change.truncated && (
                  <p className="quiet">
                    内容较长，仅显示每个版本前 8 KiB；实际写入仍校验完整文件。
                  </p>
                )}
                <div className="writeback-diff-columns">
                  <section>
                    <h4>当前版本</h4>
                    <pre>{change.beforeText ?? '（文件不存在）'}</pre>
                  </section>
                  <section>
                    <h4>{preview.mode === 'rollback' ? '恢复到' : '已验收版本'}</h4>
                    <pre>{change.afterText ?? '（文件将移除）'}</pre>
                  </section>
                </div>
              </details>
            )}
            {change.binary && <p className="quiet">二进制文件，按完整内容哈希核对。</p>}
          </li>
        ))}
      </ul>
    </>
  );
}
