/**
 * Module-level reactive refs for wallet state.
 * Updated by watchConnection() in the reown plugin — no Vue lifecycle hooks needed.
 * Safe to read from anywhere: composables, middleware, plugins.
 */
import { ref } from 'vue';

export const walletAddress = ref<string>('');
export const walletIsConnected = ref<boolean>(false);
