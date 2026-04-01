import { useCallback, useEffect, useMemo, useState } from 'react'
import { useInterwovenKit } from '@initia/interwovenkit-react'
import { createPublicClient, encodeFunctionData, http, parseEther, stringToHex } from 'viem'

import { AGENT_ABI } from '../abi.js'
import { CHAIN_ID, CONTRACT_ADDRESS, EVM_RPC, pillowRollupViem } from '../chain.js'

const AUTO_SIGN_SCOPE = '/minievm.evm.v1.MsgCall'

const publicClient = createPublicClient({
  chain: pillowRollupViem,
  transport: http(EVM_RPC),
})

function buildMsgCall(sender, input, value = '0x0') {
  return {
    typeUrl: AUTO_SIGN_SCOPE,
    value: {
      sender: sender.toLowerCase(),
      contractAddr: CONTRACT_ADDRESS.toLowerCase(),
      input,
      value,
      accessList: [],
      authList: [],
    },
  }
}

function parseTxHash(tx) {
  if (!tx || typeof tx !== 'object') return null
  return tx.txhash || tx.txHash || tx.tx_hash || tx.transactionHash || null
}

export function useInitiaAgent() {
  const {
    initiaAddress,
    address,
    hexAddress,
    openConnect,
    openWallet,
    requestTxBlock,
    autoSign,
  } = useInterwovenKit()

  const walletEvmAddress = hexAddress || address || ''
  const sessionAutoSignEnabled = Boolean(autoSign?.isEnabledByChain?.[CHAIN_ID])

  const [chainOk, setChainOk] = useState(false)
  const [walletBalanceWei, setWalletBalanceWei] = useState(null)
  const [vaultBalanceWei, setVaultBalanceWei] = useState('0')
  const [agentExists, setAgentExists] = useState(false)
  const [autoSignEnabled, setAutoSignEnabled] = useState(false)
  const [lastTxHash, setLastTxHash] = useState(null)
  const [busyAction, setBusyAction] = useState('')
  const [error, setError] = useState(null)

  const refresh = useCallback(async () => {
    try {
      await publicClient.getBlockNumber()
      setChainOk(true)
    } catch {
      setChainOk(false)
    }

    if (!walletEvmAddress) {
      setWalletBalanceWei(null)
      setVaultBalanceWei('0')
      setAgentExists(false)
      setAutoSignEnabled(false)
      return
    }

    try {
      const walletBalance = await publicClient.getBalance({ address: walletEvmAddress })
      setWalletBalanceWei(walletBalance.toString())
    } catch {
      setWalletBalanceWei(null)
    }

    try {
      const result = await publicClient.readContract({
        address: CONTRACT_ADDRESS,
        abi: AGENT_ABI,
        functionName: 'getAgent',
        args: [walletEvmAddress],
      })

      setVaultBalanceWei((result?.[1] ?? 0n).toString())
      setAgentExists(Boolean(result?.[2]))
      setAutoSignEnabled(Boolean(result?.[3]) || sessionAutoSignEnabled)
    } catch {
      setVaultBalanceWei('0')
      setAgentExists(false)
      setAutoSignEnabled(sessionAutoSignEnabled)
    }
  }, [sessionAutoSignEnabled, walletEvmAddress])

  useEffect(() => {
    void refresh()
    const intervalId = window.setInterval(() => {
      void refresh()
    }, 4_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [refresh])

  const runTx = useCallback(async (action, input, valueHex = '0x0') => {
    if (!initiaAddress) throw new Error('Connect your Initia wallet first.')

    setBusyAction(action)
    setError(null)
    try {
      const tx = await requestTxBlock({
        chainId: CHAIN_ID,
        messages: [buildMsgCall(initiaAddress, input, valueHex)],
      })
      const txHash = parseTxHash(tx)
      setLastTxHash(txHash)
      await refresh()
      return { txHash }
    } catch (txError) {
      setError(txError?.message ?? String(txError))
      throw txError
    } finally {
      setBusyAction('')
    }
  }, [initiaAddress, refresh, requestTxBlock])

  const createAgentOnchain = useCallback(async (metadataPointer) => {
    const input = encodeFunctionData({
      abi: AGENT_ABI,
      functionName: 'createAgent',
      args: [stringToHex(JSON.stringify(metadataPointer || {}))],
    })
    return runTx('createAgent', input)
  }, [runTx])

  const deposit = useCallback(async (amount) => {
    const wei = parseEther(String(amount || '0'))
    const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'deposit', args: [] })
    return runTx('deposit', input, `0x${wei.toString(16)}`)
  }, [runTx])

  const withdraw = useCallback(async (amount) => {
    const wei = parseEther(String(amount || '0'))
    const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'withdraw', args: [wei] })
    return runTx('withdraw', input)
  }, [runTx])

  const enableAutoSign = useCallback(async () => {
    if (!initiaAddress) throw new Error('Connect your Initia wallet first.')

    setBusyAction('enableAutoSign')
    setError(null)
    try {
      await autoSign?.enable(CHAIN_ID, { permissions: [AUTO_SIGN_SCOPE] })
      const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'enableAutoSign', args: [] })
      const tx = await requestTxBlock({
        chainId: CHAIN_ID,
        messages: [buildMsgCall(initiaAddress, input)],
      })
      const txHash = parseTxHash(tx)
      setLastTxHash(txHash)
      await refresh()
      return { txHash }
    } catch (txError) {
      setError(txError?.message ?? String(txError))
      throw txError
    } finally {
      setBusyAction('')
    }
  }, [autoSign, initiaAddress, refresh, requestTxBlock])

  const disableAutoSign = useCallback(async () => {
    if (!initiaAddress) throw new Error('Connect your Initia wallet first.')

    setBusyAction('disableAutoSign')
    setError(null)
    try {
      await autoSign?.disable(CHAIN_ID)
      const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'disableAutoSign', args: [] })
      const tx = await requestTxBlock({
        chainId: CHAIN_ID,
        messages: [buildMsgCall(initiaAddress, input)],
      })
      const txHash = parseTxHash(tx)
      setLastTxHash(txHash)
      await refresh()
      return { txHash }
    } catch (txError) {
      setError(txError?.message ?? String(txError))
      throw txError
    } finally {
      setBusyAction('')
    }
  }, [autoSign, initiaAddress, refresh, requestTxBlock])

  const executeTick = useCallback(async () => {
    if (!initiaAddress) throw new Error('Connect your Initia wallet first.')

    setBusyAction('executeTick')
    setError(null)
    try {
      const input = encodeFunctionData({ abi: AGENT_ABI, functionName: 'executeTick', args: [] })
      const tx = await requestTxBlock({
        chainId: CHAIN_ID,
        autoSign: autoSignEnabled,
        messages: [buildMsgCall(initiaAddress, input)],
      })
      const txHash = parseTxHash(tx)
      setLastTxHash(txHash)
      await refresh()
      return { txHash }
    } catch (txError) {
      setError(txError?.message ?? String(txError))
      throw txError
    } finally {
      setBusyAction('')
    }
  }, [autoSignEnabled, initiaAddress, refresh, requestTxBlock])

  return useMemo(() => ({
    initiaAddress,
    walletEvmAddress,
    openConnect,
    openWallet,
    refresh,
    chainOk,
    walletBalanceWei,
    vaultBalanceWei,
    agentExists,
    autoSignEnabled,
    lastTxHash,
    busyAction,
    error,
    createAgentOnchain,
    deposit,
    withdraw,
    enableAutoSign,
    disableAutoSign,
    executeTick,
  }), [
    initiaAddress,
    walletEvmAddress,
    openConnect,
    openWallet,
    refresh,
    chainOk,
    walletBalanceWei,
    vaultBalanceWei,
    agentExists,
    autoSignEnabled,
    lastTxHash,
    busyAction,
    error,
    createAgentOnchain,
    deposit,
    withdraw,
    enableAutoSign,
    disableAutoSign,
    executeTick,
  ])
}
