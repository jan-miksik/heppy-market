/**
 * Auth guard middleware — redirects unauthenticated users to /connect.
 * Runs on every route navigation in the SPA.
 */
export default defineNuxtRouteMiddleware(async (to) => {
  // Always allow the connect page
  if (to.path === '/connect') return;

  const { isAuthenticated, fetchMe } = useAuth();

  // If state is already loaded, check immediately
  if (isAuthenticated.value) return;

  // Otherwise try to restore the session (session cookie may still be valid)
  await fetchMe();
  if (!isAuthenticated.value) {
    return navigateTo('/connect');
  }
});
