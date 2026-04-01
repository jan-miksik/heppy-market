import { useCallback, useEffect, useMemo, useState } from 'react'
import { formatEther } from 'viem'
import { useNavigate, useParams } from 'react-router-dom'

import { CONTRACT_ADDRESS } from '../chain.js'
import { apiRequest, extractApiError } from '../lib/api.js'
import { formatDateTime, formatPct, formatUsd, timeAgo } from '../lib/format.js'
import { formatJson, splitAgentPromptSections } from '../lib/prompt.js'

function parseSnapshot(snapshot) {
  if (!snapshot) return []
  try {
    return JSON.parse(snapshot)
  } catch {
    return []
  }
}

function safeFormatEther(raw) {
  try {
    return formatEther(BigInt(raw || '0'))
  } catch {
    return '0'
  }
}

export default function AgentDetailPage({ initia, onAgentChanged, onAgentDeleted }) {
  const { id } = useParams()
  const navigate = useNavigate()

  const [agent, setAgent] = useState(null)
  const [trades, setTrades] = useState([])
  const [decisions, setDecisions] = useState([])
  const [snapshots, setSnapshots] = useState([])
  const [doStatus, setDoStatus] = useState(null)
  const [initiaStatus, setInitiaStatus] = useState(null)
  const [modifications, setModifications] = useState([])

  const [personaMd, setPersonaMd] = useState('')
  const [personaBusy, setPersonaBusy] = useState(false)

  const [depositAmount, setDepositAmount] = useState('0.01')
  const [withdrawAmount, setWithdrawAmount] = useState('0.01')
  const [initiaBusy, setInitiaBusy] = useState('')
  const [initiaError, setInitiaError] = useState('')

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionBusy, setActionBusy] = useState('')
  const [analyzeBusy, setAnalyzeBusy] = useState(false)

  const [expandedDecisionIds, setExpandedDecisionIds] = useState(() => new Set())
  const [expandedTradeIds, setExpandedTradeIds] = useState(() => new Set())

  const isInitiaAgent = (agent?.chain ?? agent?.config?.chain) === 'initia'

  const openTrades = useMemo(() => trades.filter((trade) => trade.status === 'open'), [trades])
  const closedTrades = useMemo(() => trades.filter((trade) => trade.status !== 'open'), [trades])

  const realizedPnlUsd = useMemo(() => closedTrades.reduce((sum, trade) => sum + Number(trade.pnlUsd || 0), 0), [closedTrades])

  const totalPromptTokens = useMemo(() => decisions.reduce((sum, entry) => sum + Number(entry.llmPromptTokens || 0), 0), [decisions])
  const totalCompletionTokens = useMemo(() => decisions.reduce((sum, entry) => sum + Number(entry.llmCompletionTokens || 0), 0), [decisions])
  const totalTokens = totalPromptTokens + totalCompletionTokens

  const winRate = useMemo(() => {
    if (!closedTrades.length) return 0
    const wins = closedTrades.filter((trade) => Number(trade.pnlPct || 0) > 0).length
    return (wins / closedTrades.length) * 100
  }, [closedTrades])

  const initiaWallet = initia.initiaAddress || initiaStatus?.state?.walletAddress || initiaStatus?.initiaWalletAddress || ''
  const initiaWalletBalanceWei = initia.walletBalanceWei || initiaStatus?.state?.walletBalanceWei || '0'
  const initiaVaultBalanceWei = initia.vaultBalanceWei || initiaStatus?.state?.vaultBalanceWei || '0'
  const initiaAutoSignOn = Boolean(initia.autoSignEnabled || initiaStatus?.state?.autoSignEnabled)

  const pendingModifications = useMemo(
    () => modifications.filter((item) => item.status === 'pending'),
    [modifications],
  )

  const loadInitiaStatus = useCallback(async () => {
    if (!id || !isInitiaAgent) return
    try {
      const status = await apiRequest(`/api/agents/${id}/initia/status`, { timeout: 20_000 })
      setInitiaStatus(status)
    } catch {
      // non-fatal
    }
  }, [id, isInitiaAgent])

  const syncInitiaStatus = useCallback(async (extraState = {}) => {
    if (!id || !isInitiaAgent) return

    await apiRequest(`/api/agents/${id}/initia/sync`, {
      method: 'POST',
      body: {
        state: {
          walletAddress: initia.initiaAddress || undefined,
          evmAddress: initia.walletEvmAddress || undefined,
          chainOk: initia.chainOk,
          existsOnchain: initia.agentExists,
          autoSignEnabled: initia.autoSignEnabled,
          walletBalanceWei: initia.walletBalanceWei || undefined,
          vaultBalanceWei: initia.vaultBalanceWei || undefined,
          contractAddress: CONTRACT_ADDRESS,
          lastTxHash: initia.lastTxHash || undefined,
          error: initia.error || undefined,
          ...extraState,
        },
      },
      timeout: 20_000,
    })

    await loadInitiaStatus()
  }, [id, initia.agentExists, initia.autoSignEnabled, initia.chainOk, initia.error, initia.initiaAddress, initia.lastTxHash, initia.vaultBalanceWei, initia.walletBalanceWei, initia.walletEvmAddress, isInitiaAgent, loadInitiaStatus])

  const loadAll = useCallback(async () => {
    if (!id) return
    setLoading(true)
    setError('')

    try {
      const [agentData, tradesData, decisionsData, perfData, personaData, modData, statusData] = await Promise.all([
        apiRequest(`/api/agents/${id}`),
        apiRequest(`/api/agents/${id}/trades`),
        apiRequest(`/api/agents/${id}/decisions`),
        apiRequest(`/api/agents/${id}/performance`),
        apiRequest(`/api/agents/${id}/persona`).catch(() => ({ personaMd: '' })),
        apiRequest(`/api/agents/${id}/self-modifications`).catch(() => ({ modifications: [] })),
        apiRequest(`/api/agents/${id}/status`).catch(() => null),
      ])

      setAgent(agentData)
      onAgentChanged?.(agentData)
      setTrades(tradesData?.trades ?? [])
      setDecisions(decisionsData?.decisions ?? [])
      setSnapshots(perfData?.snapshots ?? [])
      setPersonaMd(personaData?.personaMd ?? '')
      setModifications(modData?.modifications ?? [])
      setDoStatus(statusData)

      if ((agentData?.chain ?? agentData?.config?.chain) === 'initia') {
        await initia.refresh()
        await loadInitiaStatus()
        await syncInitiaStatus()
      }
    } catch (loadError) {
      setError(extractApiError(loadError))
    } finally {
      setLoading(false)
    }
  }, [id, initia, loadInitiaStatus, onAgentChanged, syncInitiaStatus])

  const reloadAnalysis = useCallback(async () => {
    if (!id) return
    const [tradesData, decisionsData, perfData, statusData] = await Promise.all([
      apiRequest(`/api/agents/${id}/trades`),
      apiRequest(`/api/agents/${id}/decisions`),
      apiRequest(`/api/agents/${id}/performance`),
      apiRequest(`/api/agents/${id}/status`).catch(() => null),
    ])
    setTrades(tradesData?.trades ?? [])
    setDecisions(decisionsData?.decisions ?? [])
    setSnapshots(perfData?.snapshots ?? [])
    setDoStatus(statusData)
  }, [id])

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  const runAgentAction = async (name, action) => {
    setActionBusy(name)
    setError('')
    try {
      await action()
      await loadAll()
    } catch (actionError) {
      setError(extractApiError(actionError))
    } finally {
      setActionBusy('')
    }
  }

  const runInitiaAction = async (name, action) => {
    setInitiaBusy(name)
    setInitiaError('')
    try {
      const result = await action()
      await initia.refresh()
      await syncInitiaStatus({ lastTxHash: result?.txHash || undefined })
      await reloadAnalysis()
    } catch (actionError) {
      const message = extractApiError(actionError)
      setInitiaError(message)
      try {
        await syncInitiaStatus({ error: message })
      } catch {
        // ignore sync failures here
      }
    } finally {
      setInitiaBusy('')
    }
  }

  const handleAnalyze = async () => {
    if (!id) return
    setAnalyzeBusy(true)
    setError('')
    try {
      await apiRequest(`/api/agents/${id}/analyze`, {
        method: 'POST',
        timeout: 10 * 60_000,
      })
      await reloadAnalysis()
    } catch (analyzeError) {
      setError(extractApiError(analyzeError))
    } finally {
      setAnalyzeBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!id) return
    if (!window.confirm('Delete this agent?')) return

    await runAgentAction('delete', async () => {
      await apiRequest(`/api/agents/${id}`, { method: 'DELETE' })
      onAgentDeleted?.()
      navigate('/connect', { replace: true })
    })
  }

  const savePersona = async () => {
    if (!id) return
    setPersonaBusy(true)
    setError('')
    try {
      const response = await apiRequest(`/api/agents/${id}/persona`, {
        method: 'PUT',
        body: { personaMd },
      })
      setPersonaMd(response?.personaMd ?? personaMd)
    } catch (personaError) {
      setError(extractApiError(personaError))
    } finally {
      setPersonaBusy(false)
    }
  }

  const resetPersona = async () => {
    if (!id) return
    setPersonaBusy(true)
    setError('')
    try {
      const response = await apiRequest(`/api/agents/${id}/persona/reset`, { method: 'POST' })
      setPersonaMd(response?.personaMd ?? '')
    } catch (personaError) {
      setError(extractApiError(personaError))
    } finally {
      setPersonaBusy(false)
    }
  }

  const closeTrade = async (tradeId) => {
    await runAgentAction(`close:${tradeId}`, async () => {
      await apiRequest(`/api/trades/${tradeId}/close`, { method: 'POST' })
    })
  }

  const approveModification = async (modificationId) => {
    if (!id) return
    await runAgentAction(`approve:${modificationId}`, async () => {
      await apiRequest(`/api/agents/${id}/self-modifications/${modificationId}/approve`, { method: 'POST' })
    })
  }

  const rejectModification = async (modificationId) => {
    if (!id) return
    await runAgentAction(`reject:${modificationId}`, async () => {
      await apiRequest(`/api/agents/${id}/self-modifications/${modificationId}/reject`, { method: 'POST' })
    })
  }

  const toggleDecision = (decisionId) => {
    setExpandedDecisionIds((prev) => {
      const next = new Set(prev)
      if (next.has(decisionId)) next.delete(decisionId)
      else next.add(decisionId)
      return next
    })
  }

  const toggleTrade = (tradeId) => {
    setExpandedTradeIds((prev) => {
      const next = new Set(prev)
      if (next.has(tradeId)) next.delete(tradeId)
      else next.add(tradeId)
      return next
    })
  }

  if (loading) {
    return (
      <section className="panel">
        <h1 className="title">Loading Agent...</h1>
      </section>
    )
  }

  if (error && !agent) {
    return (
      <section className="panel stack-md">
        <h1 className="title">Agent Load Failed</h1>
        <div className="error-banner">{error}</div>
        <button type="button" className="btn btn-primary" onClick={() => void loadAll()}>Retry</button>
      </section>
    )
  }

  const latestSnapshot = snapshots[0]

  return (
    <section className="stack-lg">
      <div className="panel stack-md">
        <div className="row-wrap row-space">
          <div>
            <h1 className="title">{agent?.name}</h1>
            <p className="muted mono">{agent?.llmModel} · interval {agent?.config?.analysisInterval || '—'} · status {agent?.status}</p>
          </div>

          <div className="row-wrap">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => navigate('/agents/create')}>Edit Setup</button>
            <button type="button" className="btn btn-primary btn-sm" disabled={analyzeBusy} onClick={handleAnalyze}>
              {analyzeBusy ? 'Analyzing...' : 'Run Analysis'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={actionBusy === 'start'} onClick={() => runAgentAction('start', () => apiRequest(`/api/agents/${id}/start`, { method: 'POST' }))}>Start</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={actionBusy === 'pause'} onClick={() => runAgentAction('pause', () => apiRequest(`/api/agents/${id}/pause`, { method: 'POST' }))}>Pause</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={actionBusy === 'stop'} onClick={() => runAgentAction('stop', () => apiRequest(`/api/agents/${id}/stop`, { method: 'POST' }))}>Stop</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={actionBusy === 'reset'} onClick={() => runAgentAction('reset', () => apiRequest(`/api/agents/${id}/reset`, { method: 'POST' }))}>Reset</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={actionBusy === 'clear'} onClick={() => runAgentAction('clear', () => apiRequest(`/api/agents/${id}/history/clear`, { method: 'POST' }))}>Clear History</button>
            <button type="button" className="btn btn-danger btn-sm" disabled={actionBusy === 'delete'} onClick={handleDelete}>Delete</button>
          </div>
        </div>

        <div className="stats-grid">
          <div className="status-item"><div className="status-label">Balance</div><div className="status-value">{formatUsd(latestSnapshot?.balance ?? agent?.config?.paperBalance ?? 0, 0)}</div></div>
          <div className="status-item"><div className="status-label">Win Rate</div><div className="status-value">{winRate.toFixed(1)}%</div></div>
          <div className="status-item"><div className="status-label">Realized P&L</div><div className="status-value">{formatUsd(realizedPnlUsd, 0)}</div></div>
          <div className="status-item"><div className="status-label">Next Alarm</div><div className="status-value mono">{doStatus?.nextAlarmAt ? timeAgo(new Date(doStatus.nextAlarmAt).toISOString()) : '—'}</div></div>
        </div>
      </div>

      {isInitiaAgent && (
        <>
          <div className="panel stack-md">
            <h2 className="section-title">Initia Wallet</h2>
            <div className="row-wrap">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={Boolean(initiaBusy)}
                onClick={() => runInitiaAction('connectWallet', async () => {
                  if (initiaWallet) await initia.openWallet()
                  else await initia.openConnect()
                  return {}
                })}
              >
                {initiaBusy === 'connectWallet' ? 'Opening...' : initiaWallet ? 'Manage Wallet' : 'Connect Wallet'}
              </button>
              <span className="mono muted-small">{initiaWallet || 'not connected'}</span>
            </div>
          </div>

          <div className="panel stack-md">
            <h2 className="section-title">Vault</h2>
            <div className="status-grid">
              <div className="status-item"><div className="status-label">Wallet</div><div className="status-value mono">{safeFormatEther(initiaWalletBalanceWei)} GAS</div></div>
              <div className="status-item"><div className="status-label">Vault</div><div className="status-value mono">{safeFormatEther(initiaVaultBalanceWei)} GAS</div></div>
              <div className="status-item"><div className="status-label">AutoSign</div><div className="status-value">{initiaAutoSignOn ? 'enabled' : 'disabled'}</div></div>
              <div className="status-item"><div className="status-label">Last Sync</div><div className="status-value">{initiaStatus?.lastSyncedAt ? timeAgo(initiaStatus.lastSyncedAt) : '—'}</div></div>
            </div>

            <div className="row-wrap">
              <input value={depositAmount} onChange={(event) => setDepositAmount(event.target.value)} type="number" min="0" step="0.01" className="input-inline" />
              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(initiaBusy)} onClick={() => runInitiaAction('deposit', () => initia.deposit(depositAmount || '0'))}>
                {initiaBusy === 'deposit' ? 'Depositing...' : 'Deposit'}
              </button>

              <input value={withdrawAmount} onChange={(event) => setWithdrawAmount(event.target.value)} type="number" min="0" step="0.01" className="input-inline" />
              <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(initiaBusy)} onClick={() => runInitiaAction('withdraw', () => initia.withdraw(withdrawAmount || '0'))}>
                {initiaBusy === 'withdraw' ? 'Withdrawing...' : 'Withdraw'}
              </button>
            </div>

            <div className="row-wrap">
              {!initiaAutoSignOn ? (
                <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(initiaBusy)} onClick={() => runInitiaAction('enableAutoSign', () => initia.enableAutoSign())}>
                  {initiaBusy === 'enableAutoSign' ? 'Enabling...' : 'Enable AutoSign'}
                </button>
              ) : (
                <button type="button" className="btn btn-ghost btn-sm" disabled={Boolean(initiaBusy)} onClick={() => runInitiaAction('disableAutoSign', () => initia.disableAutoSign())}>
                  {initiaBusy === 'disableAutoSign' ? 'Disabling...' : 'Disable AutoSign'}
                </button>
              )}

              <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(initiaBusy)} onClick={() => runInitiaAction('executeTick', () => initia.executeTick())}>
                {initiaBusy === 'executeTick' ? 'Executing...' : 'Execute Tick'}
              </button>
            </div>

            {(initiaError || initia.error || initiaStatus?.state?.error) && (
              <div className="error-banner">{initiaError || initia.error || initiaStatus?.state?.error}</div>
            )}
          </div>
        </>
      )}

      <div className="panel stack-md">
        <h2 className="section-title">Persona</h2>
        <textarea rows={8} value={personaMd} onChange={(event) => setPersonaMd(event.target.value)} />
        <div className="row-wrap">
          <button type="button" className="btn btn-primary btn-sm" disabled={personaBusy} onClick={savePersona}>{personaBusy ? 'Saving...' : 'Save Persona'}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={personaBusy} onClick={resetPersona}>Reset Persona</button>
        </div>
      </div>

      {pendingModifications.length > 0 && (
        <div className="panel stack-md">
          <h2 className="section-title">Pending Self-Modifications ({pendingModifications.length})</h2>
          {pendingModifications.map((modification) => (
            <article key={modification.id} className="subpanel stack-sm">
              <div className="mono">{modification.reason}</div>
              <pre className="code-block">{JSON.stringify(modification.changes, null, 2)}</pre>
              <div className="row-wrap">
                <button type="button" className="btn btn-primary btn-sm" onClick={() => approveModification(modification.id)}>Approve</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => rejectModification(modification.id)}>Reject</button>
              </div>
            </article>
          ))}
        </div>
      )}

      <div className="panel stack-md">
        <h2 className="section-title">Decisions Log ({decisions.length})</h2>

        {!decisions.length && <p className="muted">No decisions yet.</p>}

        {decisions.map((decision) => {
          const sections = splitAgentPromptSections(decision.llmPromptText)
          const expanded = expandedDecisionIds.has(decision.id)
          return (
            <article key={decision.id} className="subpanel stack-sm">
              <div className="row-wrap row-space">
                <div className="row-wrap">
                  <span className={`badge badge-${decision.decision}`}>{decision.decision}</span>
                  <span className="mono">{(Number(decision.confidence || 0) * 100).toFixed(0)}%</span>
                  <span className="muted-small">{decision.llmModel}</span>
                </div>
                <span className="muted-small">{timeAgo(decision.createdAt)}</span>
              </div>

              <p>{decision.reasoning}</p>

              <div className="row-wrap">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleDecision(decision.id)}>
                  {expanded ? 'Hide Details' : 'Show Details'}
                </button>
                <span className="muted-small mono">{Number(decision.llmPromptTokens || 0)}↑ / {Number(decision.llmCompletionTokens || 0)}↓</span>
              </div>

              {expanded && (
                <div className="stack-sm">
                  <details>
                    <summary>Prompt: System</summary>
                    <pre className="code-block">{sections.system}</pre>
                  </details>
                  <details>
                    <summary>Prompt: Market Data</summary>
                    <pre className="code-block">{sections.marketData}</pre>
                  </details>
                  <details>
                    <summary>Prompt: Editable Setup</summary>
                    <pre className="code-block">{sections.editableSetup}</pre>
                  </details>
                  {decision.llmRawResponse && (
                    <details>
                      <summary>Raw Response</summary>
                      <pre className="code-block">{formatJson(decision.llmRawResponse)}</pre>
                    </details>
                  )}
                </div>
              )}
            </article>
          )
        })}

        {decisions.length > 0 && (
          <div className="status-grid">
            <div className="status-item"><div className="status-label">Prompt Tokens</div><div className="status-value mono">{totalPromptTokens.toLocaleString()}</div></div>
            <div className="status-item"><div className="status-label">Completion Tokens</div><div className="status-value mono">{totalCompletionTokens.toLocaleString()}</div></div>
            <div className="status-item"><div className="status-label">Total Tokens</div><div className="status-value mono">{totalTokens.toLocaleString()}</div></div>
          </div>
        )}
      </div>

      <div className="panel stack-md">
        <h2 className="section-title">Trades ({trades.length})</h2>

        {!trades.length && <p className="muted">No trades yet.</p>}

        {trades.map((trade) => {
          const expanded = expandedTradeIds.has(trade.id)
          const marketSnapshot = parseSnapshot(decisions.find((entry) => entry.marketDataSnapshot)?.marketDataSnapshot)
          const market = marketSnapshot.find((entry) => entry.pair === trade.pair)
          return (
            <article key={trade.id} className="subpanel stack-sm">
              <div className="row-wrap row-space">
                <div className="row-wrap">
                  <span className="mono">{trade.pair}</span>
                  <span className={`badge badge-${trade.side}`}>{trade.side}</span>
                  <span className="muted-small">{trade.status}</span>
                </div>
                <span className="muted-small">{formatDateTime(trade.openedAt)}</span>
              </div>

              <div className="status-grid">
                <div className="status-item"><div className="status-label">Entry</div><div className="status-value mono">{formatUsd(trade.entryPrice, 4)}</div></div>
                <div className="status-item"><div className="status-label">Size</div><div className="status-value mono">{formatUsd(trade.amountUsd, 2)}</div></div>
                <div className="status-item"><div className="status-label">P&L</div><div className="status-value mono">{trade.status === 'open' && market ? formatPct(((market.priceUsd - trade.entryPrice) / trade.entryPrice) * 100, 2) : formatPct(Number(trade.pnlPct || 0), 2)}</div></div>
                <div className="status-item"><div className="status-label">Confidence</div><div className="status-value mono">{(Number(trade.confidenceBefore || 0) * 100).toFixed(0)}%</div></div>
              </div>

              <div className="row-wrap">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => toggleTrade(trade.id)}>
                  {expanded ? 'Hide Reasoning' : 'Show Reasoning'}
                </button>
                {trade.status === 'open' && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={actionBusy === `close:${trade.id}`} onClick={() => closeTrade(trade.id)}>
                    {actionBusy === `close:${trade.id}` ? 'Closing...' : 'Close Trade'}
                  </button>
                )}
              </div>

              {expanded && <pre className="code-block">{trade.reasoning}</pre>}
            </article>
          )
        })}
      </div>

      <div className="panel stack-md">
        <h2 className="section-title">Performance ({snapshots.length})</h2>
        {!snapshots.length && <p className="muted">No performance snapshots yet.</p>}

        {snapshots.map((snapshot) => (
          <article key={snapshot.id} className="subpanel">
            <div className="row-wrap row-space">
              <span className="mono">{formatDateTime(snapshot.snapshotAt)}</span>
              <span className="mono">{formatUsd(snapshot.balance, 2)}</span>
            </div>
            <div className="row-wrap">
              <span className="muted-small">Total P&L: {formatPct(Number(snapshot.totalPnlPct || 0), 2)}</span>
              <span className="muted-small">Win Rate: {Number(snapshot.winRate || 0).toFixed(1)}%</span>
              <span className="muted-small">Trades: {snapshot.totalTrades}</span>
            </div>
          </article>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
    </section>
  )
}
