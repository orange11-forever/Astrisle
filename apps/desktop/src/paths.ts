import { join } from 'node:path';

export interface DesktopResourcePaths {
  supervisorPath: string;
  safeApplyPath: string;
  pythonPath: string;
  officeWorkerPath: string;
}

export function resolveDesktopPaths(options: {
  projectRoot: string;
  resourcesPath?: string;
  packaged: boolean;
  platform?: NodeJS.Platform;
}): DesktopResourcePaths {
  const platform = options.platform ?? process.platform;
  if (!options.packaged) {
    return {
      supervisorPath: join(options.projectRoot, 'dist/helpers/process-supervisor.exe'),
      safeApplyPath: join(options.projectRoot, 'dist/helpers/safe-apply.exe'),
      pythonPath: join(
        options.projectRoot,
        '.venv',
        platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
      ),
      officeWorkerPath: join(options.projectRoot, 'workers/office/worker.py'),
    };
  }
  const resourcesPath = options.resourcesPath?.trim();
  if (!resourcesPath) {
    throw new Error('Packaged desktop runtime requires process.resourcesPath');
  }
  return {
    supervisorPath: join(resourcesPath, 'helpers/process-supervisor.exe'),
    safeApplyPath: join(resourcesPath, 'helpers/safe-apply.exe'),
    pythonPath: join(
      resourcesPath,
      'office-python',
      platform === 'win32' ? 'python.exe' : 'bin/python',
    ),
    officeWorkerPath: join(resourcesPath, 'workers/office/worker.py'),
  };
}
