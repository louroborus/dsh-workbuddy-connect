/**
 * WorkBuddy daily check-in: claim the once-per-day credit grant.
 *
 * The endpoint is the one the desktop app's own "签到" button calls, reverse
 * engineered from `app.asar`; it lives beside the billing routes this plugin
 * already uses for the credit read, so the request reuses the credential and
 * the billing headers rather than introducing a second credential path.
 *
 * Three host names serve the same routes — `copilot.tencent.com`,
 * `www.codebuddy.cn`, and `www.workbuddy.cn` all answered the status call with
 * identical documents (measured 2026-10-07) — so this module routes through
 * {@link billingBase}, the seam that already encodes the region decision. No
 * new base URL is introduced.
 *
 * Claim semantics, measured against the live service:
 *
 * - **Status** (`checkin-activity-status`) is read-only and answers the
 *   activity's state: whether it is open, whether today is already claimed,
 *   the streak, and the running totals.
 * - **Claim** (`daily-checkin`) is idempotent for a given day. A repeat claim
 *   answers HTTP 400 with code 10001 (`今天已签到，请明天再来`) or a null body —
 *   both mean "already claimed today" and are reported as such, never as a
 *   failure. That idempotence is what makes a startup trigger safe to fire on
 *   every launch.
 * - **Not a season**: the status document reports `active: false` outside a
 *   check-in campaign. That is a normal state, not an error.
 *
 * The module is deliberately side-effect free apart from its two requests: it
 * owns no timers, spawns no process, and writes nothing to disk. Scheduling and
 * configuration live in the plugin entry, and the browser half never sees the
 * token.
 *
 * @module dsh-workbuddy-connect/checkin
 */

import type { WorkBuddyCredential } from './auth.ts'
import { billingBase, billingHeaders } from './upstream.ts'

/** Request timeout for both calls; both are small JSON round-trips. */
const CHECKIN_TIMEOUT_MS = 30_000

/** The upstream business code for "today is already claimed". */
const ALREADY_CLAIMED_CODE = 10001

/**
 * Outcome of one check-in attempt.
 *
 * `already` and `inactive` are successful, expected states — not failures —
 * because both describe a service that answered correctly. Only `failed`
 * carries a message, and its text is bounded before it reaches a log or the
 * status document.
 */
export type WorkBuddyCheckInResult =
  | { state: 'claimed'; credit: number; streakDays?: number; totalCredits?: number }
  | { state: 'already'; todayCredit?: number; streakDays?: number; totalCredits?: number }
  | { state: 'inactive' }
  | { state: 'failed'; message: string }

/**
 * Fetch one check-in URL with the plugin's billing identity.
 *
 * Kept private: callers go through {@link checkIn} so the two-call shape
 * (status then conditional claim) is the only thing that can be invoked.
 */
async function postJson(url: string, credential: WorkBuddyCredential): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: billingHeaders(credential),
    body: '{}',
    signal: AbortSignal.timeout(CHECKIN_TIMEOUT_MS),
  })
  const text = await response.text()
  if (text === '') return { status: response.status, body: undefined }
  try {
    return { status: response.status, body: JSON.parse(text) as unknown }
  } catch {
    // A non-JSON body (an HTML gateway page, for instance) is reported by the
    // caller through its status code alone; the payload never travels onward.
    return { status: response.status, body: undefined }
  }
}

/** Read one field from a response, unwrapping the `data` envelope. */
function field(body: unknown, key: string): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  const data = record['data']
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const wrapped = data as Record<string, unknown>
    if (wrapped[key] !== undefined) return wrapped[key]
  }
  return record[key]
}

