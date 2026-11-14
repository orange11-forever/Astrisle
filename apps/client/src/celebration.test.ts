import { expect, it } from 'vitest';
import { shouldCelebrate } from './celebration';
const current = { id: 'one', revision: 1, status: 'accepted' };
it('celebrates only a live transition to full acceptance', () => {
  expect(shouldCelebrate({ ...current, status: 'awaiting_acceptance' }, current)).toBe(true);
  expect(shouldCelebrate(current, current)).toBe(false);
  expect(shouldCelebrate(undefined, current)).toBe(false);
  expect(shouldCelebrate({ ...current, id: 'another' }, current)).toBe(false);
  expect(
    shouldCelebrate(
      { ...current, status: 'active' },
      { ...current, status: 'awaiting_acceptance' },
    ),
  ).toBe(false);
  expect(
    shouldCelebrate({ ...current, status: 'active' }, { ...current, status: 'cancelled' }),
  ).toBe(false);
});
it('does not replay another revision or a historical island selection', () => {
  expect(shouldCelebrate({ ...current, revision: 0, status: 'active' }, current)).toBe(false);
  expect(shouldCelebrate(undefined, undefined)).toBe(false);
});
