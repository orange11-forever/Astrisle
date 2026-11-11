import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  FileCheck2,
  FileText,
  FolderOpen,
  Inbox,
  Layers,
  Maximize2,
  Moon,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
  ZoomIn,
  Map,
  PanelRightOpen,
  ListTodo,
} from 'lucide-react';
import type {
  ApplyPreview,
  ArtifactPreview,
  Bootstrap,
  CharacterProfile,
  CommandResult,
  ProjectSnapshot,
  ProviderInput,
  Workspace,
} from '@astrisle/contracts';
import { DEFAULT_CHARACTERS } from '@astrisle/contracts';
import { StudioScene } from './Scene';
import { Archipelago } from './Archipelago';
import type { CharacterFocus, Panel } from './Scene';

const labels: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  awaiting_acceptance: '待验收',
  accepted: '已接受',
  cancelling: '正在取消',
  cancelled: '已取消',
  failed: '失败',
  queued: '排队中',
  waiting_dependency: '等待前置任务',
  running: '工作中',
  waiting_input: '等待输入',
  waiting_approval: '等待审批',
  awaiting_review: '等待复核',
  rework_required: '需要返工',
  passed: '通过',
  not_run: '未运行',
  current: '当前版本',
  stale: '版本已过期',
  missing: '文件缺失',
};
const panelNames: Record<Panel, string> = {
  goal: '目标与计划',
  tasks: '伙伴与任务',
  evidence: '检查与证据',
  artifacts: '成果与验收',
  requests: '输入与审批',
  settings: '工作室设置',
};
const protocolPresets: Record<
  ProviderInput['kind'],
  { name: string; baseUrl: string; model: string }
