/**
 * Auth init plugin — restores session state on app start.
 * Non-blocking: starts fetchMe() but doesn't await it, so the app
 * renders immediately while the session check happens in the background.
 */
export default defineNuxtPlugin(() => {
  const { fetchMe } = useAuth();
  // Fire-and-forget: don't block app startup waiting for /api/auth/me
  fetchMe().catch(() => {});
});
