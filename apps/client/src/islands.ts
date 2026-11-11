/** Workspace identity is the only seed: decoration survives restart without a second domain store. */
export function islandSeed(id: string): number {
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}
const palettes = [
  {
    name: '海风青',
    grass: '#92aa93',
    leaf: '#537c68',
    lightLeaf: '#83a48a',
    flower: '#ecd9a0',
    water: '#7eb8bc',
    stone: '#899b9f',
    flag: '#527f80',
  },
  {
    name: '紫藤雾',
    grass: '#a2ae9d',
    leaf: '#657c77',
    lightLeaf: '#9aafa0',
    flower: '#b6a7cd',
    water: '#91b9c3',
    stone: '#9096a6',
    flag: '#9586b3',
  },
  {
    name: '杏色晴',
    grass: '#abb38d',
    leaf: '#788565',
    lightLeaf: '#a6af85',
    flower: '#e6b391',
    water: '#87b7af',
    stone: '#a19a8b',
    flag: '#c39373',
  },
  {
    name: '蔷薇湾',
    grass: '#9bb09d',
    leaf: '#5b8175',
    lightLeaf: '#93af9f',
    flower: '#d8a4b0',
    water: '#89b3c1',
    stone: '#909fa2',
    flag: '#b18598',
  },
] as const;
export function islandAppearance(id: string) {
  const seed = islandSeed(id);
  return { ...palettes[seed % palettes.length]!, seed, rotation: ((seed % 16) * Math.PI) / 8 };
}
export function islandPosition(index: number, count: number): [number, number, number] {
  const columns = Math.min(3, Math.max(1, count));
  const rows = Math.ceil(count / columns);
  const row = Math.floor(index / columns);
  const rowCount = Math.min(columns, count - row * columns);
  return [
    ((index % columns) - (rowCount - 1) / 2) * 7.3,
    row % 2 ? 0.35 : 0,
    (row - (rows - 1) / 2) * 6.7,
  ];
}
