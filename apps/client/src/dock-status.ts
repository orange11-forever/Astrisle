import type { Bootstrap, Commission, ProjectSnapshot } from '@astrisle/contracts';

export interface DockAction {
  summary: string;
  actionLabel: string;
  targetPanel: 'requests' | 'artifacts' | 'goal';
}

export function deriveDockAction(snapshot?: ProjectSnapshot): DockAction | null {
  if (!snapshot) return null;

  const openRequests = snapshot.requests.filter((request) => request.status === 'open');
  if (openRequests.length > 0) {
    if (openRequests.some((request) => request.purpose === 'git_delivery')) {
      return {
        summary: '成果已验收，等待确认 Git 推送',
        actionLabel: '查看 Git 交付',
        targetPanel: 'artifacts',
      };
    }
    return {
      summary:
        openRequests.length === 1
          ? openRequests[0]!.title || '1 项问题或审批待处理'
          : `${openRequests.length} 项问题或审批待处理`,
      actionLabel: `去处理（${openRequests.length}）`,
      targetPanel: 'requests',
    };
  }

  if (snapshot.commission.status === 'awaiting_acceptance') {
    return {
      summary: '全部任务已通过独立复核',
      actionLabel: '去验收成果',
      targetPanel: 'artifacts',
    };
  }

  if (snapshot.commission.status === 'paused') {
    return {
      summary: snapshot.commission.summary.trim() || '委托已暂停',
      actionLabel: '查看原因',
      targetPanel: 'goal',
    };
  }

  return null;
}

export function commissionSummaryChanged(existing: Commission, incoming: Commission): boolean {
  return (
    existing.updatedAt !== incoming.updatedAt ||
    existing.status !== incoming.status ||
    existing.title !== incoming.title ||
    existing.revision !== incoming.revision ||
    existing.stepsUsed !== incoming.stepsUsed ||
    existing.summary !== incoming.summary ||
    existing.budgetRevision !== incoming.budgetRevision
  );
}

export function syncBootstrapCommission(
  previous: Bootstrap | undefined,
  incoming: Commission,
): Bootstrap | undefined {
  if (!previous) return previous;
  const index = previous.commissions.findIndex((entry) => entry.id === incoming.id);
  if (index === -1) return previous;
  const existing = previous.commissions[index]!;
  if (!commissionSummaryChanged(existing, incoming)) return previous;
  const commissions = previous.commissions.slice();
  commissions[index] = incoming;
  return { ...previous, commissions };
}
