import { useCallback, useEffect, useMemo, useState } from 'react'
import { createSiweMessage } from 'viem/siwe'
import { useSignMessage } from 'wagmi'
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom'

import { EVM_CHAIN_ID } from './chain.js'
import AppShell from './components/AppShell.jsx'
import { apiRequest, extractApiError } from './lib/api.js'
import { useInitiaAgent } from './hooks/useInitiaAgent.js'
import ConnectPage from './pages/ConnectPage.jsx'
import CreateAgentPage from './pages/CreateAgentPage.jsx'
import AgentDetailPage from './pages/AgentDetailPage.jsx'

function getEip1193Providers() {
  if (typeof window === 'undefined') return []

  const providers = []
  if (window.ethereum) providers.push(window.ethereum)
  if (window.interwoven?.ethereum) providers.push(window.interwoven.ethereum)
  if (window.initia?.ethereum) providers.push(window.initia.ethereum)
  return providers.filter((provider, index, arr) => provider && arr.indexOf(provider) === index)
}

async function signSiweWithFallback(message, walletAddress, signMessageAsync) {
  try {
    return await signMessageAsync({ message })
  } catch {
    // Fallback for wallet providers that only expose personal_sign.
  }

  if (!walletAddress) throw new Error('Connect a wallet with EVM signing first.')

  const providers = getEip1193Providers()
  let lastError = null

  for (const provider of providers) {
    if (!provider || typeof provider.request !== 'function') continue

    try {
      return await provider.request({
        method: 'personal_sign',
        params: [message, walletAddress],
      })
    } catch (errorA) {
      lastError = errorA
    }

    try {
      return await provider.request({
        method: 'personal_sign',
        params: [walletAddress, message],
      })
    } catch (errorB) {
      lastError = errorB
    }
  }

  throw new Error(extractApiError(lastError) || 'Wallet could not sign SIWE message.')
}

