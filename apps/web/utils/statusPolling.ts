/**
 * Polls `refresh` every `intervalMs` until either:
 * - `getSeconds()` returns a value > 0 (future alarm scheduled) → calls `onComplete`, or
 * - `isRunning()` returns false (agent stopped) → stops silently
 *
 * Returns a cancel function that stops the pending poll.
 */
export function pollUntilFutureAlarm(
  getSeconds: () => number | null,
  isRunning: () => boolean,
  refresh: () => Promise<void>,
  intervalMs = 5_000,
  onComplete?: () => Promise<void>,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function schedule(): void {
    timer = setTimeout(async () => {
      await refresh();
      if ((getSeconds() ?? 0) === 0 && isRunning()) {
        schedule();
      } else if ((getSeconds() ?? 0) > 0) {
        await onComplete?.();
      }
    }, intervalMs);
  }

  schedule();

  return () => {
    if (timer !== null) clearTimeout(timer);
  };
}
