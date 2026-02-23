<script setup lang="ts">
const { isConnected, isAuthenticated, isLoading, signIn, user } = useAuth();
const error = ref<string | null>(null);

const router = useRouter();
watch(isAuthenticated, (val) => {
  if (val) router.push('/');
}, { immediate: true });

async function handleSignIn() {
  error.value = null;
  try {
    await signIn();
  } catch (err: unknown) {
    error.value = (err as Error)?.message ?? 'Sign-in failed. Please try again.';
  }
}

function truncate(addr: string): string {
  if (!addr) return '';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}
</script>

<template>
  <div class="connect-root">
    <div class="connect-card">
      <!-- Brand -->
      <div class="connect-brand">
        <span class="dot" />
        <span class="brand-name">Heppy Market</span>
        <span class="beta-badge">Beta</span>
      </div>

      <p class="connect-tagline">AI-powered paper trading agents on Base chain</p>

      <!-- Step 1: Connect wallet / email / social -->
      <div class="connect-section">
        <h2 class="step-label">Connect your wallet</h2>
        <p class="step-hint">
          Use MetaMask, WalletConnect, Coinbase Wallet, or sign in with email / social
          (Google, GitHub, Discord, X, Apple).
        </p>
        <div class="connect-btn-wrap">
          <!-- AppKit's built-in button — handles the full connection modal -->
          <w3m-button balance="hide" />
        </div>
      </div>

      <!-- Step 2: SIWE verification (appears after wallet is connected) -->
      <Transition name="fade">
        <div v-if="isConnected && !isAuthenticated" class="connect-section siwe-section">
          <div class="divider" />
          <h2 class="step-label">Verify your wallet</h2>
          <p class="step-hint">
            Sign a short message to prove wallet ownership. No gas required.
          </p>

          <div v-if="error" class="connect-error">{{ error }}</div>

          <button
            class="btn btn-primary btn-wide"
            :disabled="isLoading"
            @click="handleSignIn"
          >
            <span v-if="isLoading" class="spinner" />
            <span v-else>Sign In with Wallet</span>
          </button>
        </div>
      </Transition>

      <!-- Already signed in -->
      <div v-if="isAuthenticated && user" class="connect-section">
        <p class="connect-hint">
          Signed in as <code>{{ truncate(user.walletAddress) }}</code>
        </p>
        <NuxtLink to="/" class="btn btn-primary btn-wide">Go to Dashboard</NuxtLink>
      </div>
    </div>
  </div>
</template>

<style scoped>
.connect-root {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  background: var(--bg-primary);
}

.connect-card {
  width: 100%;
  max-width: 420px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.connect-brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-primary);
}

.brand-name { font-family: 'JetBrains Mono', monospace; }

.connect-tagline {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin: 0;
}

.connect-section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.siwe-section { padding-top: 0.5rem; }

.step-label {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.step-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
}

.connect-btn-wrap { display: flex; justify-content: flex-start; }

.divider {
  height: 1px;
  background: var(--border);
  margin-bottom: 0.5rem;
}

.connect-error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #ef4444;
  border-radius: 6px;
  padding: 0.5rem 0.75rem;
  font-size: 0.8rem;
}

.btn-wide { width: 100%; justify-content: center; }

.spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid transparent;
  border-top-color: currentColor;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin { to { transform: rotate(360deg); } }

.connect-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0;
}

.fade-enter-active,
.fade-leave-active { transition: opacity 0.2s; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }
</style>
