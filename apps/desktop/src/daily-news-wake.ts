import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

interface WindowsNewsTask {
  dataRoot: string;
  workspaceId: string;
  time: string | null;
  executable: string;
  projectRoot: string;
  packaged: boolean;
}

export function dailyNewsTaskName(dataRoot: string, workspaceId: string) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        userInfo().username.toLowerCase(),
        resolve(dataRoot).toLowerCase(),
        workspaceId,
      ]),
    )
    .digest('hex');
  return 'Astrisle-DailyNews-' + digest.slice(0, 32);
}

// Task Scheduler starts the executable directly. Quote for Windows argv parsing, not for a shell.
function quoteArgument(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

export function dailyNewsWakeArgv(
  options: Pick<WindowsNewsTask, 'projectRoot' | 'packaged' | 'dataRoot' | 'workspaceId'>,
): string[] {
  const args = options.packaged ? [] : [options.projectRoot];
  args.push(
    '--daily-news-background',
    '--daily-news-root=' + resolve(options.dataRoot),
    '--daily-news-island=' + options.workspaceId,
  );
  return args;
}

export function dailyNewsWakeArguments(options: WindowsNewsTask): string {
  return dailyNewsWakeArgv(options).map(quoteArgument).join(' ');
}

/** A scheduled secondary exits when the desktop already owns the Electron instance lock. */
export class DailyNewsWakeHandoff {
  private island?: string;
  private relaunched = false;
  constructor(private relaunch: (island: string) => void) {}
  received(island: string, closing: boolean) {
    this.island = island;
    if (closing) this.continueAfterExit();
  }
  private continueAfterExit() {
    if (!this.island || this.relaunched) return;
    this.relaunch(this.island);
    this.relaunched = true;
  }
  async beforeExit(pending: () => Promise<boolean>) {
    if (this.island && !this.relaunched && (await pending().catch(() => true)))
      this.continueAfterExit();
  }
}

// Data is passed on stdin, including installation paths and the chosen HH:mm.
// The scheduled action contains no credentials and runs as the signed-in user.
const taskScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
$p = [Console]::In.ReadToEnd() | ConvertFrom-Json
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\')
$existing = $null
try { $existing = $folder.GetTask($p.name) }
catch {
  if ($_.Exception.GetBaseException().HResult -notin @(-2147024894,-2147024893)) { throw }
}
$owner = 'Astrisle/DailyNews/v1'
if ($existing -and $existing.Definition.RegistrationInfo.Source -ne $owner) {
  throw 'The task name is already in use.'
}
if (!$p.time) {
  if ($existing) { $folder.DeleteTask($p.name, 0) }
  exit 0
}
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($existing -and $existing.Enabled) {
  $old = $existing.Definition
  if ($old.Actions.Count -eq 1 -and $old.Triggers.Count -eq 2 -and
    $old.Actions.Item(1).Path -eq $p.exe -and $old.Actions.Item(1).Arguments -ceq $p.args -and
    $old.Actions.Item(1).WorkingDirectory -eq $p.cwd -and
    $old.Triggers.Item(1).StartBoundary -match ('T' + [Regex]::Escape($p.time) + ':00$')) { exit 0 }
}
$task = $service.NewTask(0)
$task.RegistrationInfo.Source = $owner
$task.RegistrationInfo.Description = 'Collect the subscribed Astrisle island newspaper.'
$task.Principal.UserId = $user
$task.Principal.LogonType = 3
$task.Principal.RunLevel = 0
$task.Settings.StartWhenAvailable = $true
$task.Settings.DisallowStartIfOnBatteries = $false
$task.Settings.StopIfGoingOnBatteries = $false
$task.Settings.MultipleInstances = 2
$task.Settings.WakeToRun = $true
$task.Settings.ExecutionTimeLimit = 'PT0S'
$daily = $task.Triggers.Create(2)
$daily.DaysInterval = 1
$daily.StartBoundary = (Get-Date).ToString('yyyy-MM-dd') + 'T' + $p.time + ':00'
$login = $task.Triggers.Create(9)
$login.UserId = $user
$login.Delay = 'PT15S'
$action = $task.Actions.Create(0)
$action.Path = $p.exe
$action.Arguments = $p.args
$action.WorkingDirectory = $p.cwd
$null = $folder.RegisterTaskDefinition($p.name, $task, 6, $user, $null, 3)
`;

export async function syncDailyNewsTask(options: WindowsNewsTask): Promise<void> {
  if (process.platform !== 'win32')
    throw new Error('完全退出后的定时投递需要 Windows 任务计划程序。');
  if (options.time !== null && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(options.time))
    throw new Error('无效的日报投递时间。');
  const name = dailyNewsTaskName(options.dataRoot, options.workspaceId);
  const powershell = join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const payload = {
    name,
    time: options.time,
    exe: options.executable,
    args: dailyNewsWakeArguments(options),
    cwd: options.packaged ? dirname(options.executable) : options.projectRoot,
  };
  await new Promise<void>((accept, reject) => {
    const child = execFile(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(taskScript, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, timeout: 30_000 },
      (err) => {
        if (err)
          reject(
            new Error('Windows 任务计划程序未能保存日报计划，请检查服务状态和当前账户权限后重试。'),
          );
        else accept();
      },
    );
    child.stdin?.on('error', () => {
      /* execFile reports a child that could not start. */
    });
    child.stdin?.end(JSON.stringify(payload), 'utf8');
  });
}
