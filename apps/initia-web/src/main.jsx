import { Buffer } from 'buffer'
window.Buffer = Buffer
window.process = { env: {} }

import React from 'react'
import ReactDOM from 'react-dom/client'
import { WagmiProvider } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { InterwovenKitProvider, injectStyles } from '@initia/interwovenkit-react'
import InterwovenKitStyles from '@initia/interwovenkit-react/styles.js'
import '@initia/interwovenkit-react/styles.css'

import { wagmiConfig } from './wagmi.js'
import { customChain, BRIDGE_SRC_CHAIN_ID, CHAIN_ID, TESTNET } from './chain.js'
import App from './App.jsx'
import './styles.css'

injectStyles(InterwovenKitStyles)

const queryClient = new QueryClient()

ReactDOM.createRoot(document.getElementById('root')).render(
  <WagmiProvider config={wagmiConfig}>
    <QueryClientProvider client={queryClient}>
      <InterwovenKitProvider
        {...TESTNET}
        defaultChainId={BRIDGE_SRC_CHAIN_ID}
        customChain={customChain}
        customChains={[customChain]}
        enableAutoSign={{ [CHAIN_ID]: ['/minievm.evm.v1.MsgCall'] }}
      >
        <App />
      </InterwovenKitProvider>
    </QueryClientProvider>
  </WagmiProvider>
)
