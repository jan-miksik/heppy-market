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

  // Otherwise try to restore the session (session cookie may still be valid).
  // If the API is down (e.g. 502 from /api/auth/me), don't block navigation — treat as unauthenticated.
  try {
    await fetchMe();
  } catch {
    // Swallow errors; unauthenticated state is handled below.
  }

  if (!isAuthenticated.value) {
    if (to.path !== '/connect') return navigateTo('/connect');
  }
});