/** A finite number from a response field, or `undefined`. */
function numberOf(body: unknown, key: string): number | undefined {
  const value = field(body, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Whether a claim response means "today was already claimed". */
function isAlreadyClaimed(status: number, body: unknown): boolean {
  // A null/empty body on a 2xx is the second documented "already" shape.
  if (body === undefined) return status >= 200 && status < 300
  const code = field(body, 'code')
  if (code === ALREADY_CLAIMED_CODE) return true
  const message = field(body, 'msg')
  return typeof message === 'string' && message.includes('已签')
}

/**
 * A short, token-free message for logs and the status document.
 *
 * The known secrets are removed by literal substitution rather than by a
 * shape-matching pattern: the token's own value is the only thing that must
 * never travel, and matching on a guessed format is how a differently-shaped
 * token slips through. The literal list is bounded by the credential that made
 * the request, so this cannot silently stop redacting after an upstream change.
 */
function safeMessage(error: unknown, secrets: readonly string[]): string {
  let text = error instanceof Error ? error.message : String(error)
  for (const secret of secrets) {
    if (secret !== '') text = text.split(secret).join('[redacted]')
  }
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .slice(0, 300)
}

/**
 * Claim today's check-in for one credential.
 *
 * Always resolves — a failure is a `failed` result rather than a throw — so a
 * caller firing this from a startup path can never have its own error handling
 * driven by a network blip. Never logs or returns the token.
 *
 * @param credential - the resolved credential, already refreshed on demand.
 */
export async function checkIn(credential: WorkBuddyCredential): Promise<WorkBuddyCheckInResult> {
  const base = billingBase(credential)
  const secrets = [credential.accessToken, credential.refreshToken]
  try {
    const status = await postJson(`${base}/v2/billing/meter/checkin-activity-status`, credential)
    if (status.status === 401 || status.status === 403) {
      return { state: 'failed', message: `workbuddy check-in rejected (http ${status.status})` }
    }
    if (status.status < 200 || status.status >= 300) {
      return { state: 'failed', message: `workbuddy check-in status failed (http ${status.status})` }
    }
    if (field(status.body, 'active') === false) return { state: 'inactive' }

    const todayCredit = numberOf(status.body, 'today_credit')
    const streakDays = numberOf(status.body, 'streak_days')
    const totalCredits = numberOf(status.body, 'total_credits')
    if (field(status.body, 'today_checked_in') === true
      || field(status.body, 'today_checked_in') === 1) {
      return {
        state: 'already',
        ...todayCredit === undefined ? {} : { todayCredit },
        ...streakDays === undefined ? {} : { streakDays },
        ...totalCredits === undefined ? {} : { totalCredits },
      }
    }

    const claim = await postJson(`${base}/v2/billing/meter/daily-checkin`, credential)
    if (claim.status === 401 || claim.status === 403) {
      return { state: 'failed', message: `workbuddy check-in rejected (http ${claim.status})` }
    }
    if (isAlreadyClaimed(claim.status, claim.body)) {
      return {
        state: 'already',
        ...todayCredit === undefined ? {} : { todayCredit },
        ...streakDays === undefined ? {} : { streakDays },
        ...totalCredits === undefined ? {} : { totalCredits },
      }
    }
    const credit = numberOf(claim.body, 'credit')
    if (claim.status >= 200 && claim.status < 300 && credit !== undefined) {
      return {
        state: 'claimed',
        credit,
        ...streakDays === undefined ? {} : { streakDays },
        ...totalCredits === undefined ? {} : { totalCredits },
      }
    }
    const message = field(claim.body, 'msg')
    return {
      state: 'failed',
      // The upstream's own text is redacted too: it is forwarded to a log, and
      // an echo of the request is exactly the case a passthrough would miss.
      message: typeof message === 'string' && message !== ''
        ? safeMessage(message, secrets)
        : `workbuddy check-in claim failed (http ${claim.status})`,
    }
  } catch (error: unknown) {
    return { state: 'failed', message: safeMessage(error, secrets) }
  }
}

/** One-line, token-free summary of a result, for the plugin log. */
export function describeCheckIn(result: WorkBuddyCheckInResult): string {
  switch (result.state) {
    case 'claimed':
      return `claimed ${result.credit} credit${result.streakDays === undefined ? '' : ` (streak ${result.streakDays}d)`}`
    case 'already':
      return 'already claimed today'
    case 'inactive':
      return 'no check-in campaign is running'
    case 'failed':
      return `failed: ${result.message}`
  }
}
