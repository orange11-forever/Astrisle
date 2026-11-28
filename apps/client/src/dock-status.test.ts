import { describe, expect, it } from 'vitest';
import type { Bootstrap, Commission, ProjectSnapshot, UserRequest } from '@astrisle/contracts';
import { deriveDockAction, syncBootstrapCommission } from './dock-status';

function makeCommission(overrides: Partial<Commission> = {}): Commission {
  return {
    id: 'commission-1',
    workspaceId: 'workspace-1',
    title: '整理季度简报',
    goal: '生成简报与预算表',
    status: 'active',
    criteria: [{ id: 'c1', description: '数据完整' }],
    scope: {
      readRoots: ['E:/work'],
      writeRoots: ['E:/work'],
      allowProcess: false,
      allowNetwork: false,
      allowedHosts: [],
    },
    budget: { maxSteps: 40, maxMinutes: 20, maxRework: 2 },
    revision: 1,
    planningMode: 'auto',
    stepsUsed: 3,
    budgetRevision: 0,
    createdAt: '2026-11-27T08:00:00.000Z',
    updatedAt: '2026-11-27T08:05:00.000Z',
    acceptedArtifactIds: [],
    summary: '',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<UserRequest> = {}): UserRequest {
  return {
    id: 'req-1',
    commissionId: 'commission-1',
    kind: 'input',
    title: '请确认报告目标读者',
    detail: '对内汇报还是对外发布？',
    status: 'open',
    createdAt: '2026-11-27T08:06:00.000Z',
    ...overrides,
  };
}

function makeSnapshot(
  commissionOverrides: Partial<Commission> = {},
  requests: UserRequest[] = [],
): ProjectSnapshot {
  return {
    commission: makeCommission(commissionOverrides),
    workspace: {
      id: 'workspace-1',
      name: '星岛',
      sourcePath: '',
      workPath: 'E:/work',
      createdAt: '2026-11-27T08:00:00.000Z',
    },
    agents: [],
    tasks: [],
    artifacts: [],
    evidence: [],
    events: [],
    requests,
    lastSequence: 1,
  };
}

describe('deriveDockAction', () => {
  it('returns null when snapshot is undefined or no user intervention is needed', () => {
    expect(deriveDockAction(undefined)).toBeNull();
    for (const status of [
      'draft',
      'active',
      'accepted',
      'cancelling',
      'cancelled',
      'failed',
    ] as const) {
      expect(deriveDockAction(makeSnapshot({ status }))).toBeNull();
    }
  });

  it('ignores answered and rejected requests', () => {
    const snapshot = makeSnapshot({ status: 'active' }, [
      makeRequest({ id: 'r1', status: 'answered' }),
      makeRequest({ id: 'r2', status: 'rejected' }),
    ]);
    expect(deriveDockAction(snapshot)).toBeNull();
  });

  it('surfaces a single open input or approval request with its title', () => {
    const snapshot = makeSnapshot({ status: 'paused', summary: '等待用户回复' }, [
      makeRequest({ kind: 'approval', title: '审阅任务计划后开始执行' }),
    ]);
    expect(deriveDockAction(snapshot)).toEqual({
      summary: '审阅任务计划后开始执行',
      actionLabel: '去处理（1）',
      targetPanel: 'requests',
    });
  });

  it('aggregates multiple open input/approval requests', () => {
    const snapshot = makeSnapshot({ status: 'active' }, [
      makeRequest({ id: 'r1', kind: 'input', title: '补充统计口径' }),
      makeRequest({ id: 'r2', kind: 'approval', title: '批准命令执行' }),
    ]);
    expect(deriveDockAction(snapshot)).toEqual({
      summary: '2 项问题或审批待处理',
      actionLabel: '去处理（2）',
      targetPanel: 'requests',
    });
  });

  it('routes open git_delivery requests directly to the artifacts panel', () => {
    const snapshot = makeSnapshot({ status: 'accepted' }, [
      makeRequest({
        id: 'git-1',
        purpose: 'git_delivery',
        kind: 'approval',
        title: '确认推送 Git 分支',
      }),
    ]);
    expect(deriveDockAction(snapshot)).toEqual({
      summary: '成果已验收，等待确认 Git 推送',
      actionLabel: '查看 Git 交付',
      targetPanel: 'artifacts',
    });
  });

  it('prompts acceptance when all tasks passed independent review', () => {
    const snapshot = makeSnapshot({ status: 'awaiting_acceptance' });
    expect(deriveDockAction(snapshot)).toEqual({
      summary: '全部任务已通过独立复核',
      actionLabel: '去验收成果',
      targetPanel: 'artifacts',
    });
  });

  it('shows pause reason or fallback when commission is paused without open requests', () => {
    expect(
      deriveDockAction(makeSnapshot({ status: 'paused', summary: '已达到最多 40 步工作预算' })),
    ).toEqual({
      summary: '已达到最多 40 步工作预算',
      actionLabel: '查看原因',
      targetPanel: 'goal',
    });

    expect(deriveDockAction(makeSnapshot({ status: 'paused', summary: '   ' }))).toEqual({
      summary: '委托已暂停',
      actionLabel: '查看原因',
      targetPanel: 'goal',
    });
  });
});

describe('syncBootstrapCommission', () => {
  const first = makeCommission({ id: 'c-1', title: '第一份委托' });
  const second = makeCommission({ id: 'c-2', title: '第二份委托' });
  const baseBootstrap: Bootstrap = {
    workspaces: [],
    commissions: [first, second],
    provider: {
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'test-model',
      hasApiKey: true,
      configured: true,
    },
    capabilities: [],
    version: '0.1.0',
  };

  it('preserves reference identity when bootstrap is undefined, commission is unknown, or summary fields are unchanged', () => {
    expect(syncBootstrapCommission(undefined, first)).toBeUndefined();
    expect(syncBootstrapCommission(baseBootstrap, makeCommission({ id: 'c-unknown' }))).toBe(
      baseBootstrap,
    );
    expect(
      syncBootstrapCommission(baseBootstrap, {
        ...second,
        activeMilliseconds: 1500,
      }),
    ).toBe(baseBootstrap);
  });

  it('replaces only the matching commission when tracked summary fields change', () => {
    const updated = {
      ...second,
      status: 'awaiting_acceptance' as const,
      stepsUsed: 9,
      updatedAt: '2026-11-27T08:12:00.000Z',
    };
    const next = syncBootstrapCommission(baseBootstrap, updated);
    expect(next).not.toBe(baseBootstrap);
    expect(next?.commissions[0]).toBe(first);
    expect(next?.commissions[1]).toBe(updated);
  });
});
