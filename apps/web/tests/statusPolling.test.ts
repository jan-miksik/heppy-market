import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pollUntilFutureAlarm } from '../utils/statusPolling';

describe('pollUntilFutureAlarm', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('calls refresh after intervalMs', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(300); // future after first refresh
    const isRunning = vi.fn().mockReturnValue(true);

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000);

    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('polls again every intervalMs while seconds stays 0 and running', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    // First poll: still 0 → reschedule. Second poll: future → stop.
    const getSeconds = vi.fn().mockReturnValueOnce(0).mockReturnValue(300);
    const isRunning = vi.fn().mockReturnValue(true);

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('stops polling once seconds is in the future', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(300); // always future
    const isRunning = vi.fn().mockReturnValue(true);

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1); // no second call
  });

  it('stops polling when agent is no longer running', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(0); // still 0
    const isRunning = vi.fn().mockReturnValueOnce(false); // stopped after first refresh

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledTimes(1); // no second call
  });

  it('calls onComplete when alarm moves to future', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(300); // future after first refresh
    const isRunning = vi.fn().mockReturnValue(true);

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000, onComplete);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('does not call onComplete until polling completes', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn().mockResolvedValue(undefined);
    // First poll: still 0 → reschedule. Second poll: future → stop.
    const getSeconds = vi.fn().mockReturnValueOnce(0).mockReturnValue(300);
    const isRunning = vi.fn().mockReturnValue(true);

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000, onComplete);

    await vi.advanceTimersByTimeAsync(5_000); // still 0 after first
    expect(onComplete).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000); // future after second
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it('does not call onComplete when polling stops because agent stopped', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const onComplete = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(0);
    const isRunning = vi.fn().mockReturnValueOnce(false); // stopped

    pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000, onComplete);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('cancel() prevents the pending poll from firing', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    const getSeconds = vi.fn().mockReturnValue(0);
    const isRunning = vi.fn().mockReturnValue(true);

    const cancel = pollUntilFutureAlarm(getSeconds, isRunning, refresh, 5_000);
    cancel();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).not.toHaveBeenCalled();
  });
});
