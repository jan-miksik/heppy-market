export function splitAgentPromptSections(promptText) {
  if (!promptText) return { system: '', marketData: '', editableSetup: '' }

  const portfolioIdx = promptText.indexOf('## Portfolio State')
  const roleIdx = promptText.indexOf('## Your Role')
  const behaviorIdx = promptText.indexOf('## Your Behavior Profile')
  const personaIdx = promptText.indexOf('## Your Persona')
  const constraintsIdx = promptText.indexOf('## Constraints')

  const system = portfolioIdx >= 0 ? promptText.slice(0, portfolioIdx).trim() : promptText.trim()

  const candidates = [roleIdx, behaviorIdx, personaIdx, constraintsIdx].filter((i) => i >= 0)
  const editableStart = candidates.length > 0 ? Math.min(...candidates) : -1
  const editableSetup = editableStart >= 0 ? promptText.slice(editableStart).trim() : ''

  const marketEnd = editableStart >= 0 ? editableStart : promptText.length
  const marketData = portfolioIdx >= 0 ? promptText.slice(portfolioIdx, marketEnd).trim() : ''

  return { system, marketData, editableSetup }
}

export function parseMarketPrices(marketDataSection) {
  const prices = {}
  let currentPair = ''

  for (const line of String(marketDataSection || '').split('\n')) {
    const pairMatch = line.match(/^### (.+)$/)
    if (pairMatch) currentPair = pairMatch[1]?.trim() ?? ''

    const priceMatch = line.match(/^Price: \$([0-9.]+)/)
    if (priceMatch && currentPair) {
      prices[currentPair] = Number.parseFloat(priceMatch[1] ?? '0')
    }
  }

  return prices
}

export function formatJson(value) {
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return String(value ?? '')
  }
}
