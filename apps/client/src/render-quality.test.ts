import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { configureModelTextureSampling, scenePixelRatio } from './render-quality';

describe('scene render quality', () => {
  it('supersamples the clear view and keeps a one-pixel balanced fallback', () => {
    expect(scenePixelRatio('clear', 1376, 892)).toBe(1.5);
    expect(scenePixelRatio('clear', 390, 776)).toBe(1.5);
    expect(scenePixelRatio('balanced', 1376, 892)).toBe(1);
  });

  it('bounds the render buffer on large windows without changing the requested quality', () => {
    const dpr = scenePixelRatio('clear', 3840, 2160);
    expect(dpr * dpr * 3840 * 2160).toBeCloseTo(4_000_000);
    expect(scenePixelRatio('clear', 1376, 892)).toBe(1.5);
    expect(scenePixelRatio('clear', 0, 0)).toBe(1.5);
  });

  it('updates shared textures once, keeps their original data and filters, and restores balanced sampling', () => {
    const texture = new THREE.Texture({ width: 1024, height: 1024 });
    const image = texture.image;
    const material = new THREE.MeshStandardMaterial({ map: texture, roughnessMap: texture });
    const geometry = new THREE.BoxGeometry();
    const root = new THREE.Group();
    root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, [material, material]));
    const version = texture.version;

    expect(configureModelTextureSampling(root, 'clear', 16)).toBe(1);
    expect(texture.anisotropy).toBe(8);
    expect(texture.version).toBe(version + 1);
    expect(texture.image).toBe(image);
    expect(texture.minFilter).toBe(THREE.LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(THREE.LinearFilter);
    expect(configureModelTextureSampling(root, 'clear', 16)).toBe(0);
    expect(texture.version).toBe(version + 1);
    expect(configureModelTextureSampling(root, 'balanced', 16)).toBe(1);
    expect(texture.anisotropy).toBe(1);
    geometry.dispose();
    material.dispose();
    texture.dispose();
  });

  it('respects hardware limits and intentionally nearest-filtered textures', () => {
    const smooth = new THREE.Texture();
    const pixel = new THREE.Texture();
    pixel.magFilter = THREE.NearestFilter;
    const geometry = new THREE.BoxGeometry();
    const material = new THREE.MeshStandardMaterial({ map: smooth, emissiveMap: pixel });
    const root = new THREE.Mesh(geometry, material);
    configureModelTextureSampling(root, 'clear', 4);
    expect(smooth.anisotropy).toBe(4);
    expect(pixel.anisotropy).toBe(1);
    configureModelTextureSampling(root, 'clear', 0);
    expect(smooth.anisotropy).toBe(1);
    geometry.dispose();
    material.dispose();
    smooth.dispose();
    pixel.dispose();
  });
});
