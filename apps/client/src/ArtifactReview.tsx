import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { FileText, GitCompare, RotateCcw } from 'lucide-react';
import type {
  Artifact,
  ArtifactComparison,
  ArtifactReworkInput,
  Evidence,
  HostAPI,
  ProjectSnapshot,
  Task,
} from '@astrisle/contracts';

const versionStatus = {
  current: '当前版本',
  stale: '历史版本',
  missing: '文件缺失',
};
const reviewStatus = {
  passed: '复核通过',
  failed: '复核要求修改',
  not_run: '未能通过复核',
};
const checkStatus = {
  passed: '通过',
  failed: '失败',
  not_run: '未运行',
};
const diffLimit: Partial<Record<NonNullable<ArtifactComparison['reason']>, string>> = {
  'missing-version': '有版本的文件缺失，无法对比。',
  'read-failed': '无法读取版本文件。',
  'integrity-mismatch': '版本文件完整性校验失败。',
  'input-limit': '文件过大，超出文本对比的大小上限。',
  'line-limit': '文本行数过多，超出对比上限。',
  'work-limit': '文件差异过多，超出计算上限。',
  'output-limit': '仅显示部分差异。',
};
const reworkErrors: Record<string, string> = {
  stale_revision: '委托要求已变更。请重新检查当前版本后再发起返工。',
  stale_version: '成果版本已变更。请重新检查当前版本后再发起返工。',
  artifact_accepted: '该版本已接受，无法发起返工。',
  source_rework_required: '请从源成果发起返工。',
  terminal: '委托当前无法发起返工。',
  task_running: '还有任务正在运行。请等任务暂停或结束后再试。',
  approval_required: '请先处理待审批的请求。',
  outcome_unknown: '请先核查结果未知的工具操作。',
  budget_exhausted: '委托预算已用完。调整预算后可以重试。',
  rework_budget_exhausted: '返工次数已达预算上限。调整预算后可以重试。',
  request_conflict: '该返工请求与之前的提交冲突。请检查最新成果状态。',
  invalid_input: '请填写有效的返工要求。',
  invalid_artifact: '该版本暂时无法返工。请确认文件可预览，且产出任务已完成提交。',
  request_pending: '相关任务有待处理的请求。请在「输入与审批」处理后重试。',
  path_conflict: '另一项当前成果使用同一文件路径。请修订委托，给两项成果指定不同路径。',
  closing: '工作室正在关闭。重新打开后可以重试。',
};
const reworkStatus: Record<Task['status'], string> = {
  queued: '返工待开始',
  waiting_dependency: '返工等待前置任务',
  running: '正在返工',
  waiting_input: '返工等待输入',
  waiting_approval: '返工等待审批',
  awaiting_review: '返工结果待复核',
  rework_required: '返工结果需要修改',
  passed: '返工已通过复核',
  failed: '返工未完成',
  cancelled: '返工已取消',
};
const timestamp = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const instructionLimit = 4_000;

function VersionDate({ value }: { value: string }) {
  const date = Date.parse(value);
  return Number.isFinite(date) ? <time dateTime={value}>{timestamp.format(date)}</time> : null;
}

