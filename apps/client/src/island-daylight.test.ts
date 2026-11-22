import { describe, expect, it } from 'vitest';
import { islandLightAt } from './island-daylight';

function localTime(hours: number, minutes = 0) {
  return new Date(2026, 10, 22, hours, minutes);
}

describe('island daylight', () => {
  it('uses local hours and holds the night palette through midnight', () => {
    expect(islandLightAt('auto', localTime(12))).toMatchObject({ phase: 'day', dusk: 0, night: 0 });
    expect(islandLightAt('auto', localTime(18))).toMatchObject({ phase: 'dusk' });
    const late = islandLightAt('auto', localTime(23, 59));
    expect(late).toMatchObject({ phase: 'night', dusk: 0, night: 1 });
    expect(islandLightAt('auto', localTime(0))).toEqual(late);
  });

  it('honors each fixed mode regardless of the local hour', () => {
    expect(islandLightAt('day', localTime(23))).toEqual(islandLightAt('auto', localTime(12)));
    expect(islandLightAt('night', localTime(12))).toEqual(islandLightAt('auto', localTime(23)));
    expect(islandLightAt('dusk', localTime(12))).toEqual(islandLightAt('auto', localTime(18)));
  });

  it('mirrors the evening transition at dawn', () => {
    expect(islandLightAt('auto', localTime(5, 15))).toEqual(
      islandLightAt('auto', localTime(18, 45)),
    );
    expect(islandLightAt('auto', localTime(6, 45))).toEqual(
      islandLightAt('auto', localTime(17, 15)),
    );
  });

  it('reveals the brightest stars first and the faint field late in twilight', () => {
    const day = islandLightAt('auto', localTime(17));
    const early = islandLightAt('auto', localTime(17, 15));
    const twilight = islandLightAt('auto', localTime(18));
    const evening = islandLightAt('auto', localTime(18, 45));
    expect(early.stars.bright).toBeGreaterThan(day.stars.bright);
    expect(early.stars.mid).toBe(day.stars.mid);
    expect(twilight.stars.mid).toBeGreaterThan(early.stars.mid);
    expect(twilight.stars.faint).toBe(day.stars.faint);
    expect(evening.stars.faint).toBeGreaterThan(twilight.stars.faint);
    expect(evening.night).toBeGreaterThan(twilight.night);
    expect(evening.dusk).toBeLessThan(twilight.dusk);
  });
});
