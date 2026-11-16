import { inspectCharacterImport } from '../../client/src/characters/model-cache';
import type { CharacterImportInspection } from '@astrisle/contracts';

const bridge = (
  window as unknown as {
    astrisleCharacterValidation: {
      read(): Promise<Uint8Array>;
      report(result: { inspection: CharacterImportInspection } | { error: string }): Promise<void>;
    };
  }
).astrisleCharacterValidation;

void (async () => {
  let result: { inspection: CharacterImportInspection } | { error: string };
  try {
    result = { inspection: await inspectCharacterImport(await bridge.read()) };
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  await bridge.report(result);
})();
