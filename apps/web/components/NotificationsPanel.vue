<script setup lang="ts">
const { state } = useInitiaBridge();
const { notifications, clearNotification } = useNotification();
const steps = computed(() => state.value.progressSteps ?? []);
</script>

<template>
  <Teleport to="body">
    <div class="notif-panel">
      <Transition name="tx-progress">
        <div v-if="steps.length" class="tx-progress-toast">
          <div
            v-for="(step, i) in steps"
            :key="i"
            class="tx-step"
            :class="`tx-step--${step.status}`"
          >
            <span class="tx-step__icon" aria-hidden="true">
              <template v-if="step.status === 'done'">✓</template>
              <template v-else-if="step.status === 'error'">✕</template>
              <template v-else-if="step.status === 'active'">
                <span class="tx-step__spinner" />
              </template>
              <template v-else>·</template>
            </span>
            <span class="tx-step__label">{{ step.label }}</span>
          </div>
        </div>
      </Transition>

      <TransitionGroup name="site-notif" tag="div" class="notif-stack">
        <section
          v-for="n in notifications"
          :key="n.id"
          class="site-notification"
          :class="`site-notification--${n.type}`"
          role="status"
          aria-live="polite"
        >
          <div class="site-notification__head">
            <strong>{{ n.title || (n.type === 'success' ? 'Success' : 'Error') }}</strong>
            <button
              type="button"
              class="site-notification__close"
              aria-label="Dismiss notification"
              @click="clearNotification(n.id)"
            >×</button>
          </div>
          <p class="site-notification__message">{{ n.message }}</p>
        </section>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.notif-panel {
  position: fixed;
  top: 68px;
  left: 16px;
  z-index: 10010;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(280px, calc(100vw - 32px));
  pointer-events: none;
}

/* — Progress toast — */
.tx-progress-toast {
  pointer-events: auto;
  background: var(--bg-card);
  border: 1px solid var(--border-light);
  border-left: 3px solid var(--accent);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tx-step {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.4;
}

.tx-step__icon {
  flex-shrink: 0;
  width: 14px;
  text-align: center;
  font-size: 10px;
}

.tx-step__label { color: var(--text-muted); }
.tx-step--active .tx-step__label { color: var(--text); }
.tx-step--done .tx-step__label { color: var(--text-muted); text-decoration: line-through; }
.tx-step--done .tx-step__icon { color: var(--green); }
.tx-step--error .tx-step__icon { color: #f87171; }
.tx-step--error .tx-step__label { color: #f87171; }

.tx-step__spinner {
  display: inline-block;
  width: 10px;
  height: 10px;
  border: 1.5px solid var(--border-light);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: tx-spin 0.7s linear infinite;
}

@keyframes tx-spin {
  to { transform: rotate(360deg); }
}

.tx-progress-enter-active,
.tx-progress-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.tx-progress-enter-from,
.tx-progress-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

/* — Stacked site notifications — */
.notif-stack {
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: auto;
}

.site-notification {
  border: 1px solid var(--border-light);
  border-left-width: 3px;
  background: var(--bg-card);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.site-notification--success {
  border-color: color-mix(in srgb, var(--green) 25%, var(--border));
  border-left-color: var(--green);
}

.site-notification--error {
  border-color: color-mix(in srgb, #f87171 25%, var(--border));
  border-left-color: #f87171;
}

.site-notification__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-muted);
}

.site-notification--success .site-notification__head strong { color: var(--green); }
.site-notification--error .site-notification__head strong { color: #f87171; }

.site-notification__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  line-height: 1;
  font-size: 11px;
  flex-shrink: 0;
  transition: border-color 0.1s, color 0.1s;
}

.site-notification__close:hover {
  border-color: var(--text-muted);
  color: var(--text);
}

.site-notification__message {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}

/* TransitionGroup animations */
.site-notif-enter-active,
.site-notif-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.site-notif-enter-from,
.site-notif-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

@media (max-width: 760px) {
  .notif-panel {
    top: 62px;
    left: 10px;
    width: calc(100vw - 20px);
  }
}
</style>
