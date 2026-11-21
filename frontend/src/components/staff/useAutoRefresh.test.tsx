import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_INTERVAL_MS, useAutoRefresh } from './useAutoRefresh';

const nav = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => nav }));

function Probe({ onReady }: { onReady?: (refresh: () => void) => void }) {
  const refresh = useAutoRefresh();
  onReady?.(refresh);
  return null;
}

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  nav.refresh.mockClear();
  setVisibility('visible');
  nav.refresh.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  setVisibility('visible');
});

describe('useAutoRefresh', () => {
  it('既定は 5 秒', () => {
    expect(REFRESH_INTERVAL_MS).toBe(5000);
  });

  it('表示されている間、5 秒ごとに router.refresh()', () => {
    render(<Probe />);
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(4999));
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(1));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(10_000));
    expect(nav.refresh).toHaveBeenCalledTimes(3);
  });

  it('非表示のタブでは止める。表示に戻ったら、すぐ 1 回取って再開する', () => {
    render(<Probe />);
    act(() => setVisibility('hidden'));
    act(() => void vi.advanceTimersByTime(60_000));
    expect(nav.refresh).not.toHaveBeenCalled();
    act(() => setVisibility('visible'));
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(5000));
    expect(nav.refresh).toHaveBeenCalledTimes(2);
  });

  it('最初から非表示なら、動かさない', () => {
    setVisibility('hidden');
    render(<Probe />);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('画面を離れたら、タイマーとイベントを外す', () => {
    const { unmount } = render(<Probe />);
    unmount();
    act(() => void vi.advanceTimersByTime(30_000));
    act(() => setVisibility('visible'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('戻り値は、手動で取り直す関数', () => {
    let manual: () => void = () => {};
    render(<Probe onReady={(r) => (manual = r)} />);
    manual();
    expect(nav.refresh).toHaveBeenCalledTimes(1);
  });
});
