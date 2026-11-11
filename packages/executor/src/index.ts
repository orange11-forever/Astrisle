import * as fs from 'node:fs/promises';
import path from 'node:path';
import type {
  Capability,
  ToolContext,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../../contracts/src/index';
import { guardPath, assertPlainPath, ToolError } from './path-guard';
import { runProcess, redact } from './process';

const MAX_TEXT = 1024 * 1024,
  MAX_OUTPUT = 64 * 1024,
  MAX_ENTRIES = 2000;
const stringSchema = { type: 'string', maxLength: 2048 };
const textSchema = { type: 'string', maxLength: MAX_TEXT };
const bounded = (s: string) =>
  s.length > MAX_OUTPUT ? `${s.slice(0, MAX_OUTPUT)}\n[output truncated]` : s;
function schema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}
const definitions: ToolDefinition[] = [
  {
    name: 'workspace_list',
    description:
      'List regular files/directories in the task work copy or an explicitly granted read root. Bounded; no symlinks.',
    effect: 'read',
    parameters: schema({ path: stringSchema }, []),
  },
  {
    name: 'workspace_read',
    description:
      'Read a UTF-8 text file, up to 1 MiB. Output is bounded. Supply offset/length for excerpts.',
    effect: 'read',
    parameters: schema(
      {
        path: stringSchema,
        offset: { type: 'integer', minimum: 0 },
        length: { type: 'integer', minimum: 1, maximum: MAX_OUTPUT },
      },
      ['path'],
    ),
  },
  {
    name: 'workspace_search',
    description:
      'Find literal text in regular UTF-8 files under an authorized directory; bounded to 2000 entries and 100 matches.',
    effect: 'read',
    parameters: schema(
      { path: stringSchema, query: { type: 'string', minLength: 1, maxLength: 1000 } },
      ['query'],
    ),
  },
  {
    name: 'workspace_write',
    description:
      'Create or replace one UTF-8 file inside the granted task copy. Parents are created. Never writes to original project.',
    effect: 'write',
    parameters: schema({ path: stringSchema, content: textSchema }, ['path', 'content']),
  },
  {
    name: 'workspace_patch',
    description:
      'Replace one exact, uniquely occurring text fragment in a task-copy UTF-8 file; ambiguous matches fail.',
    effect: 'write',
    parameters: schema({ path: stringSchema, search: textSchema, replacement: textSchema }, [
      'path',
      'search',
      'replacement',
    ]),
  },
  {
    name: 'workspace_mkdir',
    description: 'Create a directory inside the granted task copy.',
    effect: 'write',
    parameters: schema({ path: stringSchema }, ['path']),
  },
  {
    name: 'process_run',
    description:
      'Run an explicitly permitted trusted HOST executable (not a security sandbox), shell:false and minimal environment, timeout and output bounds. Use absolute executable paths.',
    effect: 'process',
    parameters: schema(
      {
        command: stringSchema,
        args: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 32768 } },
        cwd: stringSchema,
        timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 },
      },
      ['command'],
    ),
  },
  {
    name: 'web_read',
    description:
      'Read a URL only with network permission and exact hostname authorization; validates every redirect. Bounded response. No search service is implied.',
    effect: 'network',
    parameters: schema({ url: stringSchema }, ['url']),
  },
  {
    name: 'office_inspect',
    description:
      'Inspect DOCX/XLSX/PPTX structure; detects macros, external links and unsupported objects. Read-only. Returns real parsed content.',
    effect: 'read',
    parameters: schema({ source: stringSchema }, ['source']),
  },
  {
    name: 'office_create',
    description:
      'Create a NEW Office file. content: DOCX {paragraphs:string[],tables:string[][][]}; XLSX {sheets:[{name,rows:scalar[][],cells:{A1:value},styles:{A1:{bold,numberFormat,fill}}}]}; PPTX {slides:[{title,body,chart?:{categories:string[],series:[{name,values:number[]}]}}]}. Output never overwrites an existing file.',
    effect: 'write',
    parameters: schema(
      {
        format: { enum: ['docx', 'xlsx', 'pptx'] },
        output: stringSchema,
        content: { type: 'object' },
        inputVersionIds: { type: 'array', items: { type: 'string' } },
      },
      ['format', 'output', 'content'],
    ),
  },
  {
    name: 'office_edit',
    description:
      'Create a new edited Office version, preserving source. changes: DOCX {paragraphs:[{index,text}],cells:[{table,row,column,text}],appendParagraphs:string[]}; XLSX {cells:[{sheet,cell,value,style?}]}; PPTX {texts:[{slide,shape,text}],charts:[{slide,shape,categories,series:[{name,values}]}]}. Rejects unsupported complexity before saving.',
    effect: 'write',
    parameters: schema(
      {
        source: stringSchema,
        output: stringSchema,
        changes: { type: 'object' },
        inputVersionIds: { type: 'array', items: { type: 'string' } },
      },
      ['source', 'output', 'changes'],
    ),
  },
  {
    name: 'office_verify',
    description:
      'Reopen Office file and independently check numeric source cells. checks:[{sheet,range,sum:number,tolerance?:number}]. Does not claim formula recalculation or application rendering.',
    effect: 'read',
    parameters: schema(
      { source: stringSchema, checks: { type: 'array', maxItems: 100, items: { type: 'object' } } },
      ['source'],
    ),
  },
];
function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const value = args[key] ?? fallback;
  if (typeof value !== 'string' || value.length > MAX_TEXT)
    throw new ToolError('INVALID_ARGUMENT', `${key} must be a bounded string`);
  return value;
}
function active(context: ToolContext) {
  if (context.signal.aborted) throw new ToolError('ABORTED', 'Operation cancelled');
}
async function readText(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_TEXT)
    throw new ToolError('SIZE_LIMIT', 'Text read requires a regular file no larger than 1 MiB');
  const data = await fs.readFile(file);
  if (data.includes(0))
    throw new ToolError('BINARY_FILE', 'Binary data requires an artifact preview or Office tool');
  return data.toString('utf8');
}
function numeric(value: unknown, fallback: number, max: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new ToolError('INVALID_ARGUMENT', 'Numeric argument outside supported range');
  return Number(value);
}
async function webRead(url: string, context: ToolContext): Promise<ToolResult> {
  if (!context.scope.allowNetwork)
    throw new ToolError('SCOPE_DENIED', 'Network permission is required');
  const timeout = AbortSignal.timeout(15000),
    signal = AbortSignal.any([timeout, context.signal]);
  let current = new URL(url);
  for (let count = 0; count <= 5; count++) {
    if (
      !['https:', 'http:'].includes(current.protocol) ||
      current.username ||
      current.password ||
      !context.scope.allowedHosts.some(
        (host) => host.toLowerCase() === current.hostname.toLowerCase(),
      )
    )
      throw new ToolError('SCOPE_DENIED', 'URL host or protocol is not authorized');
    const response = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { accept: 'text/plain,text/html,application/json' },
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) throw new ToolError('NETWORK_FAILED', 'Redirect has no destination');
      current = new URL(location, current);
      continue;
    }
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > MAX_TEXT) {
            await reader.cancel();
            throw new ToolError('SIZE_LIMIT', 'Web response exceeds 1 MiB');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    return {
      ok: response.ok,
      output: bounded(redact(Buffer.concat(chunks).toString('utf8'))),
      metadata: { url: current.toString(), status: response.status },
    };
  }
  throw new ToolError('NETWORK_FAILED', 'Redirect limit exceeded');
}

