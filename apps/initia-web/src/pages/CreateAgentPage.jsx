import { useEffect, useMemo, useState } from 'react'
import { keccak256 } from 'viem'
import {
  AGENT_ROLE_SECTION,
  BASE_AGENT_PROMPT,
  ENTITY_NAME_MAX_CHARS,
  buildAgentModelCatalog,
  buildBehaviorSection,
  buildConstraintsSection,
  buildJsonSchemaInstruction,
  getAgentPersonaTemplate,
  resolveAgentProfileId,
} from '@something-in-loop/shared'

import { CONTRACT_ADDRESS } from '../chain.js'
import { apiRequest, extractApiError } from '../lib/api.js'
import { AVAILABLE_PAIRS, createDefaultAgentForm } from '../lib/agent-defaults.js'

function shortModelName(modelId) {
  if (!modelId) return 'Agent'
  return modelId.split('/').pop()?.split(':')[0] ?? modelId
}

export default function CreateAgentPage({ initia, user, onCreated }) {
  const [form, setForm] = useState(() => createDefaultAgentForm())
  const [autoName, setAutoName] = useState(true)
  const [profileOptions, setProfileOptions] = useState([])
  const [behaviorJson, setBehaviorJson] = useState(() => JSON.stringify(createDefaultAgentForm().behavior, null, 2))
  const [stage, setStage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [showPromptPreview, setShowPromptPreview] = useState(false)

  const hasOwnKey = Boolean(user?.openRouterKeySet)
  const isTester = user?.role === 'tester'

  const modelCatalog = useMemo(() => buildAgentModelCatalog({ hasOwnOpenRouterKey: hasOwnKey, isTester }), [hasOwnKey, isTester])

  useEffect(() => {
    let cancelled = false
    const loadProfiles = async () => {
      try {
        const data = await apiRequest('/api/profiles?type=agent')
        if (cancelled) return
        const profiles = Array.isArray(data?.profiles) ? data.profiles : []
        setProfileOptions(profiles)

        if (!profiles.length) return
        const defaultProfile = profiles[0]
        setForm((prev) => {
          const nextProfileId = resolveAgentProfileId(defaultProfile.id)
          const nextPersona = getAgentPersonaTemplate(nextProfileId, prev.name || 'Agent')
          const nextBehavior = defaultProfile.behaviorConfig || prev.behavior
          setBehaviorJson(JSON.stringify(nextBehavior, null, 2))
          return {
            ...prev,
            profileId: nextProfileId,
            personaMd: prev.personaMd || nextPersona,
            behavior: nextBehavior,
          }
        })
      } catch {
        // non-fatal; profile picker is optional
      }
    }

    void loadProfiles()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!autoName) return
    const pairPart = form.pairs.length === 1 ? form.pairs[0] : `${form.pairs[0]} +${Math.max(form.pairs.length - 1, 0)}`
    const profileName = profileOptions.find((p) => resolveAgentProfileId(p.id) === form.profileId)?.name
    const generated = [shortModelName(form.llmModel), pairPart, profileName].filter(Boolean).join(' · ')
    setForm((prev) => ({ ...prev, name: generated.slice(0, ENTITY_NAME_MAX_CHARS) }))
  }, [autoName, form.llmModel, form.pairs, form.profileId, profileOptions])

  const liveBehaviorSection = useMemo(() => {
    if (form.behaviorMd?.trim()) return form.behaviorMd.trim()
    return buildBehaviorSection(form.behavior)
  }, [form.behavior, form.behaviorMd])

  const liveRoleSection = useMemo(() => {
    if (form.roleMd?.trim()) return form.roleMd.trim()
    return AGENT_ROLE_SECTION
  }, [form.roleMd])

  const liveConstraintSection = useMemo(() => buildConstraintsSection({
    pairs: form.pairs,
    maxPositionSizePct: form.maxPositionSizePct,
    maxOpenPositions: form.maxOpenPositions,
    stopLossPct: form.stopLossPct,
    takeProfitPct: form.takeProfitPct,
  }), [form.maxOpenPositions, form.maxPositionSizePct, form.pairs, form.stopLossPct, form.takeProfitPct])

  const livePromptPreview = useMemo(() => {
    return [
      `${BASE_AGENT_PROMPT}${buildJsonSchemaInstruction()}`,
      '---',
      liveRoleSection,
      liveBehaviorSection,
      form.personaMd?.trim() ? `## Your Persona\n${form.personaMd.trim()}` : '',
      liveConstraintSection,
    ].filter(Boolean).join('\n\n')
  }, [form.personaMd, liveBehaviorSection, liveConstraintSection, liveRoleSection])

  const togglePair = (pair) => {
    setForm((prev) => {
      const exists = prev.pairs.includes(pair)
      const nextPairs = exists ? prev.pairs.filter((entry) => entry !== pair) : [...prev.pairs, pair]
      return { ...prev, pairs: nextPairs }
    })
  }

  const handleProfileChange = (profileIdRaw) => {
    const normalized = resolveAgentProfileId(profileIdRaw)
    const profile = profileOptions.find((item) => resolveAgentProfileId(item.id) === normalized)
    setForm((prev) => {
      const nextBehavior = profile?.behaviorConfig || prev.behavior
      const nextPersona = getAgentPersonaTemplate(normalized, prev.name || 'Agent')
      setBehaviorJson(JSON.stringify(nextBehavior, null, 2))
      return {
        ...prev,
        profileId: normalized,
        behavior: nextBehavior,
        personaMd: nextPersona,
      }
    })
  }

  const onNumberInput = (key, value) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return
    setForm((prev) => ({ ...prev, [key]: numeric }))
  }

  const buildPayload = () => {
    let parsedBehavior = form.behavior
    try {
      parsedBehavior = JSON.parse(behaviorJson)
    } catch {
      throw new Error('Behavior JSON is invalid. Fix syntax before creating the agent.')
    }

    if (!initia.initiaAddress) {
      throw new Error('Connect your Initia wallet first.')
    }

    if (!form.name.trim()) {
      throw new Error('Agent name is required.')
    }

    if (form.name.length > ENTITY_NAME_MAX_CHARS) {
      throw new Error(`Agent name must be at most ${ENTITY_NAME_MAX_CHARS} characters.`)
    }

    if (!form.pairs.length) {
      throw new Error('Select at least one trading pair.')
    }

    return {
      ...form,
      chain: 'initia',
      initiaWalletAddress: initia.initiaAddress,
      behavior: parsedBehavior,
      personaMd: form.personaMd || undefined,
      behaviorMd: form.behaviorMd || undefined,
      roleMd: form.roleMd || undefined,
      profileId: form.profileId || undefined,
    }
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setBusy(true)
    setError('')
    setStage('Creating backend agent...')

    try {
      await initia.refresh()
      const payload = buildPayload()
      const createdAgent = await apiRequest('/api/agents', {
        method: 'POST',
        body: payload,
      })

      const metadataPointer = {
        agentId: createdAgent.id,
        version: 1,
        configHash: keccak256(new TextEncoder().encode(JSON.stringify({
          chain: 'initia',
          name: payload.name,
          pairs: payload.pairs,
          strategies: payload.strategies,
          analysisInterval: payload.analysisInterval,
          llmModel: payload.llmModel,
        }))),
        labels: {
          mode: 'hackathon',
          name: payload.name,
        },
      }

      setStage('Creating onchain agent...')
      const onchain = await initia.createAgentOnchain(metadataPointer)
      if (!onchain?.txHash) {
        throw new Error('Onchain createAgent did not return a transaction hash.')
      }

      setStage('Linking backend and onchain state...')
      await apiRequest(`/api/agents/${createdAgent.id}/initia/link`, {
        method: 'POST',
        body: {
          initiaWalletAddress: initia.initiaAddress,
          evmAddress: initia.walletEvmAddress || undefined,
          txHash: onchain.txHash,
          metadataPointer,
        },
      })

      await apiRequest(`/api/agents/${createdAgent.id}/initia/sync`, {
        method: 'POST',
        body: {
          state: {
            walletAddress: initia.initiaAddress || undefined,
            evmAddress: initia.walletEvmAddress || undefined,
            chainOk: initia.chainOk,
            existsOnchain: true,
            autoSignEnabled: initia.autoSignEnabled,
            walletBalanceWei: initia.walletBalanceWei || undefined,
            vaultBalanceWei: initia.vaultBalanceWei || undefined,
            contractAddress: CONTRACT_ADDRESS,
            lastTxHash: onchain.txHash,
          },
        },
      })

      await onCreated(createdAgent)
    } catch (submitError) {
      const message = extractApiError(submitError)
      if (submitError?.status === 409) {
        setError('This Initia wallet already has an agent. Open the existing agent detail page instead of creating another one.')
      } else {
        setError(message)
      }
    } finally {
      setBusy(false)
      setStage('')
    }
  }

  return (
    <section className="stack-lg">
      <div className="panel">
        <h1 className="title">Create Agent</h1>
        <p className="muted">Full setup form for Initia agent configuration. Rich config stays on backend; onchain stores compact pointer metadata.</p>
      </div>

      <form className="panel stack-lg" onSubmit={handleSubmit}>
        <div className="grid-2">
          <label className="field">
            <span>Agent Name</span>
            <input
              value={form.name}
              maxLength={ENTITY_NAME_MAX_CHARS}
              onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            />
            <small>{form.name.length}/{ENTITY_NAME_MAX_CHARS}</small>
          </label>

          <label className="field checkbox">
            <input type="checkbox" checked={autoName} onChange={(event) => setAutoName(event.target.checked)} />
            <span>Auto-generate name from model/pairs/profile</span>
          </label>
        </div>

        <div className="field">
          <span>Pairs</span>
          <div className="row-wrap">
            {AVAILABLE_PAIRS.map((pair) => (
              <button
                key={pair}
                type="button"
                className={`chip ${form.pairs.includes(pair) ? 'chip-on' : ''}`}
                onClick={() => togglePair(pair)}
              >
                {pair}
              </button>
            ))}
          </div>
        </div>

        <div className="grid-3">
          <label className="field">
            <span>Analysis Interval</span>
            <select value={form.analysisInterval} onChange={(event) => setForm((prev) => ({ ...prev, analysisInterval: event.target.value }))}>
              <option value="1h">1h</option>
              <option value="4h">4h</option>
              <option value="1d">1d</option>
            </select>
          </label>

          <label className="field">
            <span>Paper Balance</span>
            <input type="number" min="100" value={form.paperBalance} onChange={(event) => onNumberInput('paperBalance', event.target.value)} />
          </label>

          <label className="field">
            <span>Temperature</span>
            <input type="number" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => onNumberInput('temperature', event.target.value)} />
          </label>
        </div>

        <div className="grid-4">
          <label className="field"><span>Max Position %</span><input type="number" min="1" max="100" value={form.maxPositionSizePct} onChange={(event) => onNumberInput('maxPositionSizePct', event.target.value)} /></label>
          <label className="field"><span>Stop Loss %</span><input type="number" min="0.5" max="50" step="0.1" value={form.stopLossPct} onChange={(event) => onNumberInput('stopLossPct', event.target.value)} /></label>
          <label className="field"><span>Take Profit %</span><input type="number" min="0.5" max="100" step="0.1" value={form.takeProfitPct} onChange={(event) => onNumberInput('takeProfitPct', event.target.value)} /></label>
          <label className="field"><span>Max Open Positions</span><input type="number" min="1" max="10" value={form.maxOpenPositions} onChange={(event) => onNumberInput('maxOpenPositions', event.target.value)} /></label>
        </div>

        <div className="grid-2">
          <label className="field">
            <span>Model</span>
            <select value={form.llmModel} onChange={(event) => setForm((prev) => ({ ...prev, llmModel: event.target.value }))}>
              {modelCatalog.map((item) => (
                <option key={item.id} value={item.id}>{item.label} ({item.id})</option>
              ))}
            </select>
          </label>

          <label className="field checkbox">
            <input
              type="checkbox"
              checked={Boolean(form.allowFallback)}
              onChange={(event) => setForm((prev) => ({ ...prev, allowFallback: event.target.checked }))}
            />
            <span>Allow fallback model</span>
          </label>
        </div>

        <div className="grid-2">
          <label className="field">
            <span>Profile</span>
            <select value={form.profileId || ''} onChange={(event) => handleProfileChange(event.target.value)}>
              <option value="">None</option>
              {profileOptions.map((profile) => (
                <option key={profile.id} value={profile.id}>{profile.emoji} {profile.name}</option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Strategy</span>
            <select value={form.strategies[0]} onChange={(event) => setForm((prev) => ({ ...prev, strategies: [event.target.value] }))}>
              <option value="combined">combined</option>
              <option value="ema_crossover">ema_crossover</option>
              <option value="rsi_oversold">rsi_oversold</option>
              <option value="macd_signal">macd_signal</option>
              <option value="bollinger_bounce">bollinger_bounce</option>
              <option value="volume_breakout">volume_breakout</option>
              <option value="llm_sentiment">llm_sentiment</option>
            </select>
          </label>
        </div>

        <label className="field">
          <span>Behavior JSON</span>
          <textarea rows={10} className="mono" value={behaviorJson} onChange={(event) => setBehaviorJson(event.target.value)} />
        </label>

        <label className="field">
          <span>Persona Markdown</span>
          <textarea rows={8} value={form.personaMd} onChange={(event) => setForm((prev) => ({ ...prev, personaMd: event.target.value }))} />
        </label>

        <label className="field">
          <span>Behavior Markdown Override</span>
          <textarea rows={8} value={form.behaviorMd} onChange={(event) => setForm((prev) => ({ ...prev, behaviorMd: event.target.value }))} />
        </label>

        <label className="field">
          <span>Role Markdown Override</span>
          <textarea rows={8} value={form.roleMd} onChange={(event) => setForm((prev) => ({ ...prev, roleMd: event.target.value }))} />
        </label>

        <div className="row-wrap">
          <button type="button" className="btn btn-ghost" onClick={() => setShowPromptPreview((value) => !value)}>
            {showPromptPreview ? 'Hide Prompt Preview' : 'Show Prompt Preview'}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !initia.initiaAddress}>
            {busy ? (stage || 'Creating...') : 'Create Agent'}
          </button>
        </div>

        {showPromptPreview && (
          <pre className="code-block">{livePromptPreview}</pre>
        )}

        {error && <div className="error-banner">{error}</div>}
      </form>
    </section>
  )
}
