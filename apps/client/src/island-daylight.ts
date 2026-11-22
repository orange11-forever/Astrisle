export type IslandLightMode = 'auto' | 'day' | 'dusk' | 'night';

export type IslandLight = {
  phase: Exclude<IslandLightMode, 'auto'>;
  dusk: number;
  night: number;
  stars: { bright: number; mid: number; faint: number };
};

const dawn = 5 * 60;
const sunrise = 7 * 60;
const sunset = 17 * 60;
const nightfall = 19 * 60;

function smoothstep(value: number, start: number, end: number) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)));
  return t * t * (3 - 2 * t);
}

function lightAtProgress(progress: number): IslandLight {
  const night = smoothstep(progress, 0.5, 1);
  return {
    phase: progress === 0 ? 'day' : progress === 1 ? 'night' : 'dusk',
    dusk: smoothstep(progress, 0, 0.5) * (1 - night),
    night,
    stars: {
      bright: 0.44 + 0.56 * smoothstep(progress, 0, 0.72),
      mid: 0.25 + 0.75 * smoothstep(progress, 0.24, 0.9),
      faint: 0.13 + 0.87 * smoothstep(progress, 0.56, 1),
    },
  };
}

export const dayIslandLight = lightAtProgress(0);
const duskIslandLight = lightAtProgress(0.5);
const nightIslandLight = lightAtProgress(1);

export function islandLightAt(mode: IslandLightMode, date: Date): IslandLight {
  if (mode === 'day') return dayIslandLight;
  if (mode === 'dusk') return duskIslandLight;
  if (mode === 'night') return nightIslandLight;

  const minute = date.getHours() * 60 + date.getMinutes();
  if (minute <= dawn || minute >= nightfall) return nightIslandLight;
  if (minute >= sunrise && minute <= sunset) return dayIslandLight;
  return lightAtProgress(
    minute < sunrise
      ? (sunrise - minute) / (sunrise - dawn)
      : (minute - sunset) / (nightfall - sunset),
  );
}
