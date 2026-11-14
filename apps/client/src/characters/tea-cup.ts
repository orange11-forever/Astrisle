import * as THREE from 'three';

/** Small owned prop; never mutate a material from the shared GLB cache. */
export function createTeaCup() {
  const root = new THREE.Group();
  root.name = 'held-teacup';
  const porcelain = new THREE.MeshStandardMaterial({ color: '#e9ede1', roughness: 0.3 });
  const tea = new THREE.MeshStandardMaterial({ color: '#785637', roughness: 0.15 });
  const gold = new THREE.MeshStandardMaterial({
    color: '#bba16c',
    roughness: 0.4,
    metalness: 0.35,
  });
  const bowl = new THREE.Mesh(
    new THREE.LatheGeometry(
      [
        new THREE.Vector2(0, 0),
        new THREE.Vector2(0.036, 0),
        new THREE.Vector2(0.052, 0.075),
        new THREE.Vector2(0.045, 0.075),
        new THREE.Vector2(0.03, 0.012),
        new THREE.Vector2(0, 0.012),
      ],
      16,
    ),
    porcelain,
  );
  root.add(bowl);
  const liquid = new THREE.Mesh(new THREE.CircleGeometry(0.043, 16), tea);
  liquid.rotation.x = -Math.PI / 2;
  liquid.position.y = 0.06;
  root.add(liquid);
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.026, 0.008, 5, 14), porcelain);
  handle.name = 'teacup-handle';
  handle.position.set(0.055, 0.037, 0);
  root.add(handle);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.049, 0.003, 4, 20), gold);
  rim.rotation.x = Math.PI / 2;
  rim.position.y = 0.075;
  root.add(rim);
  root.visible = false;
  return root;
}
/** The handle, rather than the bowl's centre, meets the sampled hand. */
export function placeTeaCup(
  cup: THREE.Group,
  hand: THREE.Vector3,
  handleSide: 1 | -1,
  sip: number,
) {
  cup.rotation.set(-sip * 0.18, handleSide === 1 ? 0 : Math.PI, 0);
  const handle = cup.getObjectByName('teacup-handle')!;
  cup.position.copy(hand).sub(handle.position.clone().applyEuler(cup.rotation));
}
export function disposeTeaCup(cup: THREE.Group) {
  const materials = new Set<THREE.Material>();
  cup.removeFromParent();
  cup.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.geometry.dispose();
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material);
  });
  materials.forEach((material) => material.dispose());
}
