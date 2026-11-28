import { createRuntime, type RuntimeService } from '../../../packages/runtime/src/index';
import { createExecutor } from '../../../packages/executor/src/index';
import type { ProviderInput, ProjectSnapshot } from '@astrisle/contracts';
import { join } from 'node:path';
import type { DesktopResourcePaths } from './paths';

type ParentPort = {
  on(name: 'message', listener: (event: { data: RpcRequest }) => void): void;
  postMessage(message: unknown): void;
};
type RpcRequest = { id: string; method: string; args: unknown[] };
const port = (process as NodeJS.Process & { parentPort?: ParentPort }).parentPort;
if (!port) throw new Error('Astrisle Runtime must be launched by its desktop supervisor');
let service: RuntimeService | undefined;
let credentials: (ProviderInput & { apiKey: string }) | null = null;
const permitted = new Set([
  'bootstrap',
  'getDailyNewsMailbox',
  'getDailyNewsIssue',
  'setDailyNewsSettings',
  'retryDailyNews',
  'resumeDailyNews',
  'getDailyNewsWakeState',
  'ackDailyNewsTaskCleanup',
  'createWorkspace',
  'submit',
  'snapshot',
  'askPartner',
  'control',
  'updateBudget',
  'answer',
  'revise',
  'accept',
  'artifact',
  'compareArtifacts',
  'requestArtifactRework',
  'exportSourceArtifact',
  'resolveArtifactPath',
  'exportWorkspace',
  'prepareApply',
  'prepareGitDelivery',
  'latestGitDelivery',
  'publishGitDelivery',
  'inspectGitDelivery',
  'matchesPublishedGitHead',
  'apply',
  'inspectApply',
  'prepareRollback',
  'resolveApplyDirectory',
  'testProvider',
  'close',
]);

port.on('message', async ({ data: request }) => {
  if (!request || typeof request.id !== 'string' || !Array.isArray(request.args)) return;
  try {
    let value: unknown;
    if (request.method === 'initialize') {
      if (service) throw new Error('Runtime already initialized');
      const input = request.args[0] as {
        dataRoot: string;
        projectRoot: string;
        paths?: DesktopResourcePaths;
        credentials: (ProviderInput & { apiKey: string }) | null;
      };
      credentials = input.credentials;
      const executor = createExecutor({
        projectRoot: input.projectRoot,
        supervisorPath: input.paths?.supervisorPath,
        safeApplyPath: input.paths?.safeApplyPath,
        pythonPath:
          input.paths?.pythonPath ??
          join(
            input.projectRoot,
            '.venv',
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
          ),
        workerPath: input.paths?.officeWorkerPath,
      });
      service = createRuntime({
        dataRoot: input.dataRoot,
        executor,
        getCredentials: async () => credentials,
        applyHelperPath:
          input.paths?.safeApplyPath ?? join(input.projectRoot, 'dist/helpers/safe-apply.exe'),
        ...(process.env.ASTRISLE_AUTOMATION === '1' && process.env.ASTRISLE_TEST_LOCAL_GIT === '1'
          ? { gitDeliveryLocalRemoteRoot: join(input.dataRoot, 'git-remotes') }
          : {}),
      });
      service.subscribe((snapshot: ProjectSnapshot) =>
        port.postMessage({ event: 'snapshot', value: snapshot }),
      );
      value = { ready: true, pid: process.pid };
    } else if (request.method === 'setCredentials') {
      credentials = request.args[0] as (ProviderInput & { apiKey: string }) | null;
      value = true;
    } else {
      if (!service) throw new Error('Runtime has not initialized');
      if (permitted.has(request.method)) {
        const method = service[request.method as keyof RuntimeService] as (
          ...args: unknown[]
        ) => unknown;
        value = await method.apply(service, request.args);
      } else throw new Error('Unknown runtime method');
    }
    port.postMessage({ id: request.id, value });
  } catch (error) {
    let message = error instanceof Error ? error.message : 'Runtime operation failed';
    if (credentials?.apiKey) message = message.replaceAll(credentials.apiKey, '[REDACTED]');
    port.postMessage({ id: request.id, error: message });
  }
});
