import { createContext, useContext, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Quaternion, Vector3 } from 'three';

type Vector = [number, number, number];

export const LabelPortal = createContext<RefObject<HTMLElement> | undefined>(undefined);

export function ToolStation({
  position,
  rotation,
  labelPosition,
  label,
  onActivate,
  children,
}: {
  position?: Vector;
  rotation?: Vector;
  labelPosition: Vector;
  label: ReactNode;
  onActivate: () => void;
  children: ReactNode;
}) {
  const portal = useContext(LabelPortal);
  const [hovered, setHovered] = useState(false);
  const hoverCamera = useRef({ position: new Vector3(), rotation: new Quaternion() });
  useFrame(({ camera }) => {
    if (
      hovered &&
      (hoverCamera.current.position.distanceToSquared(camera.position) > 0.000001 ||
        1 - Math.abs(hoverCamera.current.rotation.dot(camera.quaternion)) > 0.000001)
    ) {
      setHovered(false);
    }
  });

  return (
    <group
      position={position}
      rotation={rotation}
      onPointerMove={(event) => {
        if (event.pointerType === 'touch' || event.buttons) {
          setHovered(false);
          return;
        }
        event.stopPropagation();
        hoverCamera.current.position.copy(event.camera.position);
        hoverCamera.current.rotation.copy(event.camera.quaternion);
        setHovered(true);
      }}
      onPointerOut={(event) => {
        // An individual child can lose its hit while the pointer stays on the station.
        if (!event.intersections.some((hit) => hit.eventObject === event.eventObject)) {
          setHovered(false);
        }
      }}
      onClick={(event) => {
        event.stopPropagation();
        onActivate();
      }}
    >
      {children}
      <Html portal={portal} position={labelPosition} center zIndexRange={[4, 0]}>
        <button
          type="button"
          className="scene-label scene-tool-label"
          data-hovered={hovered}
          onClick={onActivate}
        >
          {label}
        </button>
      </Html>
    </group>
  );
}
