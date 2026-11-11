import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCharacterModelCache } from './model-cache';
import { characterDocument, makeGlb } from '../../../../tests/fixtures/character-model';

describe('shared custom character resources', () => {
  it('parses once for simultaneous clones, grounds and fits them, then releases GPU resources once', async () => {
    let reads = 0;
    const cache = createCharacterModelCache(async () => {
      reads++;
      return makeGlb();
    });
    const first = cache.acquire('one');
    const second = cache.acquire('one');
    const third = cache.acquire('one');
    const [a, b, c] = await Promise.all([first.ready, second.ready, third.ready]);
    expect(reads).toBe(1);
    const cloneA = a.instantiate();
    const cloneB = b.instantiate();
    const cloneC = c.instantiate();
    const geometry = (cloneA.getObjectByProperty('isMesh', true) as THREE.Mesh).geometry;
    expect((cloneB.getObjectByProperty('isMesh', true) as THREE.Mesh).geometry).toBe(geometry);
    expect((cloneC.getObjectByProperty('isMesh', true) as THREE.Mesh).geometry).toBe(geometry);
    expect(cloneA).not.toBe(cloneB);
    const bounds = new THREE.Box3().setFromObject(cloneA);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(1.85);
    expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    let disposed = 0;
    geometry.addEventListener('dispose', () => disposed++);
    first.release();
    second.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(0);
    third.release();
    third.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(1);
  });

  it('keeps a pending load shared through a StrictMode-style release and reacquire', async () => {
    let reads = 0;
    let finish!: (bytes: Uint8Array) => void;
    const cache = createCharacterModelCache(() => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = cache.acquire('one');
    first.release();
    const second = cache.acquire('one');
    finish(makeGlb());
    expect(await second.ready).toBe(await first.ready);
    expect(reads).toBe(1);
    second.release();
  });

  it('evicts failed imports so a corrected load can retry', async () => {
    let failing = true;
    const cache = createCharacterModelCache(async () => {
      if (failing) throw new Error('missing private asset');
      return makeGlb();
    });
    const failed = cache.acquire('one');
    await expect(failed.ready).rejects.toThrow('missing private asset');
    failed.release();
    failing = false;
    const retried = cache.acquire('one');
    await expect(retried.ready).resolves.toBeDefined();
    retried.release();
  });

  it('disposes shared materials once even when the file contains several scenes', async () => {
    const document = characterDocument();
    document.scenes.push({ nodes: [0] });
    const cache = createCharacterModelCache(async () => makeGlb(document));
    const lease = cache.acquire('two-scenes');
    const model = await lease.ready;
    const mesh = model.instantiate().getObjectByProperty('isMesh', true) as THREE.Mesh;
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    let disposed = 0;
    material.addEventListener('dispose', () => disposed++);
    lease.release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(disposed).toBe(1);
  });
});
