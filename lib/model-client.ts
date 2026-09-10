// Self-hosted model client — the ONLY model caller in the web app.
// OpenAI-compatible chat completions endpoint, fully configured via env:
//   SELF_HOSTED_MODEL_URL   e.g. https://<pod-id>.runpod.ai/v2/<endpoint>/openai/v1
//   SELF_HOSTED_API_KEY    bearer token
//   SELF_HOSTED_MODEL_NAME model id served by the endpoint
// Swapping backends later only requires changing these env vars.

export type ModelMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export class ModelClientError extends Error {
  status?: number
  retryable: boolean

  constructor(message: string, opts: { status?: number; retryable?: boolean } = {}) {
    super(message)
    this.name = 'ModelClientError'
    this.status = opts.status
    this.retryable = opts.retryable ?? false
  }
}

function readConfig(): { baseUrl: string; apiKey: string; model: string } {
  const baseUrl = process.env.SELF_HOSTED_MODEL_URL
  const apiKey = process.env.SELF_HOSTED_API_KEY
  const model = process.env.SELF_HOSTED_MODEL_NAME

  if (!baseUrl || !apiKey || !model) {
    throw new ModelClientError(
      'model client not configured (SELF_HOSTED_MODEL_URL / SELF_HOSTED_API_KEY / SELF_HOSTED_MODEL_NAME)',
    )
  }

  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model }
}

export function isModelConfigured(): boolean {
  try {
    readConfig()
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export async function chatCompletion(
  messages: ModelMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; retries?: number } = {},
): Promise<string> {
  const { baseUrl, apiKey, model } = readConfig()
  const maxTokens = opts.maxTokens ?? 1024
  const timeoutMs = opts.timeoutMs ?? 30_000
  const retries = opts.retries ?? 2

  let lastError: ModelClientError = new ModelClientError('no attempt made')
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(1000 * 2 ** (attempt - 1), 8000)
      await sleep(backoff + Math.random() * 500)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.2,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500
        const err = new ModelClientError(`model endpoint returned ${res.status}`, {
          status: res.status,
          retryable,
        })
        if (retryable && attempt < retries) {
          lastError = err
          continue
        }
        throw err
      }

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
      }
      const choice = data.choices?.[0]?.message?.content
      const text =
        typeof choice === 'string'
          ? choice
          : Array.isArray(choice)
            ? choice.map((b) => b.text ?? '').join('')
            : ''

      if (!text.trim()) {
        const err = new ModelClientError('model returned empty content', { retryable: true })
        if (attempt < retries) {
          lastError = err
          continue
        }
        throw err
      }

      return text
    } catch (err) {
      if (err instanceof ModelClientError) {
        if (err.retryable && attempt < retries) {
          lastError = err
          continue
        }
        throw err
      }
      // Network errors (incl. abort/timeout) are retryable
      lastError = new ModelClientError(
        err instanceof Error ? err.message : 'network error',
        { retryable: true },
      )
      if (attempt < retries) continue
      throw lastError
    } finally {
      clearTimeout(timer)
    }
  }

  throw lastError
}

// Strips markdown fences and parses JSON. Throws ModelClientError on bad JSON.
export function extractJSON(raw: string): unknown {
  let text = raw.trim()
  if (text.startsWith('```')) {
    const parts = text.split('```')
    if (parts.length >= 2) {
      text = parts[1]
      if (text.startsWith('json')) text = text.slice(4)
      text = text.trim()
    }
  }

  try {
    return JSON.parse(text)
  } catch {
    throw new ModelClientError('model returned non-JSON content')
  }
}

export async function chatJSON(
  messages: ModelMessage[],
  opts: { maxTokens?: number; timeoutMs?: number; retries?: number } = {},
): Promise<unknown> {
  const raw = await chatCompletion(messages, opts)
  return extractJSON(raw)
}
