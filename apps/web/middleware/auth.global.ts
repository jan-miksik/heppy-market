/**
 * Auth guard middleware — redirects unauthenticated users to /connect.
 * Runs on every route navigation in the SPA.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  // Always allow public pages
  if (to.path === '/connect' || to.path === '/about') return;

  const { isAuthenticated, authResolved, fetchMe } = useAuth();

  // Block protected route rendering until auth restore completes.
  // This prevents transient 401 bursts from page-level API calls.
  if (!authResolved.value) {
    await fetchMe().catch(() => undefined);
  }

  if (!isAuthenticated.value) {
    const returnTo = `${to.path}${to.fullPath.slice(to.path.length)}`;
    return navigateTo(`/connect?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
  }
});