export function createExecutor(options: {
  projectRoot: string;
  pythonPath?: string;
}): ToolExecutor {
  const python =
    options.pythonPath ||
    path.join(
      options.projectRoot,
      '.venv',
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
    );
  return {
    definitions: () => structuredClone(definitions),
    async capabilities(): Promise<Capability[]> {
      let office = false;
      try {
        await fs.access(python);
        await fs.access(path.join(options.projectRoot, 'workers/office/worker.py'));
        office = true;
      } catch {
        /* accurate unavailable report */
      }
      return [
        {
          id: 'workspace',
          name: 'Scoped file tools',
          available: true,
          detail:
            'Managed task copies; rejects parent traversal, symlinks and junctions. Trusted host, not hostile-process isolation.',
        },
        {
          id: 'process',
          name: 'Trusted host execution',
          available: true,
          detail:
            'Requires explicit allowProcess. No OS sandbox; minimal environment, bounded logs, best-effort tree stop with unknown retained when unconfirmed.',
        },
        {
          id: 'office',
          name: 'Office worker',
          available: office,
          detail: office
            ? 'Project-local Python; DOCX/XLSX/PPTX structural reread and independent numeric checks. Application rendering is a separate verification level.'
            : 'Project-local Python or Office worker is missing.',
        },
        {
          id: 'safe_apply',
          name: 'Original-project writeback',
          available: false,
          detail:
            'Locked Windows writeback not verified; independent new-directory export is available.',
        },
      ];
    },
    async execute(name, args, context): Promise<ToolResult> {
      try {
        active(context);
        const definition = definitions.find((d) => d.name === name);
        if (!definition) throw new ToolError('UNKNOWN_TOOL', 'Unknown tool');
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Buffer.byteLength(JSON.stringify(args)) > 2 * MAX_TEXT
        )
          throw new ToolError('INVALID_ARGUMENT', 'Tool arguments exceed size limit');
        for (const key of definition.parameters.required as string[])
          if (args[key] === undefined)
            throw new ToolError('INVALID_ARGUMENT', `Missing required argument: ${key}`);
        const properties = definition.parameters.properties as Record<string, unknown>;
        for (const key of Object.keys(args))
          if (!(key in properties))
            throw new ToolError('INVALID_ARGUMENT', `Unknown argument: ${key}`);
        if (name === 'web_read') return await webRead(str(args, 'url'), context);
        if (name === 'process_run') {
          if (!context.scope.allowProcess)
            throw new ToolError(
              'SCOPE_DENIED',
              'Explicit trusted host process permission is required',
            );
          const cwd = await guardPath(str(args, 'cwd', '.'), context, true);
          await assertPlainPath(cwd, true);
          active(context);
          if (
            args.args !== undefined &&
            (!Array.isArray(args.args) || args.args.some((v) => typeof v !== 'string'))
          )
            throw new ToolError('INVALID_ARGUMENT', 'args must be a string array');
          const result = await runProcess(str(args, 'command'), (args.args || []) as string[], {
            cwd,
            signal: context.signal,
            timeoutMs: Math.max(100, numeric(args.timeoutMs, 30000, 120000)),
          });
          return {
            ok: result.exitCode === 0 && !result.reason,
            output: bounded(result.output),
            code: result.reason
              ? result.stopStatus === 'outcome_unknown'
                ? 'OUTCOME_UNKNOWN'
                : result.reason.toUpperCase()
              : undefined,
            metadata: { ...result, output: undefined, mode: 'trusted_host', cwd },
          };
        }
        if (name.startsWith('office_')) {
          const operation = name.slice(7),
            request: Record<string, unknown> = { ...args, operation, schemaVersion: 1 };
          if (args.source !== undefined)
            request.source = await guardPath(str(args, 'source'), context, false);
          if (operation === 'create' || operation === 'edit') {
            request.output = await guardPath(str(args, 'output'), context, true);
            await fs.mkdir(path.dirname(request.output as string), { recursive: true });
            await assertPlainPath(request.output as string, true);
          }
          active(context);
          const result = await runProcess(
            python,
            [path.join(options.projectRoot, 'workers/office/worker.py')],
            {
              cwd: context.workPath,
              signal: context.signal,
              timeoutMs: 60000,
              input: JSON.stringify(request),
              outputLimit: 1024 * 1024,
            },
          );
          if (result.reason)
            return {
              ok: false,
              output: 'Office worker stopped; reconcile output before retry.',
              code: result.stopStatus === 'outcome_unknown' ? 'OUTCOME_UNKNOWN' : 'ABORTED',
              metadata: { stopStatus: result.stopStatus },
            };
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(result.output);
          } catch {
            throw new ToolError(
              'WORKER_FAILED',
              `Invalid Office worker response: ${bounded(result.output)}`,
            );
          }
          return {
            ok: parsed.ok === true,
            output: bounded(redact(JSON.stringify(parsed))),
            files:
              parsed.ok && (operation === 'create' || operation === 'edit')
                ? [request.output as string]
                : [],
            code: typeof parsed.code === 'string' ? parsed.code : undefined,
            metadata: parsed,
          };
        }
        const writing = definition.effect === 'write',
          file = await guardPath(str(args, 'path', '.'), context, writing);
        active(context);
        if (name === 'workspace_list') {
          const entries = await fs.readdir(file, { withFileTypes: true });
          if (entries.length > MAX_ENTRIES)
            throw new ToolError('SIZE_LIMIT', 'Directory has too many entries');
          const items = [];
          for (const e of entries) {
            active(context);
            await guardPath(path.join(file, e.name), context, false);
            items.push({
              name: e.name,
              type: e.isDirectory() ? 'directory' : e.isFile() ? 'file' : 'unsupported',
            });
          }
          return { ok: true, output: bounded(JSON.stringify(items)) };
        }
        if (name === 'workspace_read')
          return {
            ok: true,
            output: redact(
              (await readText(file)).slice(
                numeric(args.offset, 0, MAX_TEXT),
                numeric(args.offset, 0, MAX_TEXT) + numeric(args.length, MAX_OUTPUT, MAX_OUTPUT),
              ),
            ),
          };
        if (name === 'workspace_mkdir') {
          await guardPath(file, context, true);
          active(context);
          await fs.mkdir(file, { recursive: true });
          return { ok: true, output: 'Directory created' };
        }
        if (name === 'workspace_write' || name === 'workspace_patch') {
          let content = str(args, 'content', '');
          if (name === 'workspace_patch') {
            const previous = await readText(file),
              search = str(args, 'search');
            if (!search || previous.split(search).length !== 2)
              throw new ToolError('PATCH_CONFLICT', 'Patch search must match exactly once');
            content = previous.replace(search, () => str(args, 'replacement'));
          }
          if (Buffer.byteLength(content) > MAX_TEXT)
            throw new ToolError('SIZE_LIMIT', 'Text write exceeds 1 MiB');
          await fs.mkdir(path.dirname(file), { recursive: true });
          await guardPath(file, context, true);
          active(context);
          await fs.writeFile(file, content, 'utf8');
          return { ok: true, output: 'File written', files: [file] };
        }
        if (name === 'workspace_search') {
          const query = str(args, 'query');
          if (!query || query.length > 1000)
            throw new ToolError('INVALID_ARGUMENT', 'Search query must be 1–1000 characters');
          const matches: { path: string; line: number; text: string }[] = [];
          let count = 0;
          async function visit(directory: string): Promise<void> {
            for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
              active(context);
              if (++count > MAX_ENTRIES || matches.length >= 100) return;
              if (['.git', 'node_modules', '.venv', '__pycache__'].includes(entry.name)) continue;
              const child = await guardPath(path.join(directory, entry.name), context, false);
              if (entry.isDirectory()) await visit(child);
              else if (entry.isFile()) {
                const st = await fs.stat(child);
                if (st.size > MAX_TEXT) continue;
                const data = await fs.readFile(child);
                if (data.includes(0)) continue;
                for (const [line, value] of data.toString('utf8').split('\n').entries())
                  if (value.includes(query) && matches.length < 100)
                    matches.push({
                      path: path.relative(file, child).split(path.sep).join('/'),
                      line: line + 1,
                      text: value.slice(0, 1000),
                    });
              }
            }
          }
          await visit(file);
          return {
            ok: true,
            output: bounded(redact(JSON.stringify(matches))),
            metadata: {
              scannedEntries: count,
              truncated: count > MAX_ENTRIES || matches.length >= 100,
            },
          };
        }
        throw new ToolError('UNKNOWN_TOOL', 'Unknown tool');
      } catch (e) {
        return {
          ok: false,
          code: context.signal.aborted
            ? 'ABORTED'
            : e instanceof ToolError
              ? e.code
              : 'TOOL_FAILED',
          output: bounded(redact(e instanceof Error ? e.message : String(e))),
        };
      }
    },
  };
}
