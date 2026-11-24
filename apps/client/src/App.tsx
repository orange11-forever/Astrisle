import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  Archive,
  ArrowLeft,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Compass,
  FileCheck2,
  FolderOpen,
  Inbox,
  Layers,
  Maximize2,
  MessageCircle,
  Newspaper,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  X,
  ZoomIn,
  Map as MapIcon,
  PanelRightOpen,
  ListTodo,
  PartyPopper,
} from 'lucide-react';
import astrisleMark from '../../../docs/assets/astrisle-logo.svg';
import type {
  ApplyPreview,
  ArtifactPreview,
  Bootstrap,
  CharacterProfile,
  CommandResult,
  HostAPI,
  PartnerDialogueReference,
  ProjectSnapshot,
  ProviderInput,
  Workspace,
} from '@astrisle/contracts';
import {
  DEFAULT_CHARACTERS,
  isSearchEndpoint,
  isSourceHostname,
  isValidCharacterName,
} from '@astrisle/contracts';
import { StudioScene } from './Scene';
import type { StudioDistrict } from './StudioCamera';
import type { IslandLightMode } from './island-daylight';
import { Archipelago } from './Archipelago';
import { BudgetPanel } from './BudgetPanel';
import { ArtifactReview, ArtifactWebSources } from './ArtifactReview';
import { ArtifactSourceExport } from './ArtifactSourceExport';
import { artifactVersionFamilies } from '../../../packages/artifacts/src/history';
import { CommissionActivity } from './CommissionActivity';
import { DailyNewsPanel, supportsDailyNews } from './DailyNewsPanel';
import { PartnerCreator } from './PartnerCreator';
import { PartnerDialogue, usePartnerDialogue, type DialogueTarget } from './PartnerDialogue';
import { WritebackHistory, WritebackPreview } from './WritebackHistory';
import { SceneQualitySelect, type SceneQuality } from './render-quality';
import type { CharacterFocus, Panel } from './Scene';
import { useCompletionCelebration } from './celebration';
import {
  islandAppearance,
  islandThemes,
  isIslandThemeId,
  parseIslandThemeOverrides,
} from './islands';
import type { IslandThemeId } from './islands';

