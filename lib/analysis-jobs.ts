import { createHmac, timingSafeEqual } from 'node:crypto'
import { readConfig, type ModelMessage } from './model-client'

type Owner = { id: string; user_id: string }
type Ticket = { id: string; device: string; owner: string; endpoint: string; expires: number }
type Job = { id?: string; status?: string; output?: unknown; error?: unknown }

export function runpodEndpoint(): string | null {
  const { baseUrl } = readConfig()
  const match = /^https:\/\/api\.runpod\.ai\/v2\/([a-zA-Z0-9_-]+)(?:\/openai\/v1)?$/.exec(baseUrl)
  return match ? `https://api.runpod.ai/v2/${match[1]}` : null
}

function signature(value: string): Buffer {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!key) throw new Error('Analysis job signing is unavailable')
  return createHmac('sha256', key).update('victor-analysis-job-v1:' + value).digest()
}

export function signJob(id: string, device: Owner, endpoint: string): string {
  const ticket: Ticket = { id, device: device.id, owner: device.user_id, endpoint, expires: Date.now() + 3_600_000 }
  const payload = Buffer.from(JSON.stringify(ticket)).toString('base64url')
  return `${payload}.${signature(payload).toString('base64url')}`
}

export function verifyJob(value: string, device: Owner): Ticket {
  if (value.length > 2000) throw new Error('Invalid job')
  const [payload, mac, extra] = value.split('.')
  if (!payload || !mac || extra) throw new Error('Invalid job')
  const actual = Buffer.from(mac, 'base64url'), expected = signature(payload)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('Invalid job')
  const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Ticket
  if (ticket.device !== device.id || ticket.owner !== device.user_id || ticket.endpoint !== runpodEndpoint() ||
      !Number.isFinite(ticket.expires) || ticket.expires < Date.now() || !/^[a-zA-Z0-9_-]+$/.test(ticket.id)) throw new Error('Invalid or expired job')
  return ticket
}

async function request(url: string, body?: unknown): Promise<Job> {
  const { apiKey } = readConfig()
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000), cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Analysis service returned ${response.status}`)
  return response.json()
}

function result(job: Job, ticket: string) {
  if (job.status === 'IN_QUEUE' || job.status === 'IN_PROGRESS') return { pending: true, job: ticket, status: job.status }
  if (job.status !== 'COMPLETED' || job.error) throw new Error('Analysis job failed')
  const outputs = Array.isArray(job.output) ? job.output : [job.output]
  for (const output of outputs) {
    const data = output as { choices?: Array<{ message?: { content?: unknown } }> } | undefined
    const content = data?.choices?.[0]?.message?.content
    if (typeof content === 'string' && content.trim()) return { choices: [{ message: { content } }] }
  }
  throw new Error('Analysis job returned no observation')
}

export async function submitAnalysis(messages: ModelMessage[], device: Owner) {
  const endpoint = runpodEndpoint()
  if (!endpoint) throw new Error('Not a Runpod queue endpoint')
  // Validate the signing configuration before submitting any paid work.
  signature('check')
  const { model } = readConfig()
  const job = await request(`${endpoint}/run`, {
    input: { openai_route: '/v1/chat/completions', openai_input: {
      model, messages, max_tokens: 1024, temperature: 0.2, stream: false,
      chat_template_kwargs: { enable_thinking: false },
    } },
    policy: { executionTimeout: 300_000, ttl: 3_600_000 },
  })
  if (!job.id || !/^[a-zA-Z0-9_-]+$/.test(job.id)) throw new Error('Analysis service returned no job ID')
  return result(job, signJob(job.id, device, endpoint))
}

export async function pollAnalysis(value: string, device: Owner) {
  const ticket = verifyJob(value, device)
  return result(await request(`${ticket.endpoint}/status/${ticket.id}`), value)
}
