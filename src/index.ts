// vitals — a cron-triggered Cloudflare Worker that watches the health of one or
// more independent projects and alerts to Telegram when something breaks.
//
// For each target it fetches the backend's deep health endpoint (dependency
// round-trips + a config self-audit), compares the audit against the expected
// prod config, watches the client-error spike counter, and GET-probes the
// project's frontends. Alerts are edge-triggered per target via KV: a target
// alerts when its problem signature CHANGES and sends a 🟢 recovery message
// when it clears, so a long outage is one message, not one per tick. Without
// the STATE binding it alerts on every failing tick.
//
// Targets are probed concurrently and hold independent KV state, so a broken
// project neither delays nor masks the others.
//
// The deep probe can be throttled per target (deep_every_minutes) while the
// cheap frontend probes stay on the cron's cadence — the deep one wakes a
// scale-to-zero database, and waking one costs its whole idle timeout.
//
// Deploy: npx wrangler deploy    Config + secrets: see README.md.

export interface TargetConfig {
  /** Identity of the project. Becomes the `[name]` tag on every alert and the
   *  suffix of its KV state key, so it must be stable and unique. */
  name: string
  /** Base URL of the API to probe, no trailing slash. */
  api_url: string
  /** Expected config-audit states for prod, compared against the deep
   *  endpoint's `config` array. Any mismatch alerts — this is the env-var
   *  drift tripwire. Format: `feature=state`, comma-separated. Omit to skip. */
  expected?: string
  /** Frontend URLs GET-probed for a live response (<400) each tick — catches a
   *  broken custom domain / DNS. Comma-separated string or array. */
  web_targets?: string | string[]
  /** Alert when this many NEW client-error signatures appeared in the sampled
   *  window. 0 disables the check. Default 0. */
  client_err_threshold?: string | number
  /** Width in minutes of the client-error window to ask the backend for, sent as
   *  ?spike_window_minutes=N. Defaults to deep_every_minutes, which is what you
   *  almost always want: a poller running every N minutes but reading a fixed
   *  15-minute window only sees 15/N of the elapsed time, and a spike in the
   *  blind interval is never reported. Omitted entirely when neither is set, so
   *  backends without the parameter keep their old behaviour. */
  spike_window_minutes?: string | number
  /** Name of the Worker secret holding this target's health key, e.g.
   *  "HEALTH_KEY_MYAPP". Resolved from `env` at runtime — the key itself never
   *  lives in the repo. Omit if the endpoint is ungated. */
  health_key_secret?: string
  /** Path of the deep health endpoint. Default "/healthz/deep". */
  health_path?: string
  /** Throttle the deep probe to at most once per N minutes, independently of
   *  the cron interval. Use when the health endpoint touches a scale-to-zero
   *  database: waking one costs its whole idle timeout (5 min on Neon's Free
   *  plan), so a frequent cron burns the compute quota. Web targets stay on the
   *  cron's cadence — they are static and cost nothing. Requires the STATE
   *  binding. 0 or omitted = probe deep on every tick. */
  deep_every_minutes?: string | number
  /** Per-request timeout. Default 15000. */
  timeout_ms?: string | number
}

export interface Env {
  /** The target list, from `vars` in wrangler.jsonc: either a real JSON array
   *  (readable, comment-able) or a JSON string, both accepted. */
  TARGETS: string | TargetConfig[]
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_CHAT_ID: string
  /** Optional secret gating the manual `fetch` probe. Unset = handler disabled. */
  MANUAL_PROBE_KEY?: string
  /** KV namespace. Per target: `last-signature:<name>` (alert edge-trigger)
   *  and, when deep_every_minutes is set, `deep:<name>` (last deep result). */
  STATE?: KVNamespace
  /** Per-target health keys are looked up here by their `health_key_secret`. */
  [binding: string]: unknown
}

interface CheckResult {
  name: string
  ok: boolean
  latency_ms: number
  detail?: string
}

interface AuditEntry {
  feature: string
  state: string
  detail: string
}

interface DeepResponse {
  status: string
  checks: CheckResult[]
  config: AuditEntry[]
  client_errors?: {
    /** Fixed 15-minute window. The original field; still the fallback for
     *  backends that do not honour ?spike_window_minutes. */
    new_signatures_15m: number
    total_errors_24h: number
    /** Echo of the window the backend actually applied. */
    spike_window_minutes?: number
    /** Count over that window. Preferred when present. */
    new_signatures_window?: number
  }
}

export interface TargetResult {
  name: string
  problems: string[]
  alerted: boolean
  recovered: boolean
  /** False when deep_every_minutes made this tick reuse the previous deep
   *  result instead of re-probing the API. */
  deep_checked: boolean
}

