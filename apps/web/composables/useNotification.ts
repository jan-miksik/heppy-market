type NotificationKind = 'success' | 'error';

export type SiteNotification = {
  type: NotificationKind;
  title?: string;
  message: string;
  durationMs?: number;
};

export type NotificationState = {
  id: number;
  type: NotificationKind;
  title?: string;
  message: string;
};

const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();

export function useNotification() {
  const notifications = useState<NotificationState[]>('site-notifications', () => []);

  function clearNotification(id?: number) {
    if (id !== undefined) {
      const timer = dismissTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        dismissTimers.delete(id);
      }
      notifications.value = notifications.value.filter(n => n.id !== id);
    } else {
      dismissTimers.forEach(t => clearTimeout(t));
      dismissTimers.clear();
      notifications.value = [];
    }
  }

  function showNotification(payload: SiteNotification) {
    const id = Date.now();
    notifications.value = [
      ...notifications.value,
      { id, type: payload.type, title: payload.title, message: payload.message },
    ];

    const durationMs = payload.durationMs ?? 12_000;
    if (durationMs > 0) {
      const timer = setTimeout(() => {
        notifications.value = notifications.value.filter(n => n.id !== id);
        dismissTimers.delete(id);
      }, durationMs);
      dismissTimers.set(id, timer);
    }
  }

  return {
    notifications,
    showNotification,
    clearNotification,
  };
}