function ReviewEvidence({
  reviews,
  evidence,
  current,
}: {
  reviews: Evidence[];
  evidence: Evidence[];
  current: boolean;
}) {
  const latest = reviews.at(-1);
  if (!latest) {
    return <span className="status status-not_run">{current ? '待复核' : '无复核记录'}</span>;
  }

  const records = [...reviews].reverse().map((review) => {
    let references: unknown;
    try {
      references = JSON.parse(review.detail)?.evidenceIds;
    } catch {
      // Older records can contain a plain-text review detail.
    }
    const checks = Array.isArray(references)
      ? evidence.filter(
          (item) =>
            item.kind !== 'review' && references.includes(item.id) && item.taskId === review.taskId,
        )
      : [];
    return { review, checks };
  });
  return (
    <div className="version-review">
      <div className="version-review-summary">
        <span className={`status status-${latest.status}`}>{reviewStatus[latest.status]}</span>
        {latest.summary && <span>{latest.summary}</span>}
      </div>
      <details className="version-evidence">
        <summary>复核证据</summary>
        <ol>
          {records.map(({ review, checks }) => (
            <li key={review.id}>
              <div className="version-evidence-heading">
                {review.id !== latest.id && <span>{reviewStatus[review.status]}</span>}
                <VersionDate value={review.createdAt} />
              </div>
              {review.id !== latest.id && <span>{review.summary}</span>}
              {checks.length > 0 && (
                <ul>
                  {checks.map((check) => (
                    <li key={check.id}>
                      <details>
                        <summary>
                          {check.summary} · {checkStatus[check.status]}
                        </summary>
                        <pre>{check.detail}</pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function ComparisonResult({
  comparison,
  versions,
}: {
  comparison: ArtifactComparison;
  versions: Artifact[];
}) {
  const { from, to, kind, hunks, reason, truncated } = comparison;
  const status = reason && diffLimit[reason];
  return (
    <section aria-label="版本差异" className="version-diff">
      {kind === 'unchanged' && <p>文件内容完全相同。</p>}
      {kind === 'binary' && <p>二进制文件内容有变化。可查看两版的文件信息。</p>}
      {kind === 'unavailable' && <p>{status || '无法对比这两个版本。'}</p>}
      {kind === 'text' && (
        <>
          {truncated && <p>{status || '仅显示部分差异。'}</p>}
          {!truncated && hunks.length === 0 && <p>正文行相同，换行或编码标记有变化。</p>}
          {hunks.length > 0 && (
            <div className="version-diff-scroll" role="group" aria-label="文本差异" tabIndex={0}>
              {hunks.map((hunk, index) => (
                <div key={index} className="version-diff-hunk">
                  {hunk.lines.map((line) => (
                    <div
                      key={`${line.oldLine ?? ''}:${line.newLine ?? ''}`}
                      className={`version-diff-line version-diff-${line.kind}`}
                    >
                      <span aria-hidden="true">{line.oldLine ?? ''}</span>
                      <span aria-hidden="true">{line.newLine ?? ''}</span>
                      <span aria-hidden="true">
                        {line.kind === 'addition' ? '+' : line.kind === 'deletion' ? '-' : ''}
                      </span>
                      {line.kind !== 'context' && (
                        <span className="version-sr-only">
                          {line.kind === 'addition' ? '新增' : '删除'}
                        </span>
                      )}
                      <code>{line.text}</code>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {(kind === 'binary' || kind === 'unavailable') && (
        <div className="version-metadata">
          {[from, to].map((artifact) => (
            <div key={artifact.versionId}>
              <strong>
                第 {versions.findIndex((item) => item.versionId === artifact.versionId) + 1} 版
              </strong>
              <dl>
                <dt>类型</dt>
                <dd>{artifact.mediaType || '类型未知'}</dd>
                <dt>大小</dt>
                <dd>{artifact.size.toLocaleString('zh-CN')} 字节</dd>
                <dt>SHA-256</dt>
                <dd>
                  <code>{artifact.sha256}</code>
                </dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function VersionCompare({
  versions,
  commissionId,
  compare,
}: {
  versions: Artifact[];
  commissionId: string;
  compare: HostAPI['compareArtifacts'];
}) {
  const labelId = useId();
  const [from, setFrom] = useState(versions.at(-2)!.versionId);
  const [to, setTo] = useState(versions.at(-1)!.versionId);
  const [comparison, setComparison] = useState<ArtifactComparison>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const options = versions.map((version, index) => (
    <option key={version.versionId} value={version.versionId}>
      第 {index + 1} 版 · {versionStatus[version.validity]}
    </option>
  ));
  const valid =
    from !== to &&
    versions.some((version) => version.versionId === from) &&
    versions.some((version) => version.versionId === to);
  const compareVersions = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true);
    setError('');
    setComparison(undefined);
    try {
      setComparison(await compare({ commissionId, fromVersionId: from, toVersionId: to }));
    } catch {
      setError('无法对比所选版本。请重新选择版本后重试。');
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="version-operation">
      <form onSubmit={compareVersions} aria-busy={pending} className="version-compare-form">
        <div className="version-compare-fields">
          <div>
            <label htmlFor={`${labelId}-from`}>基准版本</label>
            <select
              id={`${labelId}-from`}
              value={from}
              disabled={pending}
              onChange={(event) => {
                setFrom(event.target.value);
                setComparison(undefined);
                setError('');
              }}
            >
              {options}
            </select>
          </div>
          <div>
            <label htmlFor={`${labelId}-to`}>对比版本</label>
            <select
              id={`${labelId}-to`}
              value={to}
              disabled={pending}
              onChange={(event) => {
                setTo(event.target.value);
                setComparison(undefined);
                setError('');
              }}
            >
              {options}
            </select>
          </div>
        </div>
        <button type="submit" disabled={!valid || pending}>
          {pending ? '正在对比…' : '查看差异'}
        </button>
      </form>
      {error && (
        <p className="version-error" role="alert">
          {error}
        </p>
      )}
      <span className="version-sr-only" aria-live="polite">
        {comparison && valid ? '版本差异已加载' : ''}
      </span>
      {comparison && valid && <ComparisonResult comparison={comparison} versions={versions} />}
    </div>
  );
}

function ReworkForm({
  target,
  snapshot,
  disabled,
  submit,
  onDone,
}: {
  target: { artifact: Artifact; revision: number };
  snapshot: ProjectSnapshot;
  disabled: boolean;
  submit: HostAPI['requestArtifactRework'];
  onDone: (message: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  const lastRequest = useRef<ArtifactReworkInput>(undefined);
  const outdated =
    snapshot.commission.revision !== target.revision ||
    !snapshot.artifacts.some(
      ({ versionId, validity }) =>
        versionId === target.artifact.versionId && validity === 'current',
    ) ||
    snapshot.commission.acceptedArtifactIds.includes(target.artifact.id);
  const currentError = error || (outdated && !pending ? reworkErrors.stale_version : '');
  useEffect(() => field.current?.focus(), []);

  const requestRework = async (event: FormEvent) => {
    event.preventDefault();
    const text = instruction.trim();
    if (!text || pending || disabled || outdated) return;
    const { commission } = snapshot;
    setPending(true);
    setError('');
    try {
      if (lastRequest.current?.instruction !== text) {
        lastRequest.current = {
          commissionId: commission.id,
          artifactId: target.artifact.id,
          versionId: target.artifact.versionId,
          revision: target.revision,
          instruction: text,
          requestId: crypto.randomUUID(),
        };
      }
      const result = await submit(lastRequest.current);
      if (!result.ok) {
        setError(reworkErrors[result.code ?? ''] || '返工提交失败。请检查最新委托状态后重试。');
        return;
      }
      onDone(
        commission.status === 'paused'
          ? '返工已提交。继续委托后开始。'
          : '返工已提交。成果生成后可在这里查看新版本。',
      );
    } catch {
      setError('未收到返工提交结果。可使用原要求重试。');
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="version-operation version-rework-form"
      onSubmit={requestRework}
      aria-busy={pending}
    >
      <label>
        返工要求
        <textarea
          ref={field}
          value={instruction}
          onChange={(event) => {
            setInstruction(event.target.value);
            setError('');
          }}
          rows={3}
          placeholder="说明需要修改的内容"
          maxLength={instructionLimit}
          disabled={pending || outdated}
        />
      </label>
      {currentError && (
        <p className="version-error" role="alert">
          {currentError}
        </p>
      )}
      <button
        type="submit"
        className="primary"
        disabled={!instruction.trim() || pending || disabled || outdated}
      >
        {pending ? '正在提交…' : '提交返工'}
      </button>
    </form>
  );
}

type ArtifactReviewProps = {
  snapshot: ProjectSnapshot;
  busy: boolean;
  selectable: ReadonlySet<string>;
  selected: ReadonlySet<string>;
  onSelect: (artifactId: string, checked: boolean) => void;
  onPreview: (artifactId: string) => void;
  onTask: (taskId: string) => void;
  compare: HostAPI['compareArtifacts'];
  submitRework: HostAPI['requestArtifactRework'];
};

function ArtifactFamily({
  versions,
  evidenceByVersion,
  sourceGroup,
  snapshot,
  busy,
  selectable,
  selected,
  onSelect,
  onPreview,
  onTask,
  compare,
  submitRework,
}: ArtifactReviewProps & {
  versions: Artifact[];
  evidenceByVersion: Map<string, Evidence[]>;
  sourceGroup: ReadonlyMap<string, string>;
}) {
  const head =
    versions.filter((version) => version.validity === 'current').at(-1) ?? versions.at(-1)!;
  const history = versions.filter((version) => version !== head).reverse();
  const [operation, setOperation] = useState<'compare' | 'rework'>();
  const [target, setTarget] = useState<{ artifact: Artifact; revision: number }>();
  const [notice, setNotice] = useState('');
  const accepted = new Set(snapshot.commission.acceptedArtifactIds);
  const versionIds = new Set(versions.map(({ versionId }) => versionId));
  const lastRework = snapshot.tasks
    .filter(
      (task) =>
        task.kind !== 'review' &&
        task.artifactRework &&
        versionIds.has(task.artifactRework.versionId),
    )
    .at(-1);
  const author = snapshot.tasks.find((task) => task.id === head.taskId);
  const mayRequestRework =
    head.validity === 'current' &&
    !head.renderedFromVersionId &&
    !accepted.has(head.id) &&
    (snapshot.commission.status === 'paused' ||
      snapshot.commission.status === 'awaiting_acceptance') &&
    author?.kind !== 'review' &&
    (author?.status === 'passed' || author?.status === 'awaiting_review') &&
    !snapshot.tasks.some((task) => task.status === 'running') &&
    !snapshot.requests.some((request) => request.kind === 'approval' && request.status === 'open');
  const renderVersion = (version: Artifact, main: boolean) => {
    const ordinal = versions.indexOf(version) + 1;
    const evidence = evidenceByVersion.get(version.versionId) ?? [];
    const source = version.renderedFromVersionId
      ? snapshot.artifacts.find((item) => item.versionId === version.renderedFromVersionId)
      : undefined;
    return (
      <div className={`artifact-version${main ? ' artifact-version-main' : ''}`}>
        <div className="artifact-version-title">
          {version.validity === 'current' && (
            <input
              aria-label={`选择成果 ${version.name}`}
              type="checkbox"
              disabled={busy || !selectable.has(version.id)}
              checked={selected.has(version.id) || accepted.has(version.id)}
              onChange={(event) => onSelect(version.id, event.target.checked)}
            />
          )}
          <button
            type="button"
            className="artifact-name"
            aria-label={`预览第 ${ordinal} 版 ${version.name}`}
            disabled={busy || version.validity === 'missing'}
            onClick={() => onPreview(version.id)}
          >
            {main && <FileText size={18} aria-hidden="true" />}
            <span>
              <b>{main ? version.name : `第 ${ordinal} 版`}</b>
              {main && version.relativePath !== version.name && (
                <small>{version.relativePath}</small>
              )}
            </span>
          </button>
        </div>
        <div className="artifact-version-meta">
          {main && <span>第 {ordinal} 版</span>}
          <span className={`status status-${version.validity}`}>
            {versionStatus[version.validity]}
          </span>
          {accepted.has(version.id) && <span className="status status-accepted">已接受</span>}
          <VersionDate value={version.createdAt} />
        </div>
        {version.renderedFromVersionId && (
          <div className="version-source">
            {source && source.validity !== 'missing' ? (
              <button
                type="button"
                className="text-button"
                disabled={busy}
                onClick={() => onPreview(source.id)}
              >
                预览源版本 {source.relativePath}
              </button>
            ) : (
              <span>源版本文件不可用</span>
            )}
          </div>
        )}
        <ReviewEvidence
          reviews={evidence.filter(({ kind }) => kind === 'review')}
          evidence={evidence}
          current={version.validity === 'current'}
        />
      </div>
    );
  };
  const sourceGroupId = head.renderedFromVersionId && sourceGroup.get(head.renderedFromVersionId);
  return (
    <section
      className="artifact-family"
      aria-label={`成果版本 ${head.relativePath}`}
      id={`artifact-group-${versions[0].versionId}`}
      tabIndex={-1}
    >
      {renderVersion(head, true)}
      {history.length > 0 && (
        <details className="artifact-history">
          <summary>版本历史（{versions.length}）</summary>
          <ol>
            {history.map((version) => (
              <li key={version.versionId}>{renderVersion(version, false)}</li>
            ))}
          </ol>
        </details>
      )}
      <div className="artifact-actions">
        {versions.length > 1 && (
          <button
            type="button"
            aria-expanded={operation === 'compare'}
            onClick={() => setOperation(operation === 'compare' ? undefined : 'compare')}
          >
            <GitCompare size={15} aria-hidden="true" /> 对比版本
          </button>
        )}
        {head.validity === 'current' && !accepted.has(head.id) && sourceGroupId && (
          <button type="button" onClick={() => document.getElementById(sourceGroupId)?.focus()}>
            转到源成果返工
          </button>
        )}
        {(mayRequestRework || operation === 'rework') && (
          <button
            type="button"
            disabled={busy}
            aria-expanded={operation === 'rework'}
            onClick={() => {
              setTarget({ artifact: head, revision: snapshot.commission.revision });
              setOperation(operation === 'rework' ? undefined : 'rework');
              setNotice('');
            }}
          >
            <RotateCcw size={14} aria-hidden="true" /> 发起返工
          </button>
        )}
      </div>
      {operation === 'compare' && versions.length > 1 && (
        <VersionCompare
          versions={versions}
          commissionId={snapshot.commission.id}
          compare={compare}
        />
      )}
      {operation === 'rework' && target && (
        <ReworkForm
          target={target}
          snapshot={snapshot}
          disabled={busy || !mayRequestRework}
          submit={submitRework}
          onDone={(message) => {
            setNotice(message);
            setOperation(undefined);
          }}
        />
      )}
      <div className="version-feedback" aria-live="polite">
        {notice}
      </div>
      {lastRework && (
        <div className="version-rework-result">
          <span>{reworkStatus[lastRework.status]}</span>
          <button type="button" onClick={() => onTask(lastRework.id)}>
            查看返工任务
          </button>
        </div>
      )}
    </section>
  );
}

export function ArtifactReview({
  families,
  ...props
}: ArtifactReviewProps & { families: Artifact[][] }) {
  const evidenceByVersion = new Map<string, Evidence[]>();
  for (const item of props.snapshot.evidence) {
    for (const id of item.artifactVersionIds) {
      const records = evidenceByVersion.get(id);
      if (records) records.push(item);
      else evidenceByVersion.set(id, [item]);
    }
  }
  const sourceGroup = new Map<string, string>();
  for (const versions of families) {
    const groupId = `artifact-group-${versions[0].versionId}`;
    for (const { versionId } of versions) sourceGroup.set(versionId, groupId);
  }
  return families.map((versions) => (
    <ArtifactFamily
      key={versions[0].versionId}
      versions={versions}
      evidenceByVersion={evidenceByVersion}
      sourceGroup={sourceGroup}
      {...props}
    />
  ));
}