export interface ProbeOptions {
  /** Probe deep regardless of deep_every_minutes. Used by the manual handler:
   *  an on-demand check should report on now, not replay a cached result. */
  forceDeep?: boolean
}

/** What the last deep probe found, and when. Persisted so a throttled tick can
 *  replay it — see probe(). */
interface DeepState {
  at: number
  problems: string[]
}

const DEFAULT_HEALTH_PATH = '/healthz/deep'
const DEFAULT_TIMEOUT_MS = 15_000
/** Cron ticks jitter by seconds. Without slack, a deep probe due at exactly
 *  60 min would miss its tick by a hair, slip to the next one, and the schedule
 *  would walk forward every hour. */
const DEEP_DUE_GRACE_MS = 60_000
/** KV key for problems with the TARGETS config itself, not with any target. */
const CONFIG_STATE_KEY = 'last-signature:__config__'

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Append the requested client-error window to the deep URL. Left alone when no
 *  window is configured, so the request stays byte-identical to before. */
function deepUrl(base: string, spikeWindow: number): string {
  if (!(spikeWindow > 0)) return base
  try {
    const url = new URL(base)
    url.searchParams.set('spike_window_minutes', String(Math.round(spikeWindow)))
    return url.toString()
  } catch {
    return base // malformed api_url — let fetch surface it as it would anyway
  }
}

function toList(value: string | string[] | undefined): string[] {
  const parts = Array.isArray(value) ? value : (value ?? '').split(',')
  return parts.map((s) => s.trim()).filter(Boolean)
}

/** Parse and validate the TARGETS var. Throws with an actionable message so a
 *  typo in the config surfaces as an alert instead of a silent no-op run. */
export function parseTargets(raw: Env['TARGETS'] | undefined): TargetConfig[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('TARGETS is empty — nothing to monitor')
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      throw new Error(`TARGETS is not valid JSON: ${errText(e)}`)
    }
  }
  if (parsed === undefined || parsed === null) throw new Error('TARGETS is not set — nothing to monitor')
  if (!Array.isArray(parsed)) throw new Error('TARGETS must be a JSON array of target objects')
  if (parsed.length === 0) throw new Error('TARGETS is empty — nothing to monitor')

  const targets: TargetConfig[] = []
  const seen = new Set<string>()
  parsed.forEach((entry, i) => {
    const t = entry as TargetConfig
    if (!t || typeof t !== 'object') throw new Error(`TARGETS[${i}] is not an object`)
    if (!t.name) throw new Error(`TARGETS[${i}] is missing "name"`)
    if (!t.api_url) throw new Error(`TARGETS[${i}] (${t.name}) is missing "api_url"`)
    // Names key the KV state, so a duplicate would silently share one signature
    // and let two projects mask each other's alerts.
    if (seen.has(t.name)) throw new Error(`TARGETS has duplicate name "${t.name}"`)
    seen.add(t.name)
    targets.push(t)
  })
  return targets
}