function RoutedApp() {
  const navigate = useNavigate()
  const location = useLocation()

  const initia = useInitiaAgent()
  const { signMessageAsync } = useSignMessage()

  const [user, setUser] = useState(null)
  const [authResolved, setAuthResolved] = useState(false)
  const [authBusy, setAuthBusy] = useState(false)
  const [authError, setAuthError] = useState('')

  const [walletBusy, setWalletBusy] = useState(false)

  const [activeAgent, setActiveAgent] = useState(null)
  const [agentLoading, setAgentLoading] = useState(false)

  const walletEvmLower = initia.walletEvmAddress?.toLowerCase() || ''

  const refreshSession = useCallback(async () => {
    try {
      const sessionUser = await apiRequest('/api/auth/me', { timeout: 8_000 })
      setUser(sessionUser)
      setAuthResolved(true)
      return sessionUser
    } catch (error) {
      if (error?.status !== 401) {
        setAuthError(extractApiError(error))
      }
      setUser(null)
      setAuthResolved(true)
      return null
    }
  }, [])

  const refreshPrimaryAgent = useCallback(async (explicitUser) => {
    const currentUser = explicitUser ?? user
    if (!currentUser || !initia.initiaAddress) {
      setActiveAgent(null)
      return null
    }

    setAgentLoading(true)
    try {
      const data = await apiRequest('/api/agents', { timeout: 20_000 })
      const allAgents = Array.isArray(data?.agents) ? data.agents : []
      const initiaAgents = allAgents.filter((agent) => (agent.chain ?? agent.config?.chain) === 'initia')

      let selected = null
      if (initia.initiaAddress) {
        const targetWallet = initia.initiaAddress.toLowerCase()
        selected = initiaAgents.find((agent) => agent.initiaWalletAddress?.toLowerCase() === targetWallet) || null
      }
      if (!selected) selected = initiaAgents[0] ?? null

      setActiveAgent(selected)
      return selected
    } catch (error) {
      if (error?.status === 401) {
        setUser(null)
      }
      setActiveAgent(null)
      return null
    } finally {
      setAgentLoading(false)
    }
  }, [initia.initiaAddress, user])

  const signOut = useCallback(async () => {
    try {
      await apiRequest('/api/auth/logout', { method: 'POST' })
    } catch {
      // ignore logout API failures and clear local state regardless
    }
    setUser(null)
    setActiveAgent(null)
    setAuthResolved(true)
    setAuthError('')
    if (location.pathname !== '/connect') {
      navigate('/connect', { replace: true })
    }
  }, [location.pathname, navigate])

  const authenticate = useCallback(async () => {
    if (!initia.walletEvmAddress) {
      setAuthError('Connect an Initia wallet with EVM signing support first.')
      return
    }

    setAuthBusy(true)
    setAuthError('')

    try {
      const nonceRes = await apiRequest('/api/auth/nonce')
      const nonce = nonceRes?.nonce
      if (!nonce) throw new Error('Auth nonce response was empty.')

      const message = createSiweMessage({
        address: initia.walletEvmAddress,
        chainId: EVM_CHAIN_ID,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        version: '1',
        statement: 'Sign in to Something in loop',
      })

      const signature = await signSiweWithFallback(message, initia.walletEvmAddress, signMessageAsync)

      const verifiedUser = await apiRequest('/api/auth/verify', {
        method: 'POST',
        body: {
          message,
          signature,
          authProvider: 'wallet',
        },
        timeout: 20_000,
      })

      setUser(verifiedUser)
      setAuthResolved(true)
      await refreshPrimaryAgent(verifiedUser)
    } catch (error) {
      setUser(null)
      setAuthResolved(true)
      setAuthError(extractApiError(error))
    } finally {
      setAuthBusy(false)
    }
  }, [initia.walletEvmAddress, refreshPrimaryAgent, signMessageAsync])

  useEffect(() => {
    let cancelled = false

    const sync = async () => {
      if (!initia.initiaAddress) {
        setUser(null)
        setActiveAgent(null)
        setAuthResolved(true)
        setAuthError('')
        return
      }

      setAuthResolved(false)
      const sessionUser = await refreshSession()
      if (cancelled) return

      if (
        sessionUser?.walletAddress
        && walletEvmLower
        && sessionUser.walletAddress.toLowerCase() !== walletEvmLower
      ) {
        setUser(null)
        setActiveAgent(null)
        setAuthError('Connected wallet does not match current session. Re-authenticate with this wallet.')
        return
      }

      if (sessionUser) {
        await refreshPrimaryAgent(sessionUser)
      }
    }

    void sync()

    return () => {
      cancelled = true
    }
  }, [initia.initiaAddress, refreshPrimaryAgent, refreshSession, walletEvmLower])

  useEffect(() => {
    const path = location.pathname

    if (!initia.initiaAddress) {
      if (path !== '/connect') navigate('/connect', { replace: true })
      return
    }

    if (!authResolved) return

    if (!user) {
      if (path !== '/connect') navigate('/connect', { replace: true })
      return
    }

    if (agentLoading) return

    if (!activeAgent) {
      if (path !== '/agents/create') navigate('/agents/create', { replace: true })
      return
    }

    const detailPath = `/agents/${activeAgent.id}`
    if (path === '/connect' || path === '/agents/create' || (path.startsWith('/agents/') && path !== detailPath)) {
      navigate(detailPath, { replace: true })
    }
  }, [activeAgent, agentLoading, authResolved, initia.initiaAddress, location.pathname, navigate, user])

  const handleWalletClick = () => {
    setWalletBusy(true)
    try {
      const maybePromise = initia.initiaAddress ? initia.openWallet() : initia.openConnect()
      Promise.resolve(maybePromise)
        .catch((error) => {
          setAuthError(extractApiError(error))
        })
        .finally(() => {
          window.setTimeout(() => {
            setWalletBusy(false)
          }, 400)
        })
    } catch (error) {
      setAuthError(extractApiError(error))
      setWalletBusy(false)
    }
  }

  const handleCreated = async (createdAgent) => {
    setActiveAgent(createdAgent)
    await refreshPrimaryAgent(user)
    navigate(`/agents/${createdAgent.id}?initiaQuick=1`, { replace: true })
  }

  const shellProps = useMemo(() => ({
    walletAddress: initia.initiaAddress || initia.walletEvmAddress,
    chainOk: initia.chainOk,
    busyWallet: walletBusy,
    onWalletClick: handleWalletClick,
    user,
    onLogout: signOut,
  }), [handleWalletClick, initia.chainOk, initia.initiaAddress, initia.walletEvmAddress, signOut, user, walletBusy])

  return (
    <AppShell {...shellProps}>
      <Routes>
        <Route
          path="/connect"
          element={(
            <ConnectPage
              initia={initia}
              user={user}
              authBusy={authBusy}
              authError={authError}
              onAuthenticate={authenticate}
            />
          )}
        />

        <Route
          path="/agents/create"
          element={<CreateAgentPage initia={initia} user={user} onCreated={handleCreated} />}
        />

        <Route
          path="/agents/:id"
          element={(
            <AgentDetailPage
              initia={initia}
              onAgentChanged={(nextAgent) => setActiveAgent(nextAgent)}
              onAgentDeleted={() => {
                setActiveAgent(null)
                void refreshPrimaryAgent(user)
              }}
            />
          )}
        />

        <Route path="*" element={<Navigate to="/connect" replace />} />
      </Routes>
    </AppShell>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <RoutedApp />
    </BrowserRouter>
  )
}
