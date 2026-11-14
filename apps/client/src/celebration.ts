import { useCallback, useEffect, useRef, useState } from 'react';
type Completion = { id: string; revision: number; status: string };
export function shouldCelebrate(previous: Completion | undefined, current: Completion | undefined) {
  return (
    !!previous &&
    !!current &&
    previous.id === current.id &&
    previous.revision === current.revision &&
    ['active', 'paused', 'awaiting_acceptance'].includes(previous.status) &&
    current.status === 'accepted'
  );
}
export function useCompletionCelebration(
  current: Completion | undefined,
  workspaceId: string | undefined,
) {
  const previous = useRef<Completion | undefined>(undefined),
    sequence = useRef(0);
  const [burst, setBurst] = useState<number | null>(null);
  const celebrate = useCallback(() => {
    if (current?.status === 'accepted') setBurst(++sequence.current);
  }, [current?.status]);
  useEffect(() => {
    if (shouldCelebrate(previous.current, current)) setBurst(++sequence.current);
    else if (
      previous.current?.id !== current?.id ||
      previous.current?.revision !== current?.revision
    )
      setBurst(null);
    previous.current = current
      ? { id: current.id, revision: current.revision, status: current.status }
      : undefined;
  }, [current?.id, current?.revision, current?.status, workspaceId]);
  useEffect(() => {
    if (burst === null) return;
    const timer = setTimeout(() => setBurst(null), 3600);
    return () => clearTimeout(timer);
  }, [burst]);
  return { burst, celebrate };
}
