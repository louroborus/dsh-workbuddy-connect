import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkIn, describeCheckIn, recordCheckIn, WORKBUDDY_CHECKIN_LOG_FILENAME } from '../src/checkin.ts'
import type { WorkBuddyCredential } from '../src/auth.ts'

/**
 * The check-in module must be safe to fire from a startup path: every outcome
 * resolves, "already claimed" is never a failure, and no path can leak the
 * token into a message.
 */

const CREDENTIAL: WorkBuddyCredential = {
  accessToken: 'token-abc.def-ghi',
  refreshToken: 'refresh-secret',
  expiresAtMs: Date.now() + 3_600_000,
  domain: 'www.workbuddy.cn',
  uid: 'uid-1',
  enterpriseId: 'ent-1',
  source: 'desktop',
}

/** A status document as the live service answers it for an unclaimed day. */
const NOT_CLAIMED = { code: 0, msg: 'OK', data: { active: true, today_checked_in: false } }

const ORIGINAL_FETCH = globalThis.fetch

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH
  vi.restoreAllMocks()
})

/** Route the two calls by URL suffix and record what was requested. */
function stubFetch(routes: Record<string, () => Response>): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    seen.push(url)
    const suffix = Object.keys(routes).find(key => url.endsWith(key))
    if (suffix === undefined) throw new Error(`unexpected url ${url}`)
    return routes[suffix]!()
  }) as typeof fetch
  return seen
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('workbuddy daily check-in', () => {
  it('claims an unclaimed day and reports the credit', async () => {
    const seen = stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => json({ code: 0, data: { credit: 100 } }),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result).toEqual({ state: 'claimed', credit: 100 })
    expect(seen).toHaveLength(2)
  })

  it('does not claim again when the status already reports today as claimed', async () => {
    const seen = stubFetch({
      '/checkin-activity-status': () => json({
        code: 0,
        data: { active: true, today_checked_in: true, today_credit: 100, streak_days: 7, total_credits: 700 },
      }),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result).toEqual({ state: 'already', todayCredit: 100, streakDays: 7, totalCredits: 700 })
    // The claim endpoint must not be reached at all: one request, not two.
    expect(seen).toHaveLength(1)
  })

  it('treats a race-lost claim (400 + code 10001) as already claimed, not a failure', async () => {
    stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => json({ code: 10001, msg: '今天已签到，请明天再来' }, 400),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('already')
  })

  it('treats a null claim body as already claimed', async () => {
    stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => new Response('', { status: 200 }),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('already')
  })

  it('reports an inactive campaign as a normal state', async () => {
    stubFetch({ '/checkin-activity-status': () => json({ code: 0, data: { active: false } }) })
    const result = await checkIn(CREDENTIAL)
    expect(result).toEqual({ state: 'inactive' })
  })

  it('reports a rejected credential as a failure rather than throwing', async () => {
    stubFetch({ '/checkin-activity-status': () => json({ code: 0 }, 401) })
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('failed')
  })

  it('resolves to failed when the network is unreachable, never rejecting', async () => {
    globalThis.fetch = (async () => { throw new Error('getaddrinfo ENOTFOUND') }) as typeof fetch
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('failed')
  })

  it('resolves to failed on a timeout signal, never rejecting', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    }) as typeof fetch
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('failed')
  })

  it('surfaces a business rejection message from the claim call', async () => {
    stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => json({ code: 50000, msg: 'activity has ended' }, 400),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result).toEqual({ state: 'failed', message: 'activity has ended' })
  })

  it('never puts the access or refresh token in a failure message', async () => {
    globalThis.fetch = (async () => {
      throw new Error(`connect failed for ${CREDENTIAL.accessToken} / ${CREDENTIAL.refreshToken}`)
    }) as typeof fetch
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('failed')
    if (result.state !== 'failed') throw new Error('expected a failure result')
    expect(result.message).not.toContain(CREDENTIAL.accessToken)
    expect(result.message).not.toContain(CREDENTIAL.refreshToken)
  })

  it('redacts a token echoed back inside an upstream message', async () => {
    stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => json({ code: 50000, msg: `bad token ${CREDENTIAL.accessToken}` }, 400),
    })
    const result = await checkIn(CREDENTIAL)
    expect(result.state).toBe('failed')
    if (result.state !== 'failed') throw new Error('expected a failure result')
    expect(result.message).not.toContain(CREDENTIAL.accessToken)
    expect(result.message).toContain('[redacted]')
  })

  it('sends the billing identity the credit read uses', async () => {
    let captured: Headers | undefined
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      captured ??= new Headers(init?.headers)
      const url = String(_input)
      return url.endsWith('/checkin-activity-status') ? json(NOT_CLAIMED) : json({ code: 0, data: { credit: 100 } })
    }) as typeof fetch
    await checkIn(CREDENTIAL)
    expect(captured?.get('authorization')).toBe(`Bearer ${CREDENTIAL.accessToken}`)
    expect(captured?.get('x-user-id')).toBe('uid-1')
    expect(captured?.get('x-tenant-id')).toBe('ent-1')
    expect(captured?.get('x-domain')).toBe('www.workbuddy.cn')
  })

  it('routes a global credential to the global billing host', async () => {
    const seen = stubFetch({
      '/checkin-activity-status': () => json(NOT_CLAIMED),
      '/daily-checkin': () => json({ code: 0, data: { credit: 10 } }),
    })
    await checkIn({ ...CREDENTIAL, domain: 'www.workbuddy.ai' })
    expect(seen[0]!.startsWith('https://www.workbuddy.ai/')).toBe(true)
  })

  it('describes every outcome without exposing a token', () => {
    expect(describeCheckIn({ state: 'claimed', credit: 100, streakDays: 3 })).toContain('100')
    expect(describeCheckIn({ state: 'already' })).toContain('already')
    expect(describeCheckIn({ state: 'inactive' })).toContain('no check-in campaign')
    expect(describeCheckIn({ state: 'failed', message: 'boom' })).toContain('boom')
  })
})

