/**
 * Stores the wagmi Config created by the Reown plugin so that
 * @wagmi/core actions can be called from anywhere (composables, middleware)
 * without needing Vue's inject/provide context.
 */
import type { Config } from '@wagmi/core';

let _config: Config | null = null;

export function setWagmiConfig(config: Config): void {
  _config = config;
}

export function getWagmiConfig(): Config {
  if (!_config) throw new Error('[wagmi] Config not initialised — ensure the reown plugin loaded first');
  return _config;
}
