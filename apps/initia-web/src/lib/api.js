const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8787'
const DEFAULT_TIMEOUT_MS = 15_000

export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
  }
}

async function parseResponseBody(response) {
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json')) {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  try {
    const text = await response.text()
    return text ? { message: text } : null
  } catch {
    return null
  }
}

export function extractApiError(error) {
  if (!error) return 'Unknown error'
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unexpected request failure'
}

export async function apiRequest(path, options = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeout = DEFAULT_TIMEOUT_MS,
    credentials = 'include',
    signal,
  } = options

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), timeout)

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true })
  }

  let payload = body
  const nextHeaders = { ...headers }

  if (body && typeof body === 'object' && !(body instanceof FormData) && typeof body !== 'string') {
    payload = JSON.stringify(body)
    if (!nextHeaders['Content-Type']) {
      nextHeaders['Content-Type'] = 'application/json'
    }
  }

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials,
      headers: nextHeaders,
      body: payload,
      signal: controller.signal,
    })

    const data = await parseResponseBody(response)

    if (!response.ok) {
      const message = data?.error || data?.message || `Request failed (${response.status})`
      throw new ApiError(message, response.status, data)
    }

    return data
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (error?.name === 'AbortError') throw new ApiError('Request timed out', 408)
    throw new ApiError(extractApiError(error), 0)
  } finally {
    clearTimeout(timeoutId)
  }
}

export { API_BASE }
