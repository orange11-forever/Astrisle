import type { Page } from '@playwright/test';

export async function seedIslandLife(page: Page, model?: number[]) {
  await page.addInitScript((bytes) => {
    const workspace = {
      id: 'life-island',
      name: '花园工作室',
      sourcePath: '',
      workPath: 'fixture',
      createdAt: new Date().toISOString(),
    };
    const commission = {
      id: 'life-commission',
      workspaceId: workspace.id,
      title: '场景验收',
      goal: '核对岛屿生活',
      status: 'awaiting_acceptance',
      criteria: [],
      scope: {
        readRoots: [],
        writeRoots: [],
        allowProcess: false,
        allowNetwork: false,
        allowedHosts: [],
      },
      budget: { maxSteps: 30, maxMinutes: 20, maxRework: 2 },
      revision: 1,
      planningMode: 'auto',
      stepsUsed: 3,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      acceptedArtifactIds: [],
      summary: '',
    };
    const snapshot = {
      commission,
      workspace,
      agents: [],
      tasks: [],
      artifacts: [],
      evidence: [],
      events: [],
      requests: [],
      lastSequence: 0,
    };
    const listeners: ((s: unknown) => void)[] = [];
    const characters = [
      {
        id: 'mori',
        displayName: 'Mori',
        ...(bytes
          ? {
              model: {
                assetId: 'walking-fixture',
                filename: 'walking-fixture.glb',
                format: 'glb',
                byteLength: bytes.length,
                triangleCount: 84,
                animationCount: 0,
                hasSkins: false,
              },
              rotationY: 0,
            }
          : {}),
      },
      { id: 'luma', displayName: 'Luma' },
      { id: 'user', displayName: '我' },
    ];
    window.astrisle = {
      bootstrap: async () => ({
        workspaces: [workspace],
        commissions: [commission],
        characters,
        provider: {
          kind: 'openai-compatible',
          baseUrl: '',
          model: '',
          configured: false,
          hasApiKey: false,
        },
        capabilities: [],
        version: 'fixture',
      }),
      snapshot: async () => structuredClone(snapshot),
      loadCharacterModel: async () => new Uint8Array(bytes ?? []),
      onSnapshot: (listener: (s: unknown) => void) => {
        listeners.push(listener);
        return () => {
          const i = listeners.indexOf(listener);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
    } as unknown as NonNullable<Window['astrisle']>;
    (window as any).setLifeStatus = (status: string) => {
      commission.status = status;
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    };
    (window as any).setLifeWorking = () => {
      (snapshot.tasks as any[]).push({
        id: 'real-task',
        commissionId: commission.id,
        agentId: 'mori',
        title: '处理文件',
        description: '',
        kind: 'implement',
        status: 'running',
        dependencies: [],
        criterionIds: [],
        inputVersions: [],
        outputArtifactIds: [],
        step: 'workspace_read',
        attempts: 1,
        createdAt: commission.createdAt,
        updatedAt: commission.createdAt,
      });
      commission.status = 'active';
      listeners.forEach((listener) => listener(structuredClone(snapshot)));
    };
  }, model);
}

/** A synthetic two-footed static mesh, free of private character assets. */
export function humanoidGlb() {
  const positions: number[] = [];
  const box = (x: number, y: number, z: number, w: number, h: number, d: number) => {
    const corners = [
      [-1, -1, -1],
      [1, -1, -1],
      [1, 1, -1],
      [-1, 1, -1],
      [-1, -1, 1],
      [1, -1, 1],
      [1, 1, 1],
      [-1, 1, 1],
    ];
    const triangles = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1, 2, 6, 1, 6, 5, 3,
      0, 4, 3, 4, 7,
    ];
    for (const i of triangles)
      positions.push(
        x + (corners[i][0] * w) / 2,
        y + (corners[i][1] * h) / 2,
        z + (corners[i][2] * d) / 2,
      );
  };
  box(0, 0.88, 0, 0.48, 0.55, 0.27);
  box(0, 1.48, 0, 0.65, 0.74, 0.55);
  for (const side of [-1, 1]) {
    box(side * 0.16, 0.31, 0, 0.16, 0.53, 0.18);
    box(side * 0.16, 0.045, 0.05, 0.18, 0.09, 0.28);
    box(side * 0.32, 0.83, 0, 0.13, 0.38, 0.15);
  }
  const binary = Buffer.from(new Float32Array(positions).buffer);
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: binary.length }],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: positions.length / 3,
        type: 'VEC3',
        min: [-0.4, 0, -0.3],
        max: [0.4, 1.85, 0.3],
      },
    ],
  };
  const json = Buffer.from(JSON.stringify(document)),
    length = Math.ceil(json.length / 4) * 4;
  const result = Buffer.alloc(12 + 8 + length + 8 + binary.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  result.fill(32, 20, 20 + length);
  json.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + length);
  result.writeUInt32LE(0x004e4942, 24 + length);
  binary.copy(result, 28 + length);
  return result;
}
