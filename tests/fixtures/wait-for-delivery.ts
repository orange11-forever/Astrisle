import { expect, vi } from 'vitest';
import type { RuntimeService } from '../../packages/runtime/src/index';

/** A complete handoff can include several rounds of durable file and SQLite writes on Windows. */
export function waitForDelivery(runtime: RuntimeService, commissionId: string) {
  return vi.waitFor(
    async () => {
      const snapshot = await runtime.snapshot(commissionId);
      expect(snapshot.commission.status, snapshot.commission.summary).toBe('awaiting_acceptance');
      return snapshot;
    },
    { interval: 200, timeout: 20_000 },
  );
}
