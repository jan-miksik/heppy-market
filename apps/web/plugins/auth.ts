/**
 * Auth init plugin — restores the session state on every page load.
 * Calls GET /api/auth/me using the existing session cookie.
 * Runs before any route middleware so auth state is ready.
 */
export default defineNuxtPlugin(async () => {
  const { fetchMe } = useAuth();
  // Best-effort — ignore errors (unauthenticated state is handled by the route middleware)
  await fetchMe().catch(() => {});
});
