<script setup lang="ts">
import { useAccount } from '@wagmi/vue';

const { isConnected } = useAccount();
const { isAuthenticated, isLoading, authResolved, signIn, user } = useAuth();
const error = ref<string | null>(null);

const router = useRouter();
watch(isAuthenticated, (val) => {
  if (val) router.push('/agents');
}, { immediate: true });

const { initConnect } = useOpenRouter();
const connectingOR = ref(false);
const connectORError = ref<string | null>(null);
async function handleConnectOR() {
  connectingOR.value = true;
  connectORError.value = null;
  try {
    await initConnect(); // redirects away on success
  } catch (err) {
    connectORError.value = (err as Error)?.message ?? 'Failed to initiate connection.';
    connectingOR.value = false;
  }
}

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
        <span class="brand-name">Something in loop</span>
        <span class="beta-badge">Beta</span>
      </div>

      <p class="connect-tagline">AI-powered paper trading agents on Base chain</p>

      <!-- Connect wallet (always visible) -->
      <div class="connect-section">
        <div class="connect-btn-wrap">
          <w3m-button balance="hide" />
        </div>
      </div>

      <!-- Loading: session check in progress -->
      <Transition name="fade">
        <div v-if="!authResolved" class="connect-session-loading">
          <div class="connect-loader-dots">
            <span /><span /><span />
          </div>
          <span>Restoring session</span>
        </div>
      </Transition>

      <!-- Step 2: SIWE verification — only shown once session check is done -->
      <Transition name="fade">
        <div v-if="authResolved && isConnected && !isAuthenticated" class="connect-section siwe-section">
          <div class="divider" />
          <h2 class="step-label">Verify your wallet</h2>
          <p class="step-hint">
            Sign a short message to prove wallet ownership. No gas required.
          </p>

          <div v-if="error" class="connect-error">{{ error }}</div>

          <button
            class="btn btn-primary btn-wide btn-sign-in"
            :disabled="isLoading"
            @click="handleSignIn"
          >
            <span v-if="isLoading" class="loading-dots">
              <span /><span /><span />
            </span>
            <span v-else>Sign In with Wallet</span>
          </button>
        </div>
      </Transition>

      <!-- Already signed in -->
      <div v-if="isAuthenticated && user" class="connect-section">
        <p class="connect-hint">
          Signed in as <code>{{ truncate(user.walletAddress) }}</code>
        </p>
        <NuxtLink to="/agents" class="btn btn-primary btn-wide">Go to Agents</NuxtLink>
      </div>
    </div>

    <Transition name="fade">
      <div v-if="isAuthenticated" class="connect-step2">
        <div class="step-header">
          <span class="step-num">2</span>
          <span class="step-label">Connect OpenRouter <span class="step-opt">(optional)</span></span>
        </div>
        <p class="step-desc">
          Unlock paid models (GPT-5, Claude, Gemini…) using your own OpenRouter account.
          Your key is stored encrypted and never shared.
        </p>
        <div class="step-actions">
          <template v-if="user?.openRouterKeySet">
            <span class="or-connected-badge">✓ OpenRouter connected</span>
            <NuxtLink to="/agents" class="btn btn-primary btn-sm">Continue →</NuxtLink>
          </template>
          <template v-else>
            <button class="btn btn-primary" :disabled="connectingOR" @click="handleConnectOR">
              {{ connectingOR ? 'Redirecting…' : 'Connect OpenRouter →' }}
            </button>
            <p v-if="connectORError" class="connect-or-error">{{ connectORError }}</p>
            <NuxtLink to="/agents" class="skip-link">Skip for now</NuxtLink>
          </template>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.connect-root {
  min-height: 100vh;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: 2rem 1rem 4rem;
  background: var(--bg-primary);
}

.connect-card {
  width: 100%;
  max-width: 480px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 2.75rem 2.25rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  overflow: hidden;
}

/* Connect button: inside box, full width, bigger */
.connect-btn-wrap {
  width: 100%;
}

.connect-btn-wrap :deep(w3m-button),
.connect-btn-wrap :deep(button) {
  width: 100% !important;
  min-height: 52px !important;
  font-size: 1rem !important;
  font-weight: 600 !important;
  border-radius: 12px !important;
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

.connect-session-loading {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-muted);
  animation: label-blink 1.4s steps(1) infinite;
}

.connect-loader-dots {
  display: flex;
  gap: 3px;
}
.connect-loader-dots span {
  width: 4px;
  height: 4px;
  background: var(--accent);
  animation: block-scan 1.6s ease-in-out infinite;
}
.connect-loader-dots span:nth-child(1) { animation-delay: 0s; }
.connect-loader-dots span:nth-child(2) { animation-delay: 0.2s; }
.connect-loader-dots span:nth-child(3) { animation-delay: 0.4s; }

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

.btn-sign-in {
  min-height: 48px;
  font-size: 1rem;
  font-weight: 600;
}

/* Loading: three bouncing dots */
.loading-dots {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
}

.loading-dots span {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: bounce 0.6s ease-in-out infinite both;
}

.loading-dots span:nth-child(1) { animation-delay: 0s; }
.loading-dots span:nth-child(2) { animation-delay: 0.15s; }
.loading-dots span:nth-child(3) { animation-delay: 0.3s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0.6); opacity: 0.6; }
  40% { transform: scale(1); opacity: 1; }
}

.connect-hint {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 0;
}

.fade-enter-active,
.fade-leave-active { transition: opacity 0.25s ease, transform 0.25s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; transform: translateY(-4px); }

.connect-step2 {
  margin-top: 24px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 24px;
  width: 100%;
  max-width: 420px;
}
.connect-step2 .step-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.connect-step2 .step-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  text-transform: none;
  letter-spacing: normal;
}
.step-opt {
  font-weight: 400;
  color: var(--text-dim);
  font-size: 12px;
}
.step-desc {
  font-size: 13px;
  color: var(--text-dim);
  line-height: 1.5;
  margin-bottom: 16px;
}
.step-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.or-connected-badge {
  font-size: 13px;
  color: var(--success, #22c55e);
  font-weight: 500;
}
.skip-link {
  font-size: 13px;
  color: var(--text-dim);
  text-decoration: none;
}
.skip-link:hover { color: var(--text); }
.connect-or-error { font-size: 12px; color: var(--danger, #ef4444); margin-top: 6px; }
</style>
