import { createConfig, http } from 'wagmi'
import { pillowRollupViem } from './chain.js'

export const wagmiConfig = createConfig({
  chains: [pillowRollupViem],
  transports: { [pillowRollupViem.id]: http(pillowRollupViem.rpcUrls.default.http[0]) },
})
