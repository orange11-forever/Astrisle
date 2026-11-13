import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { observeSceneActivity, scheduleSceneFrames } from './render-budget';

describe('ambient scene frame budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders immediately and caps ambient invalidations at 30 per second', () => {
    const frames: number[] = [];
    const stop = scheduleSceneFrames(() => frames.push(Date.now()), {
      active: true,
      reduced: false,
    });
    expect(frames).toEqual([0]);

    vi.advanceTimersByTime(1000);
    expect(frames.length).toBeGreaterThanOrEqual(29);
    expect(frames.length).toBeLessThanOrEqual(30);
    expect(frames.slice(1).every((time, i) => time - frames[i]! >= 1000 / 30)).toBe(true);
    stop();
  });

  it('draws a reduced-motion update once without scheduling ambient work', () => {
    const frames: number[] = [];
    const stop = scheduleSceneFrames(() => frames.push(Date.now()), {
      active: true,
      reduced: true,
    });
    vi.advanceTimersByTime(60_000);
    expect(frames).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('stays idle while inactive and requests an immediate frame when resumed', () => {
    const frames: number[] = [];
    const invalidate = () => frames.push(Date.now());
    const stopInactive = scheduleSceneFrames(invalidate, { active: false, reduced: false });
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    stopInactive();

    const stopActive = scheduleSceneFrames(invalidate, { active: true, reduced: false });
    expect(frames).toEqual([1000]);
    vi.advanceTimersByTime(34);
    expect(frames).toEqual([1000, 1034]);
    stopActive();
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([1000, 1034]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves only one timer after StrictMode cleanup and effect reconnection', () => {
    const frames: number[] = [];
    const invalidate = () => frames.push(Date.now());
    const options = { active: true, reduced: false };
    const stopFirst = scheduleSceneFrames(invalidate, options);
    stopFirst();
    stopFirst();
    const stopSecond = scheduleSceneFrames(invalidate, options);
    vi.advanceTimersByTime(100);
    expect(frames).toEqual([0, 0, 34, 68]);
    expect(vi.getTimerCount()).toBe(1);
    stopSecond();
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([0, 0, 34, 68]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows independent interaction invalidations without adding ambient loops', () => {
    const frames: number[] = [];
    const invalidate = () => frames.push(Date.now());
    const stop = scheduleSceneFrames(invalidate, { active: true, reduced: false });
    vi.advanceTimersByTime(10);
    invalidate();
    vi.advanceTimersByTime(10);
    invalidate();
    vi.advanceTimersByTime(48);
    expect(frames).toEqual([0, 10, 20, 34, 68]);
    expect(vi.getTimerCount()).toBe(1);
    stop();
  });

  it('pauses for blur and hidden documents, resumes on focus, and removes listeners', () => {
    let focused = true;
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      hasFocus: () => focused,
    });
    const windowTarget = new EventTarget();
    vi.stubGlobal('document', documentTarget);
    vi.stubGlobal('window', windowTarget);

    const frames: number[] = [];
    let stopFrames: (() => void) | undefined;
    const stopObserving = observeSceneActivity((active) => {
      stopFrames?.();
      stopFrames = scheduleSceneFrames(() => frames.push(Date.now()), {
        active,
        reduced: false,
      });
    });
    expect(frames).toEqual([0]);
    focused = false;
    windowTarget.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([0]);
    expect(vi.getTimerCount()).toBe(0);

    documentTarget.hidden = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    focused = true;
    windowTarget.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([0]);

    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(frames).toEqual([0, 2000]);
    vi.advanceTimersByTime(34);
    expect(frames).toEqual([0, 2000, 2034]);

    stopObserving();
    stopFrames?.();
    windowTarget.dispatchEvent(new Event('focus'));
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(1000);
    expect(frames).toEqual([0, 2000, 2034]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not activate an initially unfocused document just because it becomes visible', () => {
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: true,
      hasFocus: () => false,
    });
    const windowTarget = new EventTarget();
    vi.stubGlobal('document', documentTarget);
    vi.stubGlobal('window', windowTarget);
    const activity: boolean[] = [];
    const stop = observeSceneActivity((active) => activity.push(active));
    expect(activity).toEqual([false]);
    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(activity.at(-1)).toBe(false);
    stop();
  });

  it('resumes on window focus and treats blur as inactive immediately', () => {
    let focused = false;
    const documentTarget = Object.assign(new EventTarget(), {
      hidden: false,
      hasFocus: () => focused,
    });
    const windowTarget = new EventTarget();
    vi.stubGlobal('document', documentTarget);
    vi.stubGlobal('window', windowTarget);
    const activity: boolean[] = [];
    const stop = observeSceneActivity((active) => activity.push(active));
    focused = true;
    windowTarget.dispatchEvent(new Event('focus'));
    // Some hosts update hasFocus after the blur event has reached its listeners.
    windowTarget.dispatchEvent(new Event('blur'));
    expect(activity).toEqual([false, true, false]);
    stop();
  });
});
