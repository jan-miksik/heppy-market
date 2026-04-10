/**
 * Auth init plugin — restores session state on app start.
 * Runs in the background so the app can render immediately while auth restores.
 * Once resolved, unauthenticated users are redirected to /connect.
 */
export default defineNuxtPlugin(() => {
  const { fetchMe, isAuthenticated } = useAuth();
  const router = useRouter();

  void fetchMe()
    .catch(() => {})
    .finally(() => {
      if (!isAuthenticated.value && router.currentRoute.value.path !== '/connect') {
        const route = router.currentRoute.value;
        const returnTo = `${route.path}${route.fullPath.slice(route.path.length)}`;
        void navigateTo(`/connect?returnTo=${encodeURIComponent(returnTo)}`, { replace: true });
      }
    });
});
