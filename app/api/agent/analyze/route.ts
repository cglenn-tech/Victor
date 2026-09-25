import { getDeviceFromToken } from '@/lib/device-auth'
import { chatCompletion, isModelConfigured, type ModelMessage } from '@/lib/model-client'
import { rateLimit } from '@/lib/rate-limit'

export const maxDuration = 60

export async function POST(request: Request) {
  const device = await getDeviceFromToken(request.headers.get('authorization'))
  if (!device) return Response.json({ error: 'Unauthorized' }, { status: 401 })
  if (!isModelConfigured()) return Response.json({ error: 'Vision service is not configured' }, { status: 503 })
  if (await rateLimit(`vision:${device.user_id}`, 20, 60)) return Response.json({ error: 'Try again shortly' }, { status: 429 })
  // Stay below typical serverless request limits. Never log or persist image bodies.
  const reader = request.body?.getReader()
  if (!reader) return Response.json({ error: 'Missing body' }, { status: 400 })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 3_800_000) {
        await reader.cancel()
        return Response.json({ error: 'Screenshot batch too large' }, { status: 413 })
      }
      chunks.push(value)
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const messages = body.messages as ModelMessage[]
    if (!Array.isArray(messages) || messages.length !== 1 || messages[0].role !== 'user') throw new Error()
    const content = messages[0].content
    if (!Array.isArray(content) || content.length < 2 || content.length > 6) throw new Error()
    let images = 0
    for (const part of content) {
      if (part.type === 'text') {
        if (typeof part.text !== 'string' || part.text.length > 30000) throw new Error()
      } else if (part.type === 'image_url') {
        if (!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(part.image_url?.url)) throw new Error()
        images++
      } else throw new Error()
    }
    if (!images || images > 5) throw new Error()
    try {
      const content = await chatCompletion(messages, { maxTokens: 1024, timeoutMs: 45_000, retries: 0 })
      return Response.json({ choices: [{ message: { content } }] }, { headers: { 'Cache-Control': 'no-store' } })
    } catch {
      return Response.json({ error: 'Vision service unavailable; please retry' }, { status: 502 })
    }
  } catch {
    return Response.json({ error: 'Invalid screenshot batch' }, { status: 400 })
  }
}