> = {
  'openai-compatible': {
    name: 'OpenAI 兼容 · DeepSeek / 通义等',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
  },
  'openai-responses': { name: 'OpenAI Responses', baseUrl: 'https://api.openai.com/v1', model: '' },
  anthropic: { name: 'Anthropic 原生', baseUrl: 'https://api.anthropic.com', model: '' },
  gemini: {
    name: 'Google Gemini 原生',
    baseUrl: 'https://generativelanguage.googleapis.com',
    model: '',
  },
};
function Status({ value }: { value: string }) {
  return <span className={`status status-${value}`}>{labels[value] || value}</span>;
}
function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <Compass size={31} strokeWidth={1.2} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <h2>{title}</h2>
        <button className="icon-button" aria-label="关闭对话框" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function App() {
  const host = window.astrisle;
  const [bootstrap, setBootstrap] = useState<Bootstrap>();
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>();
  const [commissionId, setCommissionId] = useState('');
  const selected = useRef('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [panel, setPanel] = useState<Panel>('goal');
  const [modal, setModal] = useState<'workspace' | 'commission' | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [applyPreview, setApplyPreview] = useState<ApplyPreview>();
  const [accepted, setAccepted] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [overview, setOverview] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [flat, setFlat] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [reset, setReset] = useState(0);
  const [characterFocus, setCharacterFocus] = useState<CharacterFocus>();
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
  );
  const refresh = useCallback(async () => {
    if (!host) return;
    const next = await host.bootstrap();
    setBootstrap(next);
    setWorkspaceId((current) => current || next.workspaces[0]?.id || '');
  }, [host]);
  useEffect(() => {
    refresh().catch((e) => setNotice(String(e)));
  }, [refresh]);
  useEffect(() => {
    selected.current = commissionId;
    setSnapshot(undefined);
    setAccepted([]);
    setPreview(undefined);
    setTaskId('');
    if (host && commissionId)
      host
        .snapshot(commissionId)
        .then((s) => {
          if (selected.current === s.commission.id) setSnapshot(s);
        })
        .catch((e) => setNotice(String(e)));
  }, [commissionId, host]);
  useEffect(
    () =>
      host?.onSnapshot((s) => {
        if (selected.current === s.commission.id) setSnapshot(s);
        refresh().catch(() => {});
      }),
    [host, refresh],
  );
  const run = async (action: () => Promise<CommandResult | unknown>, success?: string) => {
    setBusy(true);
    try {
      const result = (await action()) as Partial<CommandResult> | undefined;
      if (result && 'ok' in result && !result.ok) throw new Error(result.message || '操作未完成');
      setNotice(
        result && 'message' in result ? result.message || success || '已保存' : success || '已保存',
      );
      await refresh();
      if (host && selected.current) {
        const s = await host.snapshot(selected.current);
        if (s.commission.id === selected.current) setSnapshot(s);
      }
      return result;
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  const workspace = bootstrap?.workspaces.find((w) => w.id === workspaceId);
  const openRequests = snapshot?.requests.filter((r) => r.status === 'open') || [];
  const task = snapshot?.tasks.find((t) => t.id === taskId);
  const provider = bootstrap?.provider;
  const characters = bootstrap?.characters || [...DEFAULT_CHARACTERS];
  const characterName = (id: string) =>
    characters.find((profile) => profile.id === id)?.displayName || id;
  const currentArtifacts = snapshot?.artifacts.filter((a) => a.validity === 'current') || [];
  const openPanel = (next: Panel) => {
    setPanel(next);
    setInspectorOpen(true);
    setNavOpen(false);
  };
  const switchWorkspace = (id: string) => {
    setWorkspaceId(id);
    setCommissionId('');
    setInspectorOpen(false);
    setNavOpen(false);
  };
  const showOverview = () => {
    setOverview(true);
    setInspectorOpen(false);
    setNavOpen(false);
  };
  return (
    <div
      className={`studio ${flat ? 'studio-flat' : ''} ${inspectorOpen ? 'inspector-open' : ''} ${navOpen ? 'navigator-open' : ''}`}
    >
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            showOverview();
          }}
          aria-label="Astrisle 星岛工作室"
        >
          <span className="brand-orbit">
            <Sparkles size={21} />
          </span>
          <span>
            Astrisle<small>星岛工作室</small>
          </span>
        </a>
        <div className="island-switcher">
          <Map size={16} />
          <select
            aria-label="切换岛屿"
            value={workspaceId}
            disabled={!bootstrap?.workspaces.length}
            onChange={(e) => {
              switchWorkspace(e.target.value);
              setOverview(false);
            }}
          >
            <option value="">我的星岛</option>
            {bootstrap?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
          <button onClick={showOverview} aria-pressed={overview}>
            群岛总览
          </button>
        </div>
        <div className="top-actions">
          <button
            className="create-island"
            disabled={!host || busy}
            onClick={() => setModal('workspace')}
          >
            <Plus size={15} />
            新建岛屿
          </button>
          <span className={`connection ${host ? 'connected' : ''}`}>
            <i />
            {host ? '桌面已连接' : '桌面连接未就绪'}
          </span>
          <button
            className="icon-button"
            title="工作室设置"
            aria-label="工作室设置"
            onClick={() => openPanel('settings')}
          >
            <Settings2 size={18} />
          </button>
          <button
            className="panel-toggle"
            aria-label={inspectorOpen ? '收起工作面板' : '打开工作面板'}
            aria-expanded={inspectorOpen}
            onClick={() => setInspectorOpen((v) => !v)}
          >
            <PanelRightOpen size={17} />
            <span>工作面板</span>
          </button>
        </div>
      </header>
      <aside className="navigator">
        <div className="rail-tools">
          <button aria-label="查看群岛" title="查看群岛" onClick={showOverview}>
            <Map size={19} />
          </button>
          <button
            aria-label="展开项目与委托"
            title="项目与委托"
            aria-expanded={navOpen}
            onClick={() => setNavOpen((v) => !v)}
          >
            <ListTodo size={19} />
          </button>
        </div>
        <div className="project-switch">
          <FolderOpen size={17} />
          <select
            aria-label="选择工作空间"
            value={workspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
            disabled={!bootstrap?.workspaces.length}
          >
            <option value="">选择工作空间</option>
            {bootstrap?.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <button
          className="new-project"
          disabled={!host || busy}
          onClick={() => setModal('workspace')}
        >
          <Plus size={16} />
          新建 / 导入岛屿
        </button>
        <div className="nav-label">
          我的委托
          <button
            className="icon-button"
            disabled={!host || !workspace}
            aria-label="新建委托"
            onClick={() => setModal('commission')}
          >
            <Plus size={15} />
          </button>
        </div>
        <div className="commission-list">
          {bootstrap?.commissions
            .filter((c) => c.workspaceId === workspaceId)
            .map((c) => (
              <button
                key={c.id}
                className={`commission-item ${commissionId === c.id ? 'selected' : ''}`}
                onClick={() => {
                  setCommissionId(c.id);
                  openPanel('goal');
                }}
              >
                <span className={`commission-dot dot-${c.status}`} />
                <span>
                  {c.title}
                  <small>{labels[c.status] || c.status}</small>
                </span>
              </button>
            ))}
          {!bootstrap?.commissions.some((c) => c.workspaceId === workspaceId) && (
            <p className="nav-empty">
              把一个想法交给伙伴，
              <br />
              从这里开始协作。
            </p>
          )}
        </div>
        <div className="nav-spacer" />
        <nav aria-label="工作室导航">
          {(
            [
              ['goal', Compass],
              ['tasks', Layers],
              ['requests', Inbox],
              ['artifacts', Archive],
              ['evidence', FileCheck2],
            ] as const
          ).map(([key, Icon]) => (
            <button
              key={key}
              title={panelNames[key]}
              aria-label={panelNames[key]}
              className={panel === key && inspectorOpen ? 'active' : ''}
              onClick={() => openPanel(key)}
            >
              <Icon size={17} />
              {panelNames[key]}
              {key === 'requests' && openRequests.length > 0 && (
                <span className="count">{openRequests.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="navigator-foot">
          <Moon size={15} />
          <span>云海之上，好好工作</span>
        </div>
      </aside>
      <main
        className={`stage ${!flat && !characterFocus ? 'stage-cosmic' : ''}`}
        data-testid="island-stage"
      >
        <div className="stage-title">
          <div>
            <h1>
              {overview
                ? '你的群岛'
                : characterFocus && !flat
                  ? `${characterName(characterFocus)}的角色特写`
                  : snapshot?.commission.title || workspace?.name || '给想法，一座小岛。'}
            </h1>
            <p>
              {overview
                ? '每座岛屿对应一个独立项目；选择小岛，再进入工作室。'
                : characterFocus && !flat
                  ? characters.find((profile) => profile.id === characterFocus)?.model?.filename ||
                    '蓝色大肥鱼娘 · Q 版鲸鱼伙伴'
                  : snapshot
                    ? '伙伴的动作对应实际工作，细节随时可查。'
                    : `和 ${characterName('mori')}、${characterName('luma')} 一起，把想法整理成可检验的成果。`}
            </p>
          </div>
          {snapshot && <Status value={snapshot.commission.status} />}
        </div>
        {overview && !flat ? (
          <Archipelago
            workspaces={bootstrap?.workspaces || []}
            selectedId={workspaceId}
            onSelect={switchWorkspace}
            reduced={reduced}
          />
        ) : !flat ? (
          <StudioScene
            key={workspaceId || 'preview'}
            workspaceId={workspaceId || 'preview'}
            snapshot={snapshot}
            onPanel={openPanel}
            reduced={reduced}
            reset={reset}
            fixed={fixed}
            focus={characterFocus}
            characters={characters}
          />
        ) : (
          <div className="flat-world">
            <Compass size={58} strokeWidth={0.8} />
            <h2>{overview ? '群岛列表' : '工作概览'}</h2>
            {overview && (
              <div className="island-access-list">
                {bootstrap?.workspaces.map((w) => (
                  <button
                    key={w.id}
                    aria-pressed={w.id === workspaceId}
                    onClick={() => switchWorkspace(w.id)}
                  >
                    {w.name}
                  </button>
                ))}
              </div>
            )}
            <p>
              {snapshot?.commission.goal || '还没有开始委托。新建一个项目，告诉伙伴你想完成什么。'}
            </p>
            <div className="flat-links">
              <button onClick={() => openPanel('tasks')}>
                <Layers />
                任务 {snapshot?.tasks.length || 0}
              </button>
              <button onClick={() => openPanel('requests')}>
                <Inbox />
                待回复 {openRequests.length}
              </button>
              <button onClick={() => openPanel('artifacts')}>
                <Archive />
                成果 {snapshot?.artifacts.length || 0}
              </button>
            </div>
          </div>
        )}
        <div className="scene-caption">
          <span className="caption-line" />
          <span>
            {overview
              ? `${bootstrap?.workspaces.length || 0} 座持久岛屿 · 每座对应一个项目`
              : characterFocus && !flat
                ? `${characterName(characterFocus)} · 拖动旋转，滚轮缩放`
                : '宇宙中的悬浮星岛'}
          </span>
        </div>
        <div className="view-controls">
          <button
            aria-label="回到全景"
            title="回到全景"
            onClick={() => {
              setCharacterFocus(undefined);
              setReset((r) => r + 1);
            }}
          >
            <Maximize2 size={16} />
          </button>
          <span />
          {!flat && !overview && (
            <select
              aria-label="角色特写"
              value={characterFocus ?? ''}
              onChange={(event) => {
                setCharacterFocus((event.target.value || undefined) as CharacterFocus | undefined);
                setFixed(false);
              }}
            >
              <option value="">角色特写</option>
              {characters.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.displayName}
                </option>
              ))}
            </select>
          )}
          <button
            className={fixed ? 'selected' : ''}
            title="固定镜头"
            aria-label="固定镜头"
            aria-pressed={fixed}
            onClick={() => setFixed((v) => !v)}
          >
            <ZoomIn size={16} />
          </button>
          <button className={flat ? 'selected' : ''} onClick={() => setFlat((v) => !v)}>
            {flat ? '3D 场景' : '2D 模式'}
          </button>
        </div>
        {overview ? (
          <div className="archipelago-dock">
            <div>
              <strong>{workspace?.name || '建立你的第一座岛屿'}</strong>
              <p>
                {workspace
                  ? '岛屿就是项目，委托和文件保存在对应工作副本中。'
                  : '创建岛屿不需要模型或密钥；工作委托再按需连接 API。'}
              </p>
            </div>
            <button disabled={!host || busy} onClick={() => setModal('workspace')}>
              <Plus size={15} />
              新建岛屿
            </button>
            {workspace && (
              <button
                className="primary"
                onClick={() => {
                  setOverview(false);
                  setReset((r) => r + 1);
                }}
              >
                进入岛屿
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        ) : (
          <div className="commission-dock">
            <div className="dock-star">
              <Sparkles size={24} strokeWidth={1.2} />
            </div>
            <div>
              <strong>{snapshot ? '把下一步说清楚' : '今天，想一起完成什么？'}</strong>
              <p>
                {snapshot
                  ? `${snapshot.tasks.filter((t) => t.status === 'passed').length} 项任务通过 · ${openRequests.length} 项需要你回复`
                  : '创建项目、修改代码、整理资料，或完成一份办公文档。'}
              </p>
            </div>
            <button
              className="primary"
              disabled={!host || busy}
              onClick={() => setModal(workspace ? 'commission' : 'workspace')}
            >
              <Plus size={16} />
              新委托
            </button>
          </div>
        )}
      </main>
      <aside
        className="inspector"
        aria-hidden={!inspectorOpen}
        inert={!inspectorOpen}
        aria-label={panelNames[panel]}
      >
        <header className="inspector-header">
          <div>
            <span className="inspector-mark" />
            <h2>{panelNames[panel]}</h2>
          </div>
          <div>
            {snapshot && <span className="revision">修订 {snapshot.commission.revision}</span>}
            <button
              className="icon-button"
              aria-label="收起工作面板"
              onClick={() => setInspectorOpen(false)}
            >
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="inspector-body">
          {panel === 'settings' ? (
            <SettingsPanel
              provider={provider}
              busy={busy}
              reduced={reduced}
              onReduced={setReduced}
              run={run}
              host={host}
              characters={characters}
            />
          ) : !snapshot ? (
            <>
              <Empty title={host ? '一份委托，一个起点' : '在桌面版开始协作'}>
                {host
                  ? '选择已有委托，或新建项目后写下你的目标。伙伴会按你的权限范围工作。'
                  : '当前是浏览器场景预览。请在 Astrisle 桌面版中创建项目、连接模型并执行任务。'}
              </Empty>
              {host && (
                <button
                  className="primary wide"
                  onClick={() => setModal(workspace ? 'commission' : 'workspace')}
                >
                  开始第一份委托
                  <ArrowRight size={16} />
                </button>
              )}
              <div className="partner-note">
                <span className="partner-initial mori">{[...characterName('mori')][0]}</span>
                <div>
                  <b>{characterName('mori')}</b>
                  <p>铺开线索，探索解决方案。</p>
                </div>
              </div>
              <div className="partner-note">
                <span className="partner-initial luma">{[...characterName('luma')][0]}</span>
                <div>
                  <b>{characterName('luma')}</b>
                  <p>理清脉络，逐项核对细节。</p>
                </div>
              </div>
              <p className="quiet">两位伙伴可以互换任务，所有成果都需经过实际检查。</p>
            </>
          ) : (
            <>
              {panel === 'goal' && (
                <>
                  <div className="goal-summary">
                    <Status value={snapshot.commission.status} />
                    <h3>{snapshot.commission.title}</h3>
                    <p>{snapshot.commission.goal}</p>
                  </div>
                  <h4>验收条件</h4>
                  <ul className="criteria">
                    {snapshot.commission.criteria.map((c) => (
                      <li key={c.id}>
                        <span className="criterion-circle" />
                        {c.description}
                      </li>
                    ))}
                  </ul>
                  <h4>工作边界</h4>
                  <dl className="facts">
                    <dt>工作副本</dt>
                    <dd>{snapshot.workspace.workPath}</dd>
                    <dt>可读目录</dt>
                    <dd>{snapshot.commission.scope.readRoots.join('\n') || '无'}</dd>
                    <dt>可写目录</dt>
                    <dd>{snapshot.commission.scope.writeRoots.join('\n') || '无'}</dd>
                    <dt>运行命令</dt>
                    <dd>{snapshot.commission.scope.allowProcess ? '允许' : '不允许'}</dd>
                    <dt>网络访问</dt>
                    <dd>{snapshot.commission.scope.allowNetwork ? '允许' : '不允许'}</dd>
                    <dt>预算</dt>
                    <dd>
                      {snapshot.commission.stepsUsed} / {snapshot.commission.budget.maxSteps} 步 ·{' '}
                      {snapshot.commission.budget.maxMinutes} 分钟
                    </dd>
                  </dl>
                  <div className="button-row">
                    {snapshot.commission.status === 'paused' ? (
                      <button
                        disabled={busy}
                        onClick={() => run(() => host!.control(commissionId, 'resume'))}
                      >
                        <Play size={15} />
                        继续
                      </button>
                    ) : (
                      <button
                        disabled={busy || snapshot.commission.status !== 'active'}
                        onClick={() => run(() => host!.control(commissionId, 'pause'))}
                      >
                        <Pause size={15} />
                        暂停
                      </button>
                    )}
                    <button
                      disabled={
                        busy || ['accepted', 'cancelled'].includes(snapshot.commission.status)
                      }
                      onClick={() => run(() => host!.control(commissionId, 'cancel'))}
                    >
                      <Square size={13} />
                      取消
                    </button>
                  </div>
                  <form
                    className="revision-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = e.currentTarget;
                      const instruction = String(new FormData(f).get('instruction'));
                      if (instruction.trim())
                        run(() =>
                          host!.revise(commissionId, instruction, snapshot.commission.revision),
                        ).then((result) => {
                          if (result) f.reset();
                        });
                    }}
                  >
                    <label htmlFor="revise">补充或调整目标</label>
                    <textarea
                      id="revise"
                      name="instruction"
                      placeholder="告诉伙伴需要保留什么、调整什么…"
                      required
                      rows={3}
                    />
                    <button type="submit" disabled={busy}>
                      <RotateCcw size={14} />
                      提交修订
                    </button>
                  </form>
                </>
              )}
              {panel === 'tasks' && (
                <>
                  <p className="panel-intro">
                    工作状态来自运行记录。选择任务查看依赖、输入版本与当前步骤。
                  </p>
                  {snapshot.tasks.length === 0 ? (
                    <Empty title="还没有任务">委托开始后，实际计划会出现在这里。</Empty>
                  ) : (
                    snapshot.tasks.map((t) => (
                      <button
                        className={`task-row ${taskId === t.id ? 'selected' : ''}`}
                        key={t.id}
                        onClick={() => setTaskId(t.id)}
                      >
                        <span className={`partner-small ${t.agentId === 'mori' ? 'mori' : 'luma'}`}>
                          {[...characterName(t.agentId)][0]}
                        </span>
                        <span>
                          <b>{t.title}</b>
                          <small>
                            {characterName(t.agentId)} · {t.kind}
                          </small>
                          <Status value={t.status} />
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))
                  )}
                  {task && (
                    <section className="task-detail">
                      <h3>{task.title}</h3>
                      <p>{task.description}</p>
                      <h4>当前步骤</h4>
                      <p>{task.step || '尚未开始'}</p>
                      {task.error && <p className="error-text">{task.error}</p>}
                      <h4>依赖</h4>
                      <p>
                        {task.dependencies
                          .map((id) => snapshot.tasks.find((t) => t.id === id)?.title || id)
                          .join('、') || '无前置任务'}
                      </p>
                      <h4>使用的版本</h4>
                      <p className="code-text">{task.inputVersions.join('\n') || '无'}</p>
                      <button onClick={() => openPanel('evidence')}>
                        查看检查记录
                        <ArrowRight size={14} />
                      </button>
                    </section>
                  )}
                </>
              )}
              {panel === 'requests' && (
                <>
                  {openRequests.length === 0 ? (
                    <Empty title="暂时不需要回复">
                      遇到信息缺口或需要授权的操作时，伙伴会把具体问题放在这里。
                    </Empty>
                  ) : (
                    openRequests.map((r) => (
                      <form
                        className="request"
                        key={r.id}
                        onSubmit={(e) => {
                          e.preventDefault();
                          const answer = String(new FormData(e.currentTarget).get('answer') || '');
                          run(() =>
                            host!.answer(r.id, answer, r.kind === 'approval' ? true : undefined),
                          );
                        }}
                      >
                        <span className="request-type">
                          {r.kind === 'approval' ? (
                            <ShieldCheck size={16} />
                          ) : (
                            <CircleHelp size={16} />
                          )}{' '}
                          {r.kind === 'approval' ? '等待你授权' : '等待你补充'}
                        </span>
                        <h3>{r.title}</h3>
                        <p className="preserve">{r.detail}</p>
                        <label htmlFor={`answer-${r.id}`}>
                          {r.kind === 'approval' ? '授权说明（可选）' : '你的回复'}
                        </label>
                        <textarea
                          id={`answer-${r.id}`}
                          name="answer"
                          rows={3}
                          required={r.kind === 'input'}
                        />
                        <div className="button-row">
                          <button type="submit" className="primary" disabled={busy}>
                            {r.kind === 'approval' ? '批准此项操作' : '发送回复'}
                          </button>
                          {r.kind === 'approval' && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => run(() => host!.answer(r.id, '用户拒绝授权', false))}
                            >
                              拒绝
                            </button>
                          )}
                        </div>
                      </form>
                    ))
                  )}
                  {snapshot.requests.filter((r) => r.status !== 'open').length > 0 && (
                    <details>
                      <summary>已处理的回复</summary>
                      {snapshot.requests
                        .filter((r) => r.status !== 'open')
                        .map((r) => (
                          <p key={r.id}>
                            {r.title} · {r.status === 'rejected' ? '已拒绝' : '已回复'}
                          </p>
                        ))}
                    </details>
                  )}
                </>
              )}
              {panel === 'evidence' && (
                <>
                  <p className="panel-intro">
                    证据保留实际工具、测试与复核输出。未运行的检查不会计为通过。
                  </p>
                  {snapshot.evidence.length === 0 ? (
                    <Empty title="还没有检查记录">
                      实际检查完成后，结果和完整输出会保存在这里。
                    </Empty>
                  ) : (
                    snapshot.evidence.map((e) => (
                      <details className="evidence" key={e.id}>
                        <summary>
                          <span>
                            <b>{e.summary}</b>
                            <small>
                              {e.kind} · {new Date(e.createdAt).toLocaleTimeString('zh-CN')}
                            </small>
                          </span>
                          <Status value={e.status} />
                        </summary>
                        <pre>{e.detail}</pre>
                        <p className="code-text">{e.artifactVersionIds.join('\n')}</p>
                      </details>
                    ))
                  )}
                </>
              )}
              {panel === 'artifacts' && (
                <>
                  <p className="panel-intro">先检查成果，再选择接受。导出和写回原项目分别执行。</p>
                  {snapshot.artifacts.length === 0 ? (
                    <Empty title="交付港还空着">伙伴实际保存的文件会出现在这里。</Empty>
                  ) : (
                    snapshot.artifacts.map((a) => (
                      <div className="artifact-row" key={a.versionId}>
                        <input
                          aria-label={`选择成果 ${a.name}`}
                          type="checkbox"
                          disabled={
                            a.validity !== 'current' ||
                            snapshot.commission.acceptedArtifactIds.includes(a.id)
                          }
                          checked={
                            accepted.includes(a.id) ||
                            snapshot.commission.acceptedArtifactIds.includes(a.id)
                          }
                          onChange={(e) =>
                            setAccepted((ids) =>
                              e.target.checked ? [...ids, a.id] : ids.filter((id) => id !== a.id),
                            )
                          }
                        />
                        <button
                          className="artifact-name"
                          onClick={() =>
                            run(async () => {
                              setPreview(await host!.artifact(a.id));
                              setNotice('');
                            })
                          }
                        >
                          <FileText size={19} />
                          <span>
                            <b>{a.name}</b>
                            <small>{a.relativePath}</small>
                            <Status value={a.validity} />
                          </span>
                        </button>
                      </div>
                    ))
                  )}
                  {currentArtifacts.length > 0 && (
                    <>
                      <div className="accept-note">
                        {snapshot.commission.status === 'awaiting_acceptance'
                          ? '成果已进入待验收阶段。'
                          : '已有成果，仍可能有待办；可以先接受选中的项目。'}
                      </div>
                      <button
                        className="primary wide"
                        disabled={busy || !accepted.length}
                        onClick={() =>
                          run(() => host!.accept(commissionId, accepted)).then((result) => {
                            if (result) setAccepted([]);
                          })
                        }
                      >
                        <Check size={16} />
                        接受选中成果（{accepted.length}）
                      </button>
                      <div className="button-row">
                        <button
                          disabled={busy}
                          onClick={() => run(() => host!.exportArtifacts(commissionId))}
                        >
                          <ArrowDownToLine size={15} />
                          导出成果
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            run(
                              async () => setApplyPreview(await host!.prepareApply(commissionId)),
                              '写回预览已生成',
                            )
                          }
                        >
                          预览写回原项目
                        </button>
                      </div>
                    </>
                  )}
                  {snapshot.commission.acceptedArtifactIds.length > 0 && (
                    <p className="quiet">
                      已接受 {snapshot.commission.acceptedArtifactIds.length}{' '}
                      项。接受成果不会自动写回原项目。
                    </p>
                  )}
                </>
              )}
            </>
          )}
        </div>
        <footer className="inspector-footer">
          <ShieldCheck size={14} />
          <span>
            {provider?.configured ? '模型已配置 · 按授权范围工作' : '连接自己的模型 API 后开始工作'}
          </span>
        </footer>
      </aside>
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={() => setNotice('')}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'workspace' && (
        <WorkspaceModal
          busy={busy}
          onClose={() => setModal(null)}
          onCreate={(name, sourcePath) =>
            run(async () => {
              const w = await host!.createWorkspace({ name, sourcePath });
              setWorkspaceId(w.id);
              setCommissionId('');
              setModal(null);
              setOverview(true);
              setInspectorOpen(false);
            }, '岛屿已创建')
          }
          onChoose={() => host!.chooseDirectory()}
        />
      )}
      {modal === 'commission' && workspace && (
        <CommissionModal
          workspace={workspace}
          busy={busy}
          configured={provider?.configured || false}
          onSettings={() => {
            setModal(null);
            openPanel('settings');
          }}
          onClose={() => setModal(null)}
          onSubmit={(input) =>
            run(async () => {
              const result = await host!.submit(input);
              if (result.ok && result.commissionId) {
                setCommissionId(result.commissionId);
                openPanel('goal');
                setModal(null);
              }
              return result;
            })
          }
        />
      )}
      {preview && (
        <Modal title={preview.artifact.name} onClose={() => setPreview(undefined)}>
          <p className="quiet">
            {preview.artifact.relativePath} · {preview.artifact.size.toLocaleString()} 字节
          </p>
          <Status value={preview.artifact.validity} />
          {preview.format === 'text' ? (
            <pre className="artifact-preview">{preview.content || '文件为空'}</pre>
          ) : (
            <p className="panel-intro">此文件为二进制格式，请在系统应用中打开查看。</p>
          )}
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => run(() => host!.openArtifact(preview.artifact.id))}
            >
              <FolderOpen size={16} />
              在系统中打开
            </button>
          </div>
        </Modal>
      )}
      {applyPreview && (
        <Modal title="确认写回原项目" onClose={() => setApplyPreview(undefined)}>
          <p>下面列出将写入原项目的更改。请先核对路径和冲突。</p>
          {!applyPreview.supported && (
            <p className="error-text">
              {applyPreview.reason || '当前项目不支持自动写回，请导出成果。'}
            </p>
          )}
          {applyPreview.conflicts.map((conflict, i) => (
            <p className="error-text" key={i}>
              {conflict}
            </p>
          ))}
          <ul className="apply-list">
            {applyPreview.changes.map((change, i) => (
              <li key={i}>
                <b>
                  {change.action === 'create'
                    ? '新增'
                    : change.action === 'modify'
                      ? '修改'
                      : '删除'}
                </b>
                <code>{change.path}</code>
              </li>
            ))}
          </ul>
          <div className="button-row">
            <button onClick={() => setApplyPreview(undefined)}>返回</button>
            <button
              className="primary"
              disabled={
                busy ||
                !applyPreview.supported ||
                applyPreview.conflicts.length > 0 ||
                !applyPreview.changes.length
              }
              onClick={() =>
                run(() => host!.apply(applyPreview.operationId)).then((result) => {
                  if (result) setApplyPreview(undefined);
                })
              }
            >
              确认写回 {applyPreview.changes.length} 项更改
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function WorkspaceModal({
  busy,
  onClose,
  onCreate,
  onChoose,
}: {
  busy: boolean;
  onClose: () => void;
  onCreate: (name: string, path?: string) => unknown;
  onChoose: () => Promise<string | null>;
}) {
  const [path, setPath] = useState('');
  const [error, setError] = useState('');
  return (
    <Modal title="创建一座新岛屿" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onCreate(String(new FormData(e.currentTarget).get('name')), path || undefined);
        }}
      >
        <p className="modal-intro">
          一座岛屿对应一个独立项目。可以从空白开始，或导入已有目录；伙伴会在工作副本中完成修改。创建岛屿不需要模型
          API。
        </p>
        <label htmlFor="workspace-name">岛屿名称</label>
        <input
          id="workspace-name"
          name="name"
          placeholder="例如：我的产品网站 / 月度报告"
          required
          maxLength={100}
          autoFocus
        />
        <label>已有项目目录（可选）</label>
        <div className="directory-picker">
          <span>{path || '从空白项目开始'}</span>
          <button
            type="button"
            onClick={() =>
              onChoose()
                .then((p) => {
                  if (p) setPath(p);
                })
                .catch((e) => setError(String(e)))
            }
          >
            <FolderOpen size={16} />
            选择目录
          </button>
        </div>
        {path && (
          <button type="button" className="text-button" onClick={() => setPath('')}>
            改为空白项目
          </button>
        )}
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy} type="submit">
            创建岛屿
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </Modal>
  );
}
function CommissionModal({
  workspace,
  busy,
  configured,
  onClose,
  onSettings,
  onSubmit,
}: {
  workspace: Workspace;
  busy: boolean;
  configured: boolean;
  onClose: () => void;
  onSettings: () => void;
  onSubmit: (input: Parameters<NonNullable<Window['astrisle']>['submit']>[0]) => unknown;
}) {
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    onSubmit({
      requestId: crypto.randomUUID(),
      workspaceId: workspace.id,
      goal: String(d.get('goal')),
      criteria: String(d.get('criteria'))
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
      scope: {
        readRoots: [workspace.workPath],
        writeRoots: [workspace.workPath],
        allowProcess: d.has('process'),
        allowNetwork: d.has('network'),
        allowedHosts: String(d.get('hosts') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      },
      budget: {
        maxSteps: Number(d.get('steps')),
        maxMinutes: Number(d.get('minutes')),
        maxRework: 2,
      },
      planningMode: d.has('review') ? 'review_first' : 'auto',
    });
  };
  return (
    <Modal title="告诉伙伴，你想完成什么" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-intro">
          项目：{workspace.name}。写清结果与检查方式，伙伴会据此拆解工作。
        </p>
        <label htmlFor="goal">工作目标</label>
        <textarea
          id="goal"
          name="goal"
          placeholder="例如：为这个项目增加登录页；或整理资料，生成一份带图表的月度报告…"
          required
          rows={4}
          autoFocus
        />
        <label htmlFor="criteria">验收条件（每行一项）</label>
        <textarea
          id="criteria"
          name="criteria"
          placeholder={'例如：\n说明数据来源与结论\n检查生成的文件能否正常打开'}
          rows={3}
          required
        />
        <details className="scope-details">
          <summary>权限与工作预算</summary>
          <p className="quiet">文件工具的读写范围限制在项目工作副本。</p>
          <label className="check-label">
            <input name="process" type="checkbox" />
            允许受信任的本机命令（测试、构建及工具）
          </label>
          <p className="process-disclosure">
            命令会在你的电脑上执行，不在安全沙箱中。子程序可以自行访问原项目、其他文件与网络，文件和网络工具的权限范围无法限制它。仅对你信任的项目和命令开启。
          </p>
          <label className="check-label">
            <input name="network" type="checkbox" />
            允许访问网络
          </label>
          <label htmlFor="hosts">允许的域名（英文逗号分隔）</label>
          <input id="hosts" name="hosts" placeholder="example.com" />
          <label className="check-label">
            <input name="review" type="checkbox" defaultChecked />
            先审阅计划，再开始执行
          </label>
          <div className="form-columns">
            <label>
              最多步骤
              <input name="steps" type="number" min={1} max={200} defaultValue={40} />
            </label>
            <label>
              最多分钟
              <input name="minutes" type="number" min={1} max={180} defaultValue={20} />
            </label>
          </div>
        </details>
        {!configured && (
          <div className="setup-hint">
            <p>先连接模型 API，才能让伙伴开始工作。</p>
            <button type="button" onClick={onSettings}>
              配置模型
              <ArrowRight size={14} />
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy || !configured} type="submit">
            <Send size={16} />
            提交委托
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SettingsPanel({
  provider,
  busy,
  reduced,
  onReduced,
  run,
  host,
  characters,
}: {
  provider?: Bootstrap['provider'];
  busy: boolean;
  reduced: boolean;
  onReduced: (v: boolean) => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
  host: Window['astrisle'];
  characters: CharacterProfile[];
}) {
  const [kind, setKind] = useState<ProviderInput['kind']>(provider?.kind || 'openai-compatible');
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl || protocolPresets[kind].baseUrl);
  const [model, setModel] = useState(provider?.model || protocolPresets[kind].model);
  const keyRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (provider) {
      setKind(provider.kind);
      setBaseUrl(provider.baseUrl);
      setModel(provider.model);
    }
  }, [provider]);
  return (
    <>
      <p className="panel-intro">
        使用你自己的模型 API。密钥仅通过桌面主进程保存，不会出现在任务或历史记录中。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const apiKey = keyRef.current?.value;
          run(async () => {
            try {
              return await host!.saveProvider({
                kind,
                baseUrl,
                model,
                ...(apiKey ? { apiKey } : {}),
              });
            } finally {
              if (keyRef.current) keyRef.current.value = '';
            }
          }, '模型设置已保存');
        }}
      >
        <label htmlFor="provider-kind">API 协议</label>
        <select
          id="provider-kind"
          value={kind}
          onChange={(e) => {
            const next = e.target.value as ProviderInput['kind'];
            setKind(next);
            setBaseUrl(protocolPresets[next].baseUrl);
            setModel(protocolPresets[next].model);
          }}
        >
          {Object.entries(protocolPresets).map(([value, p]) => (
            <option value={value} key={value}>
              {p.name}
            </option>
          ))}
        </select>
        <label htmlFor="provider-url">API 基础地址</label>
        <input
          id="provider-url"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          type="url"
        />
        <p className="field-hint">兼容协议可填写 DeepSeek、通义、硅基流动或本地服务地址。</p>
        <label htmlFor="provider-model">模型名称</label>
        <input
          id="provider-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
        />
        <label htmlFor="provider-key">API 密钥 {provider?.hasApiKey ? '· 已保存' : ''}</label>
        <input
          id="provider-key"
          ref={keyRef}
          type="password"
          autoComplete="new-password"
          placeholder={provider?.hasApiKey ? '留空保留已有密钥' : '输入你的 API 密钥'}
        />
        <div className="button-row">
          <button className="primary" disabled={!host || busy} type="submit">
            保存设置
          </button>
          <button
            type="button"
            disabled={!host || busy || !provider?.configured}
            onClick={() => run(() => host!.testProvider())}
          >
            测试连接
          </button>
        </div>
      </form>
      <h4>角色外观与名称</h4>
      <p className="quiet">
        角色名称和外观适用于所有岛屿。可导入 100 MB 以内的 GLB 或自包含 glTF
        2；缓冲区和贴图须内嵌，不支持 Draco、Meshopt 或 KTX2 压缩。
      </p>
      {characters.map((profile) => (
        <CharacterSettings key={profile.id} profile={profile} busy={busy} host={host} run={run} />
      ))}
      <h4>场景偏好</h4>
      <label className="check-label">
        <input type="checkbox" checked={reduced} onChange={(e) => onReduced(e.target.checked)} />
        减少角色动作
      </label>
      <p className="quiet">可使用场景右下方的 2D 模式，直接查看全部任务与成果。</p>
      <h4>工具能力</h4>
      <p className="quiet">运行权限由每一份委托单独决定。</p>
    </>
  );
}

