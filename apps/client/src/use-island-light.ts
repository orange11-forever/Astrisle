import { useEffect, useState } from 'react';
import { islandLightAt, type IslandLightMode } from './island-daylight';

export function useIslandLight(mode: IslandLightMode, active: boolean) {
  const [automatic, setAutomatic] = useState(() => islandLightAt('auto', new Date()));
  useEffect(() => {
    if (mode !== 'auto' || !active) return;
    const update = () => setAutomatic(islandLightAt('auto', new Date()));
    update();
    const timer = window.setInterval(update, 60_000);
    return () => window.clearInterval(timer);
  }, [mode, active]);
  return mode === 'auto' ? automatic : islandLightAt(mode, new Date());
}
