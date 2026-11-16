/** Private, self-contained transport. These bytes are never published as project assets. */
export interface CharacterAssetBundle {
  astrisleCharacterAsset: 1;
  format: '3mf' | 'stl' | 'obj' | 'fbx';
  entry: string;
  files: Record<string, string>;
}
export const MAX_CHARACTER_SOURCE_BYTES = 100 * 1024 * 1024;
export const MAX_CHARACTER_STORED_BYTES = Math.ceil(MAX_CHARACTER_SOURCE_BYTES * 1.34) + 65536;

/** Use the same resource vocabulary on both sides of the desktop boundary. */
export function characterResourcePath(raw: string): string {
  let path: string;
  try {
    path = decodeURIComponent(raw).replace(/\\/g, '/');
  } catch {
    throw new Error(`模型资源路径无效：${raw}`);
  }
  if (
    !path ||
    /[\u0000-\u001f\u007f:#?%]/.test(path) ||
    path.startsWith('/') ||
    path.split('/').some((part) => part === '..' || !part)
  )
    throw new Error(`模型资源路径必须在所选模型文件夹内：${raw}`);
  return path
    .split('/')
    .filter((part) => part !== '.')
    .join('/');
}
