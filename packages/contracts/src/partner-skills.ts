import { z } from 'zod';

export interface PartnerSkillInstruction {
  name: string;
  description?: string;
  content: string;
}

export interface PartnerSkillSettings {
  instructions: PartnerSkillInstruction[];
  autoDiscover: boolean;
  /** Earlier saved settings use the explicitly selected repositories. */
  discoveryScope?: 'selected' | 'public';
  repositories: string[];
}

export const PARTNER_SKILL_MAX_CONTENT_BYTES = 48 * 1024;
export const PARTNER_SKILL_MAX_TOTAL_CONTENT_BYTES = 72 * 1024;
export const PARTNER_SKILL_MAX_INSTRUCTIONS = 6;
export const PARTNER_SKILL_MAX_REPOSITORIES = 6;
export const PARTNER_SKILL_MAX_NAME_LENGTH = 64;
export const PARTNER_SKILL_MAX_DESCRIPTION_LENGTH = 240;
export const GITHUB_SKILL_MIN_STARS = 100;

export function isPartnerSkillRepository(value: unknown): value is string {
  if (typeof value !== 'string' || /\s/.test(value)) return false;
  const match = /^([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})$/i.exec(value);
  return !!match && !match[1].includes('--') && match[2] !== '.' && match[2] !== '..';
}

const encoder = new TextEncoder();
const isSingleLineText = (text: string) => !/[\p{Cc}\p{Cf}]/u.test(text);
const instructionSchema = z.strictObject(
  {
    name: z
      .string()
      .trim()
      .min(1, '请输入技能名称。')
      .max(PARTNER_SKILL_MAX_NAME_LENGTH, '技能名称最多 64 个字符。')
      .refine(isSingleLineText, '技能名称须是单行文本。'),
    description: z
      .string()
      .trim()
      .max(PARTNER_SKILL_MAX_DESCRIPTION_LENGTH, '技能简介最多 240 个字符。')
      .refine(isSingleLineText, '技能简介须是单行文本。')
      .optional(),
    content: z
      .string()
      .refine(
        (text) =>
          text.length <= PARTNER_SKILL_MAX_CONTENT_BYTES &&
          encoder.encode(text).byteLength <= PARTNER_SKILL_MAX_CONTENT_BYTES &&
          !!text.trim() &&
          !/[^\P{Cc}\t\r\n]/u.test(text),
        '技能正文须为非空文本，且不能超过 48 KiB。',
      ),
  },
  '技能仅支持名称、简介和正文。',
);

export const partnerSkillSettingsSchema = z
  .strictObject({
    instructions: z
      .array(instructionSchema)
      .max(PARTNER_SKILL_MAX_INSTRUCTIONS, '每位伙伴最多可设置 6 个技能。'),
    autoDiscover: z.boolean(),
    discoveryScope: z.enum(['selected', 'public'], 'GitHub 技能查找范围无效。').optional(),
    repositories: z
      .array(z.string().refine(isPartnerSkillRepository, 'GitHub 仓库请填写 owner/repo。'))
      .max(PARTNER_SKILL_MAX_REPOSITORIES, '每位伙伴最多可配置 6 个 GitHub 仓库。'),
  })
  .refine(
    ({ instructions }) =>
      instructions.reduce((size, { content }) => {
        if (size > PARTNER_SKILL_MAX_TOTAL_CONTENT_BYTES) return size;
        return (
          size +
          (content.length > PARTNER_SKILL_MAX_CONTENT_BYTES
            ? content.length
            : encoder.encode(content).byteLength)
        );
      }, 0) <= PARTNER_SKILL_MAX_TOTAL_CONTENT_BYTES,
    '所有技能正文合计不能超过 72 KiB。',
  )
  .refine(
    ({ autoDiscover, discoveryScope, repositories }) =>
      !autoDiscover || discoveryScope === 'public' || repositories.length > 0,
    '指定仓库模式需要至少一个 GitHub 仓库。',
  )
  .refine(
    ({ repositories }) =>
      new Set(repositories.map((repository) => repository.toLowerCase())).size ===
      repositories.length,
    'GitHub 仓库不能重复。',
  );

export function validatePartnerSkillSettings(value: unknown): PartnerSkillSettings {
  const result = partnerSkillSettingsSchema.safeParse(value);
  if (!result.success) throw new TypeError(result.error.issues[0]?.message ?? '伙伴技能设置无效。');
  return result.data;
}
