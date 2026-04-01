export function shortenAddress(address) {
  if (!address) return ''
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeAgo(iso) {
  if (!iso) return '—'
  const diffMs = Date.now() - new Date(iso).getTime()
  const seconds = Math.max(0, Math.floor(diffMs / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

export function formatUsd(value, digits = 2) {
  const amount = Number(value || 0)
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatPct(value, digits = 2) {
  const amount = Number(value || 0)
  const safe = Object.is(amount, -0) ? 0 : amount
  return `${safe >= 0 ? '+' : ''}${safe.toFixed(digits)}%`
}
