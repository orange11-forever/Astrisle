import { useEffect, useId, useState } from 'react';
import {
  GITHUB_SKILL_MIN_STARS,
  PARTNER_SKILL_MAX_CONTENT_BYTES,
  PARTNER_SKILL_MAX_DESCRIPTION_LENGTH,
  PARTNER_SKILL_MAX_INSTRUCTIONS,
  PARTNER_SKILL_MAX_NAME_LENGTH,
  validatePartnerSkillSettings,
} from '@astrisle/contracts';
import type { PartnerSkillInstruction, PartnerSkillSettings } from '@astrisle/contracts';

const emptySettings: PartnerSkillSettings = {
  instructions: [],
  autoDiscover: false,
  discoveryScope: 'public',
  repositories: [],
};

export function PartnerSkills({
  saved,
  busy,
  onSave,
}: {
  saved?: PartnerSkillSettings;
  busy: boolean;
  onSave: (settings: PartnerSkillSettings) => Promise<unknown>;
}) {
  const id = useId();
  const initial = saved ?? emptySettings;
  const settings = JSON.stringify(initial);
  const [instructions, setInstructions] = useState(initial.instructions);
  const [autoDiscover, setAutoDiscover] = useState(initial.autoDiscover);
  const [discoveryScope, setDiscoveryScope] = useState(initial.discoveryScope ?? 'selected');
  const [repositories, setRepositories] = useState(initial.repositories.join('\n'));
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  useEffect(() => {
    const stored = JSON.parse(settings) as PartnerSkillSettings;
    setInstructions(stored.instructions);
    setAutoDiscover(stored.autoDiscover);
    setDiscoveryScope(stored.discoveryScope ?? 'selected');
    setRepositories(stored.repositories.join('\n'));
  }, [settings]);

  const atCapacity = instructions.length >= PARTNER_SKILL_MAX_INSTRUCTIONS;
  const disabled = busy || importing;
  const showRepositories = autoDiscover && discoveryScope === 'selected';
  const editInstruction = (index: number, patch: Partial<PartnerSkillInstruction>) =>
    setInstructions((current) =>
      current.map((instruction, position) =>
        index === position ? { ...instruction, ...patch } : instruction,
      ),
    );

  async function importMarkdown(file: File) {
    setError('');
    setImporting(true);
    try {
      if (file.name.toLowerCase() !== 'skill.md' || file.size > PARTNER_SKILL_MAX_CONTENT_BYTES)
        throw new Error('请选择 48 KiB 以内的 SKILL.md 文件。');
      let content: string;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        throw new Error('技能文件须使用 UTF-8 编码。');
      }
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      const name = header
        ?.match(/^name:[ \t]*(.+)$/m)?.[1]
        .trim()
        .replace(/^("|')(.*)\1$/, '$2');
      const imported = validatePartnerSkillSettings({
        ...emptySettings,
        instructions: [{ name: name || '新技能', content }],
      });
      setInstructions((current) => [...current, ...imported.instructions]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  }

  return (
    <details className="partner-skills">
      <summary>伙伴技能</summary>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (disabled) return;
          setError('');
          let next: PartnerSkillSettings;
          try {
            next = validatePartnerSkillSettings({
              instructions,
              autoDiscover,
              discoveryScope,
              repositories: showRepositories
                ? repositories
                    .split(/\r?\n/)
                    .map((line) => line.trim())
                    .filter(Boolean)
                : initial.repositories,
            });
          } catch (reason) {
            setError(reason instanceof Error ? reason.message : String(reason));
            return;
          }
          void onSave(next);
        }}
      >
        <p className="field-hint">保存后，新委托会使用这位伙伴的技能设置。</p>
        {instructions.map(({ name, description, content }, index) => (
          <div className="partner-skill-instruction" key={index}>
            <label htmlFor={`${id}-name-${index}`}>技能名称</label>
            <input
              id={`${id}-name-${index}`}
              required
              disabled={disabled}
              maxLength={PARTNER_SKILL_MAX_NAME_LENGTH}
              value={name}
              onChange={(event) => editInstruction(index, { name: event.target.value })}
            />
            <label htmlFor={`${id}-description-${index}`}>技能简介（可选）</label>
            <input
              id={`${id}-description-${index}`}
              disabled={disabled}
              maxLength={PARTNER_SKILL_MAX_DESCRIPTION_LENGTH}
              value={description ?? ''}
              onChange={(event) => editInstruction(index, { description: event.target.value })}
            />
            <label htmlFor={`${id}-content-${index}`}>技能正文</label>
            <textarea
              id={`${id}-content-${index}`}
              rows={5}
              required
              disabled={disabled}
              maxLength={PARTNER_SKILL_MAX_CONTENT_BYTES}
              value={content}
              onChange={(event) => editInstruction(index, { content: event.target.value })}
            />
            <button
              type="button"
              className="text-button"
              disabled={disabled}
              aria-label={name ? `移除技能 ${name}` : '移除空白技能'}
              onClick={() =>
                setInstructions((current) => current.filter((_, position) => position !== index))
              }
            >
              移除技能
            </button>
          </div>
        ))}
        <div className="button-row">
          <button
            type="button"
            disabled={disabled || atCapacity}
            onClick={() => setInstructions((current) => [...current, { name: '', content: '' }])}
          >
            添加技能
          </button>
        </div>
        <label htmlFor={`${id}-markdown`}>导入 SKILL.md</label>
        <input
          id={`${id}-markdown`}
          type="file"
          accept=".md,text/markdown,text/plain"
          disabled={disabled || atCapacity}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file) void importMarkdown(file);
          }}
        />
        <label className="check-label">
          <input
            type="checkbox"
            checked={autoDiscover}
            disabled={disabled}
            onChange={(event) => {
              setAutoDiscover(event.target.checked);
              setError('');
            }}
          />
          自动从 GitHub 发现技能
        </label>
        {autoDiscover && (
          <>
            <label htmlFor={`${id}-discovery-scope`}>GitHub 技能查找范围</label>
            <select
              id={`${id}-discovery-scope`}
              disabled={disabled}
              value={discoveryScope}
              onChange={(event) => {
                setDiscoveryScope(event.target.value === 'selected' ? 'selected' : 'public');
                setError('');
              }}
            >
              <option value="public">GitHub 热门公共技能仓库</option>
              <option value="selected">仅查找指定的热门公共仓库</option>
            </select>
            {showRepositories ? (
              <>
                <label htmlFor={`${id}-repositories`}>允许查找的 GitHub 仓库</label>
                <textarea
                  id={`${id}-repositories`}
                  rows={2}
                  disabled={disabled}
                  value={repositories}
                  placeholder="openai/skills"
                  onChange={(event) => setRepositories(event.target.value)}
                />
                <div className="button-row">
                  {['anthropics/skills', 'openai/skills'].map((repo) => (
                    <button
                      type="button"
                      key={repo}
                      disabled={
                        disabled ||
                        repositories
                          .split(/\r?\n/)
                          .some((line) => line.trim().toLowerCase() === repo)
                      }
                      onClick={() =>
                        setRepositories((current) =>
                          [current.trim(), repo].filter(Boolean).join('\n'),
                        )
                      }
                    >
                      添加 {repo}
                    </button>
                  ))}
                </div>
                <p className="field-hint">每行填写一个仓库（owner/repo）。</p>
              </>
            ) : (
              <p className="field-hint">全站查找会向 GitHub 发送预设的公开技术关键词。</p>
            )}
            <p className="field-hint">
              自动发现要求委托授权 api.github.com，只使用未归档且至少 {GITHUB_SKILL_MIN_STARS}{' '}
              星的公共仓库。 下载的 SKILL.md 作为任务参考，执行仍以委托授权为限。
            </p>
            <p className="field-hint">
              使用下载的指南后，该任务仍可编写成果并读取已固定的原文。需要运行命令的工作可另行分配。
            </p>
          </>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="button-row">
          <button type="submit" disabled={disabled}>
            保存伙伴技能
          </button>
        </div>
      </form>
    </details>
  );
}
