import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pollAnalysis, signJob, submitAnalysis, verifyJob } from './analysis-jobs'

const owner = { id: 'device-a', user_id: 'owner-a' }
const endpoint = 'https://api.runpod.ai/v2/endpoint'
beforeEach(() => {
  vi.stubEnv('SELF_HOSTED_MODEL_URL', endpoint + '/openai/v1')
  vi.stubEnv('SELF_HOSTED_MODEL_NAME', 'vision-model')
  vi.stubEnv('SELF_HOSTED_API_KEY', 'test-model-key')
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-signing-key')
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('Runpod screenshot jobs', () => {
  it('submits once and retrieves the same queued job through completion', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ id: 'job-1', status: 'IN_QUEUE' }))
      .mockResolvedValueOnce(Response.json({ id: 'job-1', status: 'IN_PROGRESS' }))
      .mockResolvedValueOnce(Response.json({ id: 'job-1', status: 'COMPLETED', output: [{ choices: [{ message: { content: '{"title":"Review"}' } }] }] }))
    vi.stubGlobal('fetch', fetcher)
    const queued = await submitAnalysis([{ role: 'user', content: 'test screenshot batch' }], owner)
    expect(queued).toMatchObject({ pending: true, status: 'IN_QUEUE' })
    if (!('job' in queued) || typeof queued.job !== 'string') throw new Error('Expected pending job')
    expect(await pollAnalysis(queued.job, owner)).toMatchObject({ pending: true })
    expect(await pollAnalysis(queued.job, owner)).toMatchObject({ choices: [{ message: { content: '{"title":"Review"}' } }] })
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([endpoint + '/run', endpoint + '/status/job-1', endpoint + '/status/job-1'])
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ input: { openai_route: '/v1/chat/completions', openai_input: { model: 'vision-model', stream: false } } })
  })
  it('rejects other accounts, other devices, forged and expired receipts before HTTP', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    const ticket = signJob('job-1', owner, endpoint)
    expect(() => verifyJob(ticket, { ...owner, user_id: 'other' })).toThrow()
    expect(() => verifyJob(ticket, { ...owner, id: 'other' })).toThrow()
    expect(() => verifyJob(ticket + 'x', owner)).toThrow()
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_600_001)
    await expect(pollAnalysis(ticket, owner)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('does not treat worker failures or empty output as observations', async () => {
    const ticket = signJob('job-1', owner, endpoint)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ status: 'COMPLETED', output: [{ error: { message: 'model failed' } }] })))
    await expect(pollAnalysis(ticket, owner)).rejects.toThrow('no observation')
  })
})