/** Probe one target's deep health endpoint. Returns its problems (empty = green). */
async function probeApi(target: TargetConfig, env: Env): Promise<string[]> {
  const problems: string[] = []
  // Name the host so alerts stay attributable even when one project spans
  // several origins (the [name] tag identifies the target, this the host).
  const host = hostOf(target.api_url)
  const at = `@ ${host}`
  const path = target.health_path ?? DEFAULT_HEALTH_PATH
  const timeout = Number(target.timeout_ms ?? DEFAULT_TIMEOUT_MS)

  const headers: Record<string, string> = {}
  if (target.health_key_secret) {
    const key = env[target.health_key_secret]
    if (typeof key !== 'string' || !key) {
      return [`${at} health_key_secret "${target.health_key_secret}" is not set on the Worker`]
    }
    headers['X-Health-Key'] = key
  }

  // Ask for a window matching how often we actually poll (see spike_window_minutes).
  const spikeWindow = Number(target.spike_window_minutes ?? target.deep_every_minutes ?? 0)

  let res: Response
  try {
    res = await fetch(deepUrl(`${target.api_url}${path}`, spikeWindow), {
      headers,
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    // Network-level failure (DNS, connect, timeout).
    return [`${path} ${at} unreachable: ${errText(e)}`]
  }

  if (res.status === 404) {
    // Gated route missing = the health key drifted on either side.
    return [`${path} ${at} returned 404 — health key mismatch or endpoint not deployed`]
  }

  // Parse the body ONCE from text so a non-JSON response doesn't surface as a
  // cryptic "Unexpected token '<'" JSON.parse error. A healthy backend returns
  // JSON even on a failing deep check (status may be 503 but the body carries
  // the failed checks); a *non-JSON* body means the app never answered — almost
  // always a platform 5xx served as an HTML/text error page (cold-start
  // failure, DB down). Report the HTTP status + a snippet instead.
  const raw = await res.text()
  let body: DeepResponse
  try {
    body = JSON.parse(raw) as DeepResponse
  } catch {
    const snippet = raw.replace(/\s+/g, ' ').trim().slice(0, 140) || '(empty body)'
    return [`${path} ${at} returned HTTP ${res.status} ${res.statusText} (non-JSON): ${snippet}`]
  }

  for (const c of body.checks ?? []) {
    if (!c.ok) problems.push(`${at} check ${c.name} FAILED (${c.latency_ms}ms): ${c.detail ?? 'no detail'}`)
  }

  // Config drift: every feature listed in `expected` must match the audit.
  const audit = new Map((body.config ?? []).map((a) => [a.feature, a]))
  for (const pair of (target.expected ?? '').split(',')) {
    const [feature, want] = pair.split('=').map((s) => s.trim())
    if (!feature) continue
    const got = audit.get(feature)
    if (!got) {
      problems.push(`${at} config ${feature}: missing from audit (expected ${want})`)
    } else if (got.state !== want) {
      problems.push(`${at} config ${feature}: ${got.state} (expected ${want}) — ${got.detail}`)
    }
  }

  // Client-error spike — a frontend problem surfaced through the API's
  // aggregation, e.g. a broken web deploy throwing on every keystroke.
  const threshold = Number(target.client_err_threshold ?? 0)
  const spike = body.client_errors
  if (threshold > 0 && spike) {
    // Prefer the window we asked for; fall back to the fixed 15-minute field so
    // a backend that ignores the parameter still reports something.
    const windowed = typeof spike.new_signatures_window === 'number'
    const count = windowed ? (spike.new_signatures_window as number) : spike.new_signatures_15m
    const width = windowed && spike.spike_window_minutes ? `${spike.spike_window_minutes}m` : '15m'
    if (Number.isFinite(count) && count >= threshold) {
      problems.push(
        `${at} [web] client errors: ${count} new signature(s) in ${width} (${spike.total_errors_24h} events/24h)`,
      )
    }
  }

  return problems
}

/** GET-probe a target's frontends. A 3xx (e.g. a marketing-site redirect) means
 *  the origin is alive, so only >=400 counts as down; redirect:'manual' keeps
 *  us from chasing them. Probed concurrently, reported in config order. */
async function probeWeb(target: TargetConfig): Promise<string[]> {
  const timeout = Number(target.timeout_ms ?? DEFAULT_TIMEOUT_MS)
  const results = await Promise.all(
    toList(target.web_targets).map(async (url) => {
      try {
        const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(timeout) })
        return res.status >= 400 ? `[web] ${url} returned ${res.status}` : null
      } catch (e) {
        return `[web] ${url} unreachable: ${errText(e)}`
      }
    }),
  )
  return results.filter((p): p is string => p !== null)
}

/** Last deep result for a target, or null when there is none / it is unusable. */
async function readDeepState(target: TargetConfig, env: Env): Promise<DeepState | null> {
  const raw = await env.STATE?.get(`deep:${target.name}`)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeepState
    return typeof parsed?.at === 'number' && Array.isArray(parsed.problems) ? parsed : null
  } catch {
    return null // corrupt value: re-probe and overwrite it
  }
}

export async function probe(
  target: TargetConfig,
  env: Env,
  opts: ProbeOptions = {},
): Promise<{ problems: string[]; deepChecked: boolean }> {
  const now = Date.now()
  const every = Number(target.deep_every_minutes ?? 0)
  // Throttling needs somewhere to remember the last run. With no KV, or no
  // record yet, probe deep: over-checking costs compute, under-checking hides
  // an outage, and only one of those is recoverable.
  const cached = every > 0 && env.STATE ? await readDeepState(target, env) : null
  const runDeep = opts.forceDeep === true || every <= 0 || cached === null || now - cached.at >= every * 60_000 - DEEP_DUE_GRACE_MS

  // The API and the frontends are independent surfaces — a dead API must not
  // stop us from reporting that the frontend is also down. Web targets are
  // probed every tick regardless: they are static and cost nothing to hit.
  const [deep, web] = await Promise.all([
    // Replaying the cached deep result on a throttled tick is what keeps the
    // alert signature stable. Dropping it instead would read as "problem gone"
    // and fire a false 🟢 recovery, then re-alert on the next deep run — the
    // monitor would flap once per cron tick while the outage continued.
    runDeep ? probeApi(target, env) : Promise.resolve(cached?.problems ?? []),
    probeWeb(target),
  ])

  if (runDeep && every > 0 && env.STATE) {
    const state: DeepState = { at: now, problems: deep }
    await env.STATE.put(`deep:${target.name}`, JSON.stringify(state))
  }
  return { problems: [...deep, ...web], deepChecked: runDeep }
}

