import { describe, expect, it } from 'vitest';
import { islandAppearance, islandPosition, islandSeed, parseIslandThemeOverrides } from './islands';
describe('persistent island identity', () => {
  it('keeps palette and decoration stable across snapshot rebuilds', () => {
    expect(islandAppearance('workspace-1')).toEqual(islandAppearance('workspace-1'));
    expect(islandSeed('workspace-1')).not.toBe(islandSeed('workspace-2'));
  });
  it('changes the chosen palette while keeping the workspace decoration seed and rotation', () => {
    const wisteria = islandAppearance('workspace-1', 'wisteria');
    const rose = islandAppearance('workspace-1', 'rose');
    expect([wisteria.name, rose.name]).toEqual(['紫藤雾', '蔷薇湾']);
    expect(wisteria.flower).not.toBe(rose.flower);
    expect(wisteria.seed).toBe(rose.seed);
    expect(wisteria.rotation).toBe(rose.rotation);
  });
  it('restores each known theme override and ignores unusable preferences', () => {
    expect(
      parseIslandThemeOverrides('{"coast":"rose","study":"apricot","garden":"removed"}'),
    ).toEqual(
      new Map([
        ['coast', 'rose'],
        ['study', 'apricot'],
      ]),
    );
    for (const invalid of [null, '{invalid', 'null', '["rose"]', '"rose"']) {
      expect(parseIslandThemeOverrides(invalid)).toEqual(new Map());
    }
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