const islandThemeStorageKey = 'astrisle-island-themes';
const lightStorageKey = 'astrisle-island-light-mode';
const districtNames: Record<StudioDistrict, string> = {
  harbor: '花港街景',
  lane: '制帆巷与码头',
  garden: '温室花园',
  nursery: '温室育苗区',
  glasshouse: '温室内景',
  coast: '潮池外岛',
  observatory: '观星台',
};
function isDistrict(value: CharacterFocus | StudioDistrict | undefined): value is StudioDistrict {
  return value !== undefined && Object.hasOwn(districtNames, value);
}
function LightOptions() {
  return (
    <>
      <option value="auto">跟随本机时间</option>
      <option value="day">白昼</option>
      <option value="dusk">黄昏</option>
      <option value="night">夜晚</option>
    </>
  );
}
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
  stale: '历史版本',
  missing: '文件缺失',
};
const panelNames: Record<Panel, string> = {
  goal: '目标与计划',
  tasks: '伙伴与任务',
  dialogue: '伙伴对话',
  evidence: '检查与证据',
  artifacts: '成果与验收',
  requests: '输入与审批',
  dailyNews: '日报邮箱',
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
      aria-label={title}
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
  const [loadError, setLoadError] = useState('');
  const refreshOrder = useRef({ issued: 0, applied: 0 });
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>();
  const [commissionId, setCommissionId] = useState('');
  const selected = useRef('');
  const receiveSnapshot = useCallback((incoming: ProjectSnapshot) => {
    if (incoming.commission.id !== selected.current) return;
    setSnapshot((previous) =>
      previous?.commission.id === incoming.commission.id &&
      previous.lastSequence > incoming.lastSequence
        ? previous
        : incoming,
    );
  }, []);
  const [workspaceId, setWorkspaceId] = useState('');
  const celebration = useCompletionCelebration(snapshot?.commission, workspaceId);
  const [panel, setPanel] = useState<Panel>('goal');
  const [dialogueTarget, setDialogueTarget] = useState<DialogueTarget>();
  const [dialogueSource, setDialogueSource] = useState<{
    target: DialogueTarget;
    panel: 'goal' | 'tasks' | 'evidence';
    id: string;
  }>();
  const dialoguePreviewRequest = useRef(0);
  const [modal, setModal] = useState<'workspace' | 'commission' | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [applyPreview, setApplyPreview] = useState<ApplyPreview>();
  const [accepted, setAccepted] = useState<string[]>([]);
  const [taskId, setTaskId] = useState('');
  const [overview, setOverview] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const dailyNewsHeading = useRef<HTMLHeadingElement>(null);
  const dailyNewsTrigger = useRef<HTMLButtonElement | null>(null);
  const dailyNewsNav = useRef<HTMLButtonElement>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [flat, setFlat] = useState(false);
  const [fixed, setFixed] = useState(false);
  const [islandThemeOverrides, setIslandThemeOverrides] = useState(() => {
    try {
      return parseIslandThemeOverrides(localStorage.getItem(islandThemeStorageKey));
    } catch {
      return new Map<string, IslandThemeId>();
    }
  });
  const islandTheme = islandThemeOverrides.get(workspaceId);
  const changeIslandTheme = (themeId?: IslandThemeId) => {
    const next = new Map(islandThemeOverrides);
    if (themeId) next.set(workspaceId, themeId);
    else next.delete(workspaceId);
    setIslandThemeOverrides(next);
    try {
      localStorage.setItem(islandThemeStorageKey, JSON.stringify(Object.fromEntries(next)));
    } catch {
      setNotice('主题已应用到当前会话。无法保存到本机。');
    }
  };
  const [sceneQuality, setSceneQuality] = useState<SceneQuality>(() => {
    try {
      return localStorage.getItem('astrisle-scene-quality') === 'balanced' ? 'balanced' : 'clear';
    } catch {
      return 'clear';
    }
  });
  const changeSceneQuality = (quality: SceneQuality) => {
    setSceneQuality(quality);
    try {
      localStorage.setItem('astrisle-scene-quality', quality);
    } catch {
      /* Session preference still applies. */
    }
  };
  const [reset, setReset] = useState(0);
  const [lightMode, setLightMode] = useState<IslandLightMode>(() => {
    try {
      const saved = localStorage.getItem(lightStorageKey);
      return saved === 'day' || saved === 'dusk' || saved === 'night' ? saved : 'auto';
    } catch {
      return 'auto';
    }
  });
  const changeLightMode = (mode: IslandLightMode) => {
    setLightMode(mode);
    try {
      localStorage.setItem(lightStorageKey, mode);
    } catch {
      setNotice('天色已应用到当前会话。无法保存到本机。');
    }
  };
  const [viewpoint, setViewpoint] = useState<CharacterFocus | StudioDistrict>();
  const characterFocus = isDistrict(viewpoint) ? undefined : viewpoint;
  const district = isDistrict(viewpoint) ? viewpoint : undefined;
  const visitObservatory = () => {
    setViewpoint('observatory');
    setFixed(false);
  };
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || false,
  );
  useEffect(() => {
    const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!preference) return;
    const changed = (event: MediaQueryListEvent) => setReduced(event.matches);
    preference.addEventListener('change', changed);
    return () => preference.removeEventListener('change', changed);
  }, []);
  const refresh = useCallback(async () => {
    if (!host) return;
    const request = ++refreshOrder.current.issued;
    const next = await host.bootstrap();
    if (!next.characters && host.getCharacters) next.characters = await host.getCharacters();
    if (request < refreshOrder.current.applied) return;
    refreshOrder.current.applied = request;
    setLoadError('');
    setBootstrap(next);
    setWorkspaceId((current) => current || next.workspaces[0]?.id || '');
  }, [host]);
  const loadStudio = useCallback(() => {
    setLoadError('');
    refresh().catch((error) =>
      setLoadError(error instanceof Error ? error.message : String(error)),
    );
  }, [refresh]);
  useEffect(loadStudio, [loadStudio]);
  useEffect(() => {
    selected.current = commissionId;
    setSnapshot(undefined);
    setAccepted([]);
    setPreview(undefined);
    setTaskId('');
    if (host && commissionId)
      host
        .snapshot(commissionId)
        .then(receiveSnapshot)
        .catch((e) => setNotice(String(e)));
  }, [commissionId, host, receiveSnapshot]);
  useEffect(
    () =>
      host?.onSnapshot((s) => {
        receiveSnapshot(s);
        refresh().catch(() => {});
      }),
    [host, refresh, receiveSnapshot],
  );
  useEffect(() => {
    if (!inspectorOpen || !dialogueSource || dialogueSource.target.commissionId !== commissionId)
      return;
    if (panel === 'tasks' && dialogueSource.panel === 'tasks' && taskId === dialogueSource.id) {
      document.getElementById('focused-task-detail')?.focus();
    }
    if (panel === 'evidence' && dialogueSource.panel === 'evidence') {
      const evidence = document.getElementById(`evidence-${dialogueSource.id}`);
      if (evidence instanceof HTMLDetailsElement) {
        evidence.open = true;
        evidence.querySelector('summary')?.focus();
      }
    }
  }, [commissionId, dialogueSource, inspectorOpen, panel, taskId]);
  useEffect(
    () => () => {
      dialoguePreviewRequest.current++;
    },
    [commissionId, inspectorOpen],
  );
  useEffect(() => {
    if (inspectorOpen && panel === 'dailyNews') {
      dailyNewsHeading.current?.focus({ preventScroll: true });
    }
  }, [inspectorOpen, panel]);
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
        receiveSnapshot(s);
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
  const dailyNewsHost = supportsDailyNews(host) ? host : undefined;
  const dailyNewsAvailable = !!workspace && !!dailyNewsHost;
  const openRequests = snapshot?.requests.filter((r) => r.status === 'open') || [];
  const task = snapshot?.tasks.find((t) => t.id === taskId);
  const provider = bootstrap?.provider;
  const characters = bootstrap?.characters || [...DEFAULT_CHARACTERS];
  const characterName = (id: string) =>
    characters.find((profile) => profile.id === id)?.displayName ||
    snapshot?.agents.find((agent) => agent.id === id)?.name ||
    id;
  const commissionPartners =
    snapshot?.commission.id === commissionId
      ? snapshot.agents.filter((agent) => agent.id !== 'user')
      : [];
  const activeDialogue =
    dialogueTarget?.commissionId === commissionId &&
    commissionPartners.some((agent) => agent.id === dialogueTarget.partnerId)
      ? dialogueTarget
      : undefined;
  const dialogue = usePartnerDialogue(
    activeDialogue,
    provider?.configured ? host?.askPartner : undefined,
  );
  const panelTitle =
    panel === 'dialogue' && activeDialogue
      ? `与${characterName(activeDialogue.partnerId)}对话`
      : panelNames[panel];
  const partnerCreated = (profile: CharacterProfile) => {
    // A bootstrap read started before this write can still be in flight.
    refreshOrder.current.applied = ++refreshOrder.current.issued;
    setBootstrap((previous) => {
      if (!previous || previous.characters?.some((entry) => entry.id === profile.id))
        return previous;
      return { ...previous, characters: [...(previous.characters ?? DEFAULT_CHARACTERS), profile] };
    });
    setNotice(`${profile.displayName} 已加入工作室`);
    void refresh().catch(() => {});
  };
  const artifactFamilies = useMemo(
    () => (snapshot ? artifactVersionFamilies(snapshot) : []),
    [snapshot],
  );
  const currentArtifacts = snapshot?.artifacts.filter((a) => a.validity === 'current') || [];
  const selectableArtifactIds = new Set(
    currentArtifacts
      .filter(
        (artifact) =>
          !snapshot?.commission.acceptedArtifactIds.includes(artifact.id) &&
          snapshot?.evidence.some(
            (evidence) =>
              evidence.kind === 'review' &&
              evidence.status === 'passed' &&
              evidence.artifactVersionIds.includes(artifact.versionId),
          ),
      )
      .map((artifact) => artifact.id),
  );
  const selectedArtifactIds = new Set(accepted.filter((id) => selectableArtifactIds.has(id)));
  const openArtifactPreview = async (id: string, expectedVersionId?: string) => {
    if (!host || !snapshot) return;
    const idAtOpen = snapshot.commission.id;
    const request = ++dialoguePreviewRequest.current;
    const fromDialogue = expectedVersionId !== undefined;
    const isCurrent = () =>
      selected.current === idAtOpen && dialoguePreviewRequest.current === request;
    if (!fromDialogue) setBusy(true);
    try {
      const artifact = await host.artifact(id);
      if (
        fromDialogue &&
        (artifact.artifact.versionId !== expectedVersionId ||
          artifact.artifact.commissionId !== idAtOpen)
      ) {
        throw new Error('The preview version does not match the requested reference.');
      }
      if (isCurrent()) {
        setPreview(artifact);
        if (!fromDialogue) setNotice('');
      }
    } catch {
      if (isCurrent()) setNotice('无法读取该版本的成果文件。');
    } finally {
      if (!fromDialogue) setBusy(false);
    }
  };
  const requestArtifactRework: HostAPI['requestArtifactRework'] = async (input) => {
    setBusy(true);
    try {
      const response = await host!.requestArtifactRework(input);
      void host!
        .snapshot(input.commissionId)
        .then(receiveSnapshot)
        .catch(() => {});
      if (response.ok) void refresh().catch(() => {});
      return response;
    } finally {
      setBusy(false);
    }
  };
  const openPanel = (next: Panel) => {
    if (next === 'dailyNews') {
      dailyNewsTrigger.current =
        document.activeElement instanceof HTMLButtonElement ? document.activeElement : null;
    }
    dialoguePreviewRequest.current++;
    setDialogueSource(undefined);
    setPanel(next);
    setInspectorOpen(true);
    setNavOpen(false);
  };
  const closeInspector = () => {
    setInspectorOpen(false);
    if (panel === 'dailyNews') {
      const trigger = dailyNewsTrigger.current;
      (trigger?.isConnected ? trigger : dailyNewsNav.current)?.focus({ preventScroll: true });
    }
  };
  const openDialogue = (partnerId: string) => {
    if (!commissionPartners.some((agent) => agent.id === partnerId)) {
      openPanel('tasks');
      return;
    }
    setDialogueTarget({ commissionId, partnerId });
    openPanel('dialogue');
  };
  const openDialogueReference = ({ kind, id }: PartnerDialogueReference) => {
    if (!activeDialogue || !snapshot || selected.current !== activeDialogue.commissionId) return;
    if (kind === 'commission' && id === snapshot.commission.id) {
      openPanel('goal');
      setDialogueSource({ target: activeDialogue, panel: 'goal', id });
      return;
    }
    if (kind === 'task' && snapshot.tasks.some((entry) => entry.id === id)) {
      setTaskId(id);
      openPanel('tasks');
      setDialogueSource({ target: activeDialogue, panel: 'tasks', id });
      return;
    }
    if (kind === 'evidence' && snapshot.evidence.some((entry) => entry.id === id)) {
      openPanel('evidence');
      setDialogueSource({ target: activeDialogue, panel: 'evidence', id });
      return;
    }
    if (kind === 'artifact') {
      const artifact = snapshot.artifacts.find((entry) => entry.versionId === id);
      if (artifact) {
        void openArtifactPreview(artifact.id, artifact.versionId);
        return;
      }
    }
    setNotice('这份引用资料在当前委托中暂不可用。');
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
          <img className="brand-orbit" src={astrisleMark} alt="" width={30} height={30} />
          <span>
            Astrisle<small>星岛工作室</small>
          </span>
        </a>
        <div className="island-switcher">
          <MapIcon size={16} />
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
            {host ? '桌面已连接' : '浏览器预览（内置角色）'}
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
            onClick={(event) => {
              if (!inspectorOpen && panel === 'dailyNews') {
                dailyNewsTrigger.current = event.currentTarget;
              }
              setInspectorOpen((v) => !v);
            }}
          >
            <PanelRightOpen size={17} />
            <span>工作面板</span>
          </button>
        </div>
      </header>
      <aside className="navigator">
        <div className="rail-tools">
          <button aria-label="查看群岛" title="查看群岛" onClick={showOverview}>
            <MapIcon size={19} />
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
            <p className="nav-empty">暂无委托</p>
          )}
        </div>
        <div className="nav-spacer" />
        <nav aria-label="工作室导航">
          {(
            [
              ['goal', Compass],
              ['tasks', Layers],
              ['requests', Inbox],
              ['dailyNews', Newspaper],
              ['artifacts', Archive],
              ['evidence', FileCheck2],
            ] as const
          )
            .filter(([key]) => key !== 'dailyNews' || dailyNewsAvailable)
            .map(([key, Icon]) => (
              <button
                key={key}
                ref={key === 'dailyNews' ? dailyNewsNav : undefined}
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
                  : district && !flat
                    ? districtNames[district]
                    : snapshot?.commission.title || workspace?.name || '星岛工作室'}
            </h1>
            {!overview && !flat && district === 'observatory' && (
              <select
                className="observatory-time"
                aria-label="观星台天色"
                value={lightMode}
                onChange={(event) => changeLightMode(event.target.value as IslandLightMode)}
              >
                <LightOptions />
              </select>
            )}
            {!overview && characterFocus && !flat && (
              <p>
                {characters.find((profile) => profile.id === characterFocus)?.model?.filename ||
                  '内置鲸鱼角色'}
              </p>
            )}
          </div>
          {snapshot && !overview && !characterFocus && (
            <div className="stage-actions">
              {snapshot.commission.status === 'accepted' && (
                <button className="celebration-action" onClick={celebration.celebrate}>
                  <PartyPopper size={16} />
                  庆祝一下
                </button>
              )}
              <Status value={snapshot.commission.status} />
            </div>
          )}
        </div>
        {celebration.burst !== null && (
          <div className="completion-note" role="status">
            委托已完成
          </div>
        )}
        {host && !bootstrap && !flat ? (
          <div className="scene-loading" role="status">
            {loadError ? (
              <>
                <span>工作室加载失败：{loadError}</span>
                <button onClick={loadStudio}>重新加载</button>
              </>
            ) : (
              '正在读取工作室和角色配置…'
            )}
          </div>
        ) : overview && !flat ? (
          <Archipelago
            quality={sceneQuality}
            lightMode={lightMode}
            workspaces={bootstrap?.workspaces || []}
            themeOverrides={islandThemeOverrides}
            selectedId={workspaceId}
            onSelect={switchWorkspace}
            reduced={reduced}
          />
        ) : !flat ? (
          <StudioScene
            quality={sceneQuality}
            key={workspaceId || 'preview'}
            workspaceId={workspaceId || 'preview'}
            themeId={islandTheme}
            snapshot={snapshot}
            onPanel={openPanel}
            dailyNewsAvailable={dailyNewsAvailable}
            onPartner={openDialogue}
            reduced={reduced}
            reset={reset}
            fixed={fixed}
            focus={characterFocus}
            district={district}
            lightMode={lightMode}
            onVisitObservatory={visitObservatory}
            characters={characters}
            celebration={celebration.burst}
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
                    <small className="island-theme-label">
                      {islandAppearance(w.id, islandThemeOverrides.get(w.id)).name}
                    </small>
                  </button>
                ))}
              </div>
            )}
            <p>{snapshot?.commission.goal || '尚未选择委托。'}</p>
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
                成果 {artifactFamilies.length}
              </button>
              {dailyNewsAvailable && (
                <button onClick={() => openPanel('dailyNews')}>
                  <Newspaper />
                  日报邮箱
                </button>
              )}
            </div>
          </div>
        )}
        {(overview || !flat) && (
          <div
            className={`scene-caption${!overview && !flat && !characterFocus ? ' camera-hint' : ''}`}
          >
            <span className="caption-line" />
            <span>
              {overview
                ? `${bootstrap?.workspaces.length || 0} 座持久岛屿 · 每座对应一个项目`
                : characterFocus && !flat
                  ? `${characterName(characterFocus)} · 拖动旋转，滚轮缩放`
                  : fixed
                    ? '镜头已固定'
                    : '拖动环绕 · 右键平移 · 滚轮缩放 / 单指环绕 · 双指平移缩放'}
            </span>
          </div>
        )}
        <div className="view-controls">
          <button
            aria-label="回到全景"
            title="回到全景"
            onClick={() => {
              setViewpoint(undefined);
              setReset((r) => r + 1);
            }}
          >
            <Maximize2 size={16} />
          </button>
          <span />
          {!flat && !overview && (
            <select
              aria-label="场景视角与角色特写"
              value={viewpoint ?? ''}
              onChange={(event) => {
                setViewpoint((event.target.value || undefined) as typeof viewpoint);
                setFixed(false);
              }}
            >
              <option value="">工作室全景</option>
              {Object.entries(districtNames).map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
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
              <strong>{workspace?.name || '暂无岛屿'}</strong>
              {workspace && (
                <p>
                  {bootstrap?.commissions.filter((entry) => entry.workspaceId === workspace.id)
                    .length ?? 0}{' '}
                  份委托
                </p>
              )}
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
          <div className={`commission-dock${snapshot ? '' : ' empty-dock'}`}>
            {snapshot && (
              <div>
                <strong>
                  已完成 {snapshot.tasks.filter((t) => t.status === 'passed').length} /{' '}
                  {snapshot.tasks.length} 项任务
                </strong>
                {openRequests.length > 0 && <p>{openRequests.length} 项待回复</p>}
              </div>
            )}
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
        className={`inspector ${panel === 'dialogue' ? 'inspector-dialogue' : ''}`}
        aria-hidden={!inspectorOpen}
        inert={!inspectorOpen}
        aria-label={panelTitle}
      >
        <header className="inspector-header">
          <div>
            <h2 ref={dailyNewsHeading} tabIndex={panel === 'dailyNews' ? -1 : undefined}>
              {panelTitle}
            </h2>
          </div>
          <div>
            {snapshot && panel !== 'dailyNews' && (
              <span className="revision">修订 {snapshot.commission.revision}</span>
            )}
            <button className="icon-button" aria-label="收起工作面板" onClick={closeInspector}>
              <X size={18} />
            </button>
          </div>
        </header>
        <div className="inspector-body">
          {dialogueSource?.target.commissionId === commissionId &&
            dialogueSource.panel === panel && (
              <button
                className="dialogue-return"
                type="button"
                onClick={() => openDialogue(dialogueSource.target.partnerId)}
              >
                <ArrowLeft size={14} aria-hidden="true" /> 返回对话
              </button>
            )}
          {panel === 'dailyNews' ? (
            workspace && dailyNewsHost ? (
              inspectorOpen && (
                <DailyNewsPanel
                  key={workspace.id}
                  host={dailyNewsHost}
                  workspaceId={workspace.id}
                />
              )
            ) : (
              <Empty title="尚未选择岛屿">选择一座岛屿后，可查看它的日报邮箱。</Empty>
            )
          ) : panel === 'settings' ? (
            <SettingsPanel
              provider={provider}
              busy={busy || (!!host && !bootstrap)}
              reduced={reduced}
              onReduced={setReduced}
              quality={sceneQuality}
              onQuality={changeSceneQuality}
              lightMode={lightMode}
              onLightMode={changeLightMode}
              workspace={workspace}
              islandTheme={islandTheme}
              onIslandTheme={changeIslandTheme}
              run={run}
              host={host}
              characters={characters}
              onPartnerCreated={partnerCreated}
            />
          ) : !snapshot ? (
            <>
              <Empty title={host ? '尚未选择委托' : '在桌面版开始协作'}>
                {host
                  ? '从左侧选择已有委托，或新建一份。'
                  : '浏览器可以浏览岛屿。创建项目和执行任务需要使用桌面版。'}
              </Empty>
              {host && (
                <button
                  className="primary wide"
                  onClick={() => setModal(workspace ? 'commission' : 'workspace')}
                >
                  {workspace ? '新建委托' : '创建岛屿'}
                </button>
              )}
            </>
          ) : (
            <>
              {inspectorOpen && panel === 'dialogue' && activeDialogue && (
                <PartnerDialogue
                  key={activeDialogue.partnerId}
                  name={characterName(activeDialogue.partnerId)}
                  commission={snapshot.commission.title}
                  dialogue={dialogue}
                  supported={Boolean(host?.askPartner)}
                  configured={provider?.configured === true}
                  onBack={() => openPanel('tasks')}
                  onSettings={() => {
                    openPanel('settings');
                    requestAnimationFrame(() =>
                      document.getElementById('model-preferences')?.focus(),
                    );
                  }}
                  onReference={openDialogueReference}
                />
              )}
              {panel === 'goal' && (
                <>
                  <div className="goal-summary">
                    <Status value={snapshot.commission.status} />
                    <h3>{snapshot.commission.title}</h3>
                    <p>{snapshot.commission.goal}</p>
                  </div>
                  <CommissionActivity
                    key={commissionId}
                    snapshot={snapshot}
                    characterName={characterName}
                    onTask={(id) => {
                      setTaskId(id);
                      openPanel('tasks');
                    }}
                  />
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
                    {snapshot.commission.scope.allowNetwork && (
                      <>
                        <dt>网页来源域名</dt>
                        <dd>{snapshot.commission.scope.allowedHosts.join('\n') || '无'}</dd>
                        <dt>SearXNG 搜索</dt>
                        <dd>{snapshot.commission.scope.searchEndpoint || '未配置'}</dd>
                      </>
                    )}
                  </dl>
                  <BudgetPanel
                    key={commissionId}
                    commission={snapshot.commission}
                    reworks={
                      snapshot.events.filter((event) => event.type === 'rework_created').length
                    }
                    busy={busy}
                    onSave={(budget, revision) =>
                      run(() => host!.updateBudget(commissionId, budget, revision))
                    }
                  />
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
                  {commissionPartners.length > 0 && (
                    <div className="dialogue-entries" role="group" aria-label="委托伙伴">
                      {commissionPartners.map(({ id }) => {
                        const name = characterName(id);
                        return (
                          <button
                            className="dialogue-entry"
                            key={id}
                            type="button"
                            aria-label={`与${name}对话`}
                            onClick={() => openDialogue(id)}
                          >
                            <span>{name}</span>
                            <MessageCircle size={15} aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {snapshot.tasks.length === 0 ? (
                    <Empty title="还没有任务">计划生成后可查看每项任务的进度。</Empty>
                  ) : (
                    snapshot.tasks.map((t) => (
                      <button
                        className={`task-row ${taskId === t.id ? 'selected' : ''}`}
                        key={t.id}
                        onClick={() => setTaskId(t.id)}
                      >
                        <span
                          className={`partner-small ${t.agentId === 'mori' || t.agentId === 'luma' ? t.agentId : 'custom-partner'}`}
                        >
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
                    <section className="task-detail" id="focused-task-detail" tabIndex={-1}>
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
                  {snapshot.evidence.length === 0 ? (
                    <Empty title="还没有检查记录">
                      实际检查完成后，结果和完整输出会保存在这里。
                    </Empty>
                  ) : (
                    snapshot.evidence.map((e) => (
                      <details className="evidence" key={e.id} id={`evidence-${e.id}`}>
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
                  {snapshot.artifacts.length === 0 ? (
                    <Empty title="暂无成果">文件提交后可在这里预览、验收和导出。</Empty>
                  ) : (
                    <ArtifactReview
                      key={snapshot.commission.id}
                      snapshot={snapshot}
                      characterName={characterName}
                      families={artifactFamilies}
                      busy={busy}
                      selectable={selectableArtifactIds}
                      selected={selectedArtifactIds}
                      onSelect={(id, checked) =>
                        setAccepted((ids) =>
                          checked ? [...ids, id] : ids.filter((item) => item !== id),
                        )
                      }
                      onPreview={(id) => void openArtifactPreview(id)}
                      onTask={(id) => {
                        setTaskId(id);
                        openPanel('tasks');
                      }}
                      compare={(input) => host!.compareArtifacts(input)}
                      submitRework={requestArtifactRework}
                    />
                  )}
                  {currentArtifacts.length > 0 && (
                    <>
                      <div className="accept-note">
                        {selectableArtifactIds.size > 0
                          ? '请选择已通过复核的当前版本。'
                          : currentArtifacts.every((artifact) =>
                                snapshot.commission.acceptedArtifactIds.includes(artifact.id),
                              )
                            ? '当前成果均已接受。'
                            : '当前成果通过复核后可以接受。'}
                      </div>
                      <button
                        className="primary wide"
                        disabled={busy || selectedArtifactIds.size === 0}
                        onClick={() =>
                          run(() => host!.accept(commissionId, [...selectedArtifactIds])).then(
                            (result) => {
                              if (result) setAccepted([]);
                            },
                          )
                        }
                      >
                        <Check size={16} />
                        接受选中成果（{selectedArtifactIds.size}）
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
                  <WritebackHistory
                    operations={snapshot.applyOperations ?? []}
                    busy={busy}
                    onInspect={(id) => {
                      void run(async () => {
                        await host!.inspectApply!(id);
                      }, '已核查写回状态');
                    }}
                    onRollback={(id) => {
                      void run(async () => {
                        setApplyPreview(await host!.prepareRollback!(id));
                      }, '恢复预览已生成');
                    }}
                    onBackups={(id) => {
                      void run(() => host!.openApplyBackups!(id));
                    }}
                  />
                </>
              )}
            </>
          )}
        </div>
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
          characters={characters}
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
          <ArtifactWebSources
            key={preview.artifact.versionId}
            artifact={preview.artifact}
            evidence={snapshot?.evidence ?? []}
          />
          <div className="button-row">
            <button
              disabled={busy}
              onClick={() => run(() => host!.openArtifact(preview.artifact.id))}
            >
              <FolderOpen size={16} />
              在系统中打开
            </button>
          </div>
          <ArtifactSourceExport
            key={preview.artifact.versionId}
            artifact={preview.artifact}
            disabled={busy}
            exportSource={(input) => host!.exportSourceArtifact(input)}
          />
        </Modal>
      )}
      {applyPreview && (
        <Modal
          title={applyPreview.mode === 'rollback' ? '确认恢复写回前的文件' : '确认写回原项目'}
          onClose={() => setApplyPreview(undefined)}
        >
          <WritebackPreview preview={applyPreview} />
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
              {applyPreview.mode === 'rollback' ? '确认恢复' : '确认写回'}{' '}
              {applyPreview.changes.length} 项更改
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
        <p className="modal-intro">新建空白项目，或从本地目录导入工作副本。</p>
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
  characters,
  busy,
  configured,
  onClose,
  onSettings,
  onSubmit,
}: {
  workspace: Workspace;
  characters: CharacterProfile[];
  busy: boolean;
  configured: boolean;
  onClose: () => void;
  onSettings: () => void;
  onSubmit: (input: Parameters<NonNullable<Window['astrisle']>['submit']>[0]) => unknown;
}) {
  const [allowNetwork, setAllowNetwork] = useState(false);
  const [networkError, setNetworkError] = useState<'searchEndpoint' | 'hosts'>();
  const permissions = useRef<HTMLDetailsElement>(null);
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const allowedHosts = String(d.get('hosts') || '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
    const searchEndpoint = String(d.get('searchEndpoint') || '').trim();
    let invalidField: typeof networkError;
    if (searchEndpoint && !isSearchEndpoint(searchEndpoint)) invalidField = 'searchEndpoint';
    else if (searchEndpoint && (!allowedHosts.length || !allowedHosts.every(isSourceHostname)))
      invalidField = 'hosts';
    if (invalidField) {
      setNetworkError(invalidField);
      if (permissions.current) permissions.current.open = true;
      e.currentTarget.querySelector<HTMLInputElement>(`[name="${invalidField}"]`)?.focus();
      return;
    }
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
        allowedHosts,
        ...(searchEndpoint ? { searchEndpoint } : {}),
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
    <Modal title="新建委托" onClose={onClose}>
      <form onSubmit={submit}>
        <p className="modal-intro">{workspace.name}</p>
        <label htmlFor="goal">工作目标</label>
        <textarea
          id="goal"
          name="goal"
          placeholder="例如，整理本月销售记录，生成一份带图表的报告"
          required
          rows={4}
          autoFocus
        />
        {characters.some((profile) => profile.id.startsWith('partner-')) && (
          <p className="field-hint commission-partners">
            可在目标中点名分工。工作伙伴包括
            {characters
              .filter((profile) => profile.id !== 'user')
              .map((profile) => profile.displayName)
              .join('、')}
            。
          </p>
        )}
        <label htmlFor="criteria">验收条件（每行一项）</label>
        <textarea
          id="criteria"
          name="criteria"
          placeholder={'例如：\n说明数据来源与结论\n检查生成的文件能否正常打开'}
          rows={3}
          required
        />
        <details className="scope-details" ref={permissions}>
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
            <input
              name="network"
              type="checkbox"
              checked={allowNetwork}
              onChange={(e) => {
                setAllowNetwork(e.target.checked);
                setNetworkError(undefined);
              }}
            />
            允许访问网络
          </label>
          <label htmlFor="hosts">网页来源域名（英文逗号分隔）</label>
          <input
            id="hosts"
            name="hosts"
            placeholder="docs.example.com"
            disabled={!allowNetwork}
            aria-invalid={networkError === 'hosts'}
            aria-describedby={`hosts-hint${networkError === 'hosts' ? ' web-permissions-error' : ''}`}
            onChange={() => setNetworkError(undefined)}
          />
          <p className="field-hint" id="hosts-hint">
            搜索结果和网页原文限定在这里列出的域名。使用搜索时至少填写一个域名。
          </p>
          <label htmlFor="search-endpoint">SearXNG 搜索地址（可选）</label>
          <input
            id="search-endpoint"
            name="searchEndpoint"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="https://search.example.com/search"
            disabled={!allowNetwork}
            aria-invalid={networkError === 'searchEndpoint'}
            aria-describedby={`search-hint${networkError === 'searchEndpoint' ? ' web-permissions-error' : ''}`}
            onChange={() => setNetworkError(undefined)}
          />
          <p className="field-hint" id="search-hint">
            填写已启用 JSON 格式的 SearXNG 完整搜索地址。该服务会收到搜索关键词。
          </p>
          {networkError && (
            <p className="error-text" id="web-permissions-error" role="alert">
              {networkError === 'searchEndpoint'
                ? '请输入有效的 HTTP 或 HTTPS 搜索地址，省略凭据、查询参数和片段。'
                : '搜索需要至少一个主机名。填写 docs.example.com 这样的主机名，省略协议、端口和路径。'}
            </p>
          )}
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
function IslandThemeSelect({
  workspace,
  themeId,
  onChange,
}: {
  workspace: Workspace;
  themeId?: IslandThemeId;
  onChange: (themeId?: IslandThemeId) => void;
}) {
  const palette = islandAppearance(workspace.id, themeId);
  const automatic = islandAppearance(workspace.id);
  return (
    <section className="island-theme-settings">
      <label htmlFor="island-theme">岛屿主题</label>
      <div className="island-theme-picker">
        <select
          id="island-theme"
          aria-describedby="island-theme-scope"
          value={themeId ?? ''}
          onChange={(event) => {
            const value = event.target.value;
            onChange(isIslandThemeId(value) ? value : undefined);
          }}
        >
          <option value="">自动（{automatic.name}）</option>
          {islandThemes.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.name}
            </option>
          ))}
        </select>
        <div className="island-theme-swatches" aria-hidden="true">
          {[palette.grass, palette.water, palette.flower, palette.flag].map((color) => (
            <span key={color} style={{ backgroundColor: color }} />
          ))}
        </div>
      </div>
      <p className="quiet" id="island-theme-scope">
        仅应用于「{workspace.name}」并保存在本机。
      </p>
    </section>
  );
}

function SettingsPanel({
  provider,
  busy,
  reduced,
  onReduced,
  quality,
  onQuality,
  lightMode,
  onLightMode,
  workspace,
  islandTheme,
  onIslandTheme,
  run,
  host,
  characters,
  onPartnerCreated,
}: {
  provider?: Bootstrap['provider'];
  busy: boolean;
  reduced: boolean;
  onReduced: (v: boolean) => void;
  quality: SceneQuality;
  onQuality: (quality: SceneQuality) => void;
  lightMode: IslandLightMode;
  onLightMode: (mode: IslandLightMode) => void;
  workspace?: Workspace;
  islandTheme?: IslandThemeId;
  onIslandTheme: (themeId?: IslandThemeId) => void;
  run: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
  host: Window['astrisle'];
  characters: CharacterProfile[];
  onPartnerCreated: (profile: CharacterProfile) => void;
}) {
  const [addedPartner, setAddedPartner] = useState<CharacterProfile['id']>();
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
  }, [provider?.kind, provider?.baseUrl, provider?.model]);
  return (
    <>
      <nav className="settings-index" aria-label="设置分区">
        {(
          [
            ['scene-preferences', '岛屿与场景'],
            ['character-preferences', '角色外观'],
            ['model-preferences', '模型连接'],
          ] as const
        ).map(([id, name]) => (
          <a
            key={id}
            href={`#${id}`}
            onClick={(event) => {
              event.preventDefault();
              const heading = document.getElementById(id);
              heading?.focus({ preventScroll: true });
              heading?.scrollIntoView({ block: 'start' });
            }}
          >
            {name}
          </a>
        ))}
      </nav>
      <h4 id="scene-preferences" tabIndex={-1} className="settings-heading">
        岛屿与场景
      </h4>
      {workspace && (
        <IslandThemeSelect workspace={workspace} themeId={islandTheme} onChange={onIslandTheme} />
      )}
      <SceneQualitySelect value={quality} onChange={onQuality} />
      <label htmlFor="island-daylight">岛上天色</label>
      <select
        id="island-daylight"
        value={lightMode}
        onChange={(e) => onLightMode(e.target.value as IslandLightMode)}
      >
        <LightOptions />
      </select>
      <label className="check-label">
        <input type="checkbox" checked={reduced} onChange={(e) => onReduced(e.target.checked)} />
        减少角色动作
      </label>
      <h4 id="character-preferences" tabIndex={-1} className="settings-heading">
        角色外观与名称
      </h4>
      <p className="field-hint">所有岛屿共用这组角色。</p>
      <PartnerCreator
        create={host?.createCharacter}
        busy={busy}
        onCreated={(profile) => {
          setAddedPartner(profile.id);
          onPartnerCreated(profile);
        }}
      />
      <details className="model-format-help">
        <summary>支持的模型格式</summary>
        <p>
          支持 GLB、自包含 glTF 2、3MF、STL、OBJ 和 FBX。模型与资源合计上限 100 MB。OBJ 的 MTL、OBJ
          和 FBX 的贴图应放在模型目录中。STL 主要保留几何，3MF 和 OBJ 不含角色骨骼动画。暂不支持
          Draco、Meshopt、KTX2 和部分 3MF 扩展。
        </p>
      </details>
      {characters.map((profile) => (
        <CharacterSettings
          key={profile.id}
          profile={profile}
          focusImport={profile.id === addedPartner}
          busy={busy}
          host={host}
          run={run}
        />
      ))}
      <h4 id="model-preferences" tabIndex={-1} className="settings-heading">
        模型连接
      </h4>
      <p className="field-hint">
        {provider?.configured ? `当前模型　${provider.model}` : '尚未配置模型服务'}
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
          disabled={!!host && !provider}
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
          disabled={!!host && !provider}
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          required
          type="url"
        />
        <p className="field-hint">兼容协议可填写 DeepSeek、通义、硅基流动或本地服务地址。</p>
        <label htmlFor="provider-model">模型名称</label>
        <input
          id="provider-model"
          disabled={!!host && !provider}
          value={model}
          onChange={(e) => setModel(e.target.value)}
          required
        />
        <label htmlFor="provider-key">API 密钥 {provider?.hasApiKey ? '· 已保存' : ''}</label>
        <input
          id="provider-key"
          disabled={!!host && !provider}
          ref={keyRef}
          type="password"
          autoComplete="new-password"
          placeholder={provider?.hasApiKey ? '留空保留已有密钥' : '输入你的 API 密钥'}
        />
        <p className="field-hint">密钥保存在本机，不写入委托记录。</p>
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
    </>
  );
}

function CharacterSettings({
  profile,
  focusImport,
  busy,
  host,
  run,
}: {
  profile: CharacterProfile;
  focusImport: boolean;
  busy: boolean;
  host: Window['astrisle'];
  run: (fn: () => Promise<unknown>, message?: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(profile.displayName);
  const importButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focusImport) importButton.current?.focus();
  }, [focusImport]);
  useEffect(() => setName(profile.displayName), [profile.displayName]);
  const validName = isValidCharacterName(name);
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
            ref={importButton}
            disabled={busy || (!host?.importCharacter && !host?.prepareCharacterImport)}
            aria-label={`为${profile.displayName}导入模型`}
            onClick={() =>
              run(async () => {
                let imported: CharacterProfile | null;
                if (host?.prepareCharacterImport && host.completeCharacterImport) {
                  const pending = await host.prepareCharacterImport(profile.id);
                  if (!pending) return { ok: true, message: '已取消导入，角色保持不变' };
                  try {
                    const { inspectCharacterImport } = await import('./characters/model-cache');
                    const inspection = await inspectCharacterImport(pending.bytes);
                    imported = await host.completeCharacterImport(
                      profile.id,
                      pending.importId,
                      inspection,
                    );
                  } finally {
                    await host.cancelCharacterImport?.(pending.importId);
                  }
                } else {
                  imported = await host!.importCharacter!(profile.id);
                }
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
                : '没有内置动画；适合的直立模型会尝试基础步态。'}
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