describe('the check-in record', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })) })

  /** A path inside a fresh temporary directory, created lazily by the callee. */
  function tempLog(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wb-checkin-log-'))
    dirs.push(dir)
    return join(dir, 'nested', WORKBUDDY_CHECKIN_LOG_FILENAME)
  }

  it('creates the directory and appends one JSON line per run', async () => {
    const path = tempLog()
    await recordCheckIn({ state: 'claimed', credit: 100 }, path)
    await recordCheckIn({ state: 'already' }, path)
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!.replace(/^\[[^\]]+\]\s*/, ''))).toEqual({ state: 'claimed', credit: 100 })
    expect(JSON.parse(lines[1]!.replace(/^\[[^\]]+\]\s*/, ''))).toEqual({ state: 'already' })
  })

  it('records a timestamp that parses back to this run', async () => {
    const path = tempLog()
    const before = Date.now()
    await recordCheckIn({ state: 'inactive' }, path)
    const stamp = /^\[([^\]]+)\]/u.exec(readFileSync(path, 'utf8').trim())?.[1]
    expect(stamp).toBeDefined()
    const recorded = Date.parse(stamp!)
    expect(Number.isNaN(recorded)).toBe(false)
    expect(recorded).toBeGreaterThanOrEqual(before - 1_000)
    expect(recorded).toBeLessThanOrEqual(Date.now() + 1_000)
  })

  it('never rejects when the log cannot be written', async () => {
    // A directory where the file must go, so `appendFile` must fail.
    const dir = mkdtempSync(join(tmpdir(), 'wb-checkin-log-'))
    dirs.push(dir)
    await expect(recordCheckIn({ state: 'already' }, dir)).resolves.toBeUndefined()
  })
})