function CharacterSettings({
  profile,
  busy,
  host,
  run,
}: {
  profile: CharacterProfile;
  busy: boolean;
  host: Window['astrisle'];
  run: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(profile.displayName);
  useEffect(() => setName(profile.displayName), [profile.displayName]);
  const validName =
    [...name.trim()].length >= 1 && [...name.trim()].length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(name);
  return (
    <section className="character-settings" aria-label={`${profile.displayName} 的角色设置`}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (validName && host?.updateCharacter)
            run(
              () => host.updateCharacter!(profile.id, { displayName: name.trim() }),
              '角色名称已保存',
            );
        }}
      >
        <label htmlFor={`character-name-${profile.id}`}>{profile.displayName} 的显示名称</label>
        <input
          id={`character-name-${profile.id}`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          required
          maxLength={80}
        />
        <div className="button-row">
          <button
            type="submit"
            disabled={busy || !host?.updateCharacter || !validName}
            aria-label={`保存 ${profile.displayName} 的名称`}
          >
            保存名称
          </button>
          <button
            type="button"
            disabled={busy || !host?.importCharacter}
            aria-label={`为${profile.displayName}导入模型`}
            onClick={() =>
              run(async () => {
                const imported = await host!.importCharacter!(profile.id);
                return {
                  ok: true,
                  message: imported ? '角色模型已保存，场景正在加载' : '已取消导入，角色保持不变',
                };
              })
            }
          >
            {profile.model ? '替换模型' : '导入模型'}
          </button>
        </div>
      </form>
      {profile.model ? (
        <>
          <p className="field-hint">
            {profile.model.filename} · {(profile.model.byteLength / 1024 / 1024).toFixed(1)} MB ·{' '}
            {profile.model.triangleCount.toLocaleString()} 个三角形
          </p>
          <p className="quiet">
            {profile.model.animationCount > 0
              ? `包含 ${profile.model.animationCount} 个动画片段。`
              : profile.model.hasSkins
                ? '包含骨骼，没有动画片段；角色整体移动。'
                : '静态模型：角色整体移动，不包含骨骼动画。'}
          </p>
          {profile.model.triangleCount > 200_000 && (
            <p className="field-hint">
              模型面数较高；多个角色共用网格和贴图。若仍卡顿，可导出面数更低的模型替换。
            </p>
          )}
          <label htmlFor={`character-orientation-${profile.id}`}>
            {profile.displayName} 的模型朝向
          </label>
          <select
            id={`character-orientation-${profile.id}`}
            value={profile.rotationY ?? 0}
            disabled={busy || !host?.updateCharacter}
            onChange={(event) =>
              run(
                () =>
                  host!.updateCharacter!(profile.id, {
                    rotationY: Number(event.target.value) as NonNullable<
                      CharacterProfile['rotationY']
                    >,
                  }),
                '角色朝向已保存',
              )
            }
          >
            <option value={0}>原始朝向</option>
            <option value={90}>右转90°</option>
            <option value={180}>转180°</option>
            <option value={270}>左转90°</option>
          </select>
          <button
            type="button"
            className="text-button"
            disabled={busy || !host?.updateCharacter}
            aria-label={`重置${profile.displayName}的模型`}
            onClick={() =>
              run(
                () => host!.updateCharacter!(profile.id, { resetModel: true }),
                '已恢复默认角色模型',
              )
            }
          >
            恢复默认模型
          </button>
        </>
      ) : (
        <p className="field-hint">使用默认角色模型。</p>
      )}
    </section>
  );
}