async function telegram(env: Env, text: string): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
  })
  if (!res.ok) console.error('telegram send failed', res.status, await res.text())
}

/** Edge-trigger on a signature change against a KV key. Returns whether to
 *  alert and whether this transition is a recovery. */
async function transition(
  env: Env,
  key: string,
  signature: string,
): Promise<{ shouldAlert: boolean; recovered: boolean }> {
  if (!env.STATE) return { shouldAlert: signature !== '', recovered: false }
  const last = (await env.STATE.get(key)) ?? ''
  if (signature === last) return { shouldAlert: false, recovered: false } // same state — stay quiet
  await env.STATE.put(key, signature)
  return { shouldAlert: signature !== '', recovered: last !== '' && signature === '' }
}

/** Probe one target and alert on a state change. Each target owns its KV key,
 *  so its alerts and recovery are independent of every other target's. */
async function runTarget(target: TargetConfig, env: Env, opts: ProbeOptions): Promise<TargetResult> {
  let problems: string[]
  let deepChecked = false
  try {
    const result = await probe(target, env, opts)
    problems = result.problems
    deepChecked = result.deepChecked
  } catch (e) {
    // A thrown probe is that target's problem, not a dead run.
    problems = [`probe failed: ${errText(e)}`]
  }
  const signature = problems.join('\n')
  const tag = `[${target.name}]`
  const { shouldAlert, recovered } = await transition(env, `last-signature:${target.name}`, signature)

  if (shouldAlert) {
    const head = `🔴 ${tag} vitals: ${problems.length} problem(s)`
    await telegram(env, [head, ...problems.map((p) => `• ${p}`)].join('\n'))
  } else if (recovered) {
    await telegram(env, `🟢 ${tag} vitals: recovered, all checks green`)
  }
  return { name: target.name, problems, alerted: shouldAlert, recovered, deep_checked: deepChecked }
}

export async function run(env: Env, only?: string, opts: ProbeOptions = {}): Promise<{ targets: TargetResult[] }> {
  let targets: TargetConfig[]
  try {
    targets = parseTargets(env.TARGETS)
  } catch (e) {
    // Config problems are edge-triggered too, so a bad deploy alerts once.
    const message = errText(e)
    const { shouldAlert } = await transition(env, CONFIG_STATE_KEY, message)
    console.error('vitals config error:', message)
    if (shouldAlert) await telegram(env, `🔴 [vitals] config error: ${message}`)
    throw e
  }
  // Clear a previously reported config error once the config parses again.
  await transition(env, CONFIG_STATE_KEY, '')

  if (only) {
    const found = targets.filter((t) => t.name === only)
    if (found.length === 0) throw new Error(`unknown target "${only}"`)
    targets = found
  }

  // Concurrent: one target failing or timing out must not delay or suppress
  // the others. allSettled because a rejection here (KV or Telegram, since
  // runTarget already absorbs probe errors) must not kill the whole run.
  const settled = await Promise.allSettled(targets.map((t) => runTarget(t, env, opts)))
  const results = settled.map((s, i): TargetResult => {
    if (s.status === 'fulfilled') return s.value
    const reason = errText(s.reason)
    console.error(`vitals target ${targets[i].name} failed:`, reason)
    return { name: targets[i].name, problems: [`run failed: ${reason}`], alerted: false, recovered: false, deep_checked: false }
  })
  return { targets: results }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env))
  },

  // Manual probe for testing, gated by MANUAL_PROBE_KEY. `?target=<name>`
  // probes a single target; omit it to run them all. Always probes deep,
  // ignoring deep_every_minutes — an on-demand check that replayed a cached
  // result would be useless. Note that this wakes the database.
  async fetch(request: Request, env: Env): Promise<Response> {
    const key = env.MANUAL_PROBE_KEY
    // A 404 rather than a 401: an unset key disables the handler entirely and
    // an unauthenticated caller learns nothing about what lives here.
    if (!key || request.headers.get('X-Health-Key') !== key) {
      return new Response('not found', { status: 404 })
    }
    const only = new URL(request.url).searchParams.get('target') ?? undefined
    try {
      return Response.json(await run(env, only, { forceDeep: true }))
    } catch (e) {
      return Response.json({ error: errText(e) }, { status: 500 })
    }
  },
}
