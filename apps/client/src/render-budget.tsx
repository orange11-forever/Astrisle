import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';

type FrameBudgetOptions = { reduced: boolean; active: boolean };

// Round up so timer precision cannot turn a 30fps budget into a faster loop.
const ambientFrameDelay = Math.ceil(1000 / 30);

export function scheduleSceneFrames(
  invalidate: () => void,
  { reduced, active }: FrameBudgetOptions,
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const draw = () => {
    if (stopped) return;
    invalidate();
    if (!stopped && !reduced) timer = setTimeout(draw, ambientFrameDelay);
  };
  // Refresh immediately on mount, motion changes, or focus restoration.
  if (active) draw();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

function readSceneActivity() {
  return typeof document !== 'undefined' && !document.hidden && document.hasFocus();
}

export function observeSceneActivity(onChange: (active: boolean) => void): () => void {
  const update = () => onChange(readSceneActivity());
  const blur = () => onChange(false);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', update);
  window.addEventListener('blur', blur);
  update();
  return () => {
    document.removeEventListener('visibilitychange', update);
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', blur);
  };
}

export function useSceneActivity() {
  const [active, setActive] = useState(readSceneActivity);
  useEffect(() => observeSceneActivity(setActive), []);
  return active;
}

/** Mount inside a demand Canvas; camera controls and React still request their own frames. */
export function SceneFrameBudget({ reduced, active }: FrameBudgetOptions) {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(
    () => scheduleSceneFrames(invalidate, { reduced, active }),
    [invalidate, reduced, active],
  );
  return null;
}
