import { _electron as electron } from '@playwright/test';
import { resolve } from 'node:path';

export function launchIsolatedElectron(
  dataRoot: string,
  windowProbe?: 'automation' | 'studio' | 'demo',
) {
  return electron.launch({
    args: [resolve(windowProbe ? 'tests/fixtures/electron-window-probe.cjs' : '.')],
    env: {
      ...process.env,
      ASTRISLE_AUTOMATION: '1',
      ASTRISLE_MODEL_DEMO: '',
      ASTRISLE_DATA_ROOT: dataRoot,
      ASTRISLE_DEV_URL: '',
      ASTRISLE_WINDOW_PROBE: windowProbe ?? '',
    },
    timeout: 30_000,
  });
}
