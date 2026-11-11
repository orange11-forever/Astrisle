import { describe, expect, it } from 'vitest';
import { islandAppearance, islandPosition, islandSeed } from './islands';
describe('persistent island identity', () => {
  it('keeps palette and decoration stable across snapshot rebuilds', () => {
    expect(islandAppearance('workspace-1')).toEqual(islandAppearance('workspace-1'));
    expect(islandSeed('workspace-1')).not.toBe(islandSeed('workspace-2'));
  });
  it('gives each workspace a separate reachable overview location as the collection grows', () => {
    for (const count of [1, 2, 3, 4, 9, 20]) {
      const positions = Array.from({ length: count }, (_, i) => islandPosition(i, count));
      expect(new Set(positions.map((p) => p.join(','))).size).toBe(count);
      for (let i = 0; i < count; i++)
        for (let j = i + 1; j < count; j++) {
          const a = positions[i]!,
            b = positions[j]!;
          expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(5.5);
        }
    }
  });
});
