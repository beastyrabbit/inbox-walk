export interface ClientConfig {
  release: string
  umami?: { url: string; websiteId: string; replay: boolean }
  glitchtip?: { dsn: string; environment: string; tracesSampleRate: number }
}

export const virtualPaths = ['/', '/bucket', '/settings', '/reply', '/help', '/parked'] as const
export type ViewPath = (typeof virtualPaths)[number]

/** Match whole routes, never copy a dynamic path segment into telemetry. */
export function telemetryPath(value: unknown): string {
  if (typeof value !== 'string') return '/:id'
  let path: string
  try {
    path = new URL(value, 'https://inbox.invalid').pathname
  } catch {
    return '/:id'
  }
  if ((virtualPaths as readonly string[]).includes(path)) return path
  if (/^\/buckets\/[^/]+\/?$/.test(path)) return '/bucket'
  const routes: [RegExp, string][] = [
    [/^\/api\/client-config$/, '/api/client-config'],
    [/^\/api\/auth\/codex\/(status|start)$/, '/api/auth/codex/$1'],
    [/^\/api\/auth\/codex\/[^/]+$/, '/api/auth/codex/:id'],
    [/^\/api\/todo$/, '/api/todo'],
    [/^\/api\/todo\/(refresh|demo-reset|memory)$/, '/api/todo/$1'],
    [/^\/api\/todo\/messages\/(done|park|unpark|newsletter|retry)$/, '/api/todo/messages/$1'],
    [
      /^\/api\/todo\/memory\/proposals\/[^/]+\/(accept|reject)$/,
      '/api/todo/memory/proposals/:id/$1',
    ],
    [/^\/api\/todo\/(emails|threads|blobs)\/[^/]+$/, '/api/todo/$1/:id'],
    [/^\/api\/todo\/emails\/[^/]+\/(editor|replies|drafts)$/, '/api/todo/emails/:id/$1'],
    [/^\/api\/todo\/emails\/[^/]+\/images\/[^/]+$/, '/api/todo/emails/:id/images/:id'],
  ]
  for (const [pattern, template] of routes) {
    if (pattern.test(path)) return path.replace(pattern, template)
  }
  return '/:id'
}

const interaction = ['keyboard', 'click', 'automatic'] as const
const duration = ['under_1s', 'under_10s', 'under_60s', 'over_60s'] as const
const failure = ['network', 'authentication', 'attachment', 'timeout', 'server', 'unknown'] as const
type Rule = 'count' | 'boolean' | readonly string[]
export const eventRules: Record<string, Record<string, Rule>> = {
  app_loaded: { mode: ['demo', 'live'] },
  bucket_opened: { interaction },
  bucket_done: { message_count: 'count', interaction },
  message_parked: { message_count: 'count', interaction },
  message_unparked: { message_count: 'count', interaction },
  newsletter_tagged: { message_count: 'count', interaction },
  reply_panel_opened: { interaction },
  reply_draft_created: { duration, attachment_count: 'count' },
  reply_draft_failed: { category: failure, duration, attachment_count: 'count' },
  fastmail_draft_saved: {},
  fastmail_draft_failed: { category: failure },
  sort_retry_requested: { message_count: 'count', interaction },
  memory_proposal_accepted: {},
  memory_proposal_rejected: {},
  memory_note_saved: {},
  codex_connect_started: {},
  codex_connect_succeeded: {},
  codex_connect_failed: {},
  keyboard_help_opened: { interaction },
  original_colours_toggled: { enabled: 'boolean', interaction },
  outbound_link: { hostname: ['auth.openai.com'] },
  api_failure: { route: [], status_class: ['network', '4xx', '5xx', 'other'] },
}

/** Unknown events, keys and strings are dropped rather than redacted heuristically. */
export function eventProperties(name: string, input: Record<string, unknown>) {
  if (!Object.hasOwn(eventRules, name)) return null
  const result: Record<string, string | number | boolean> = {}
  for (const [key, rule] of Object.entries(eventRules[name])) {
    const value = input[key]
    if (key === 'route' && typeof value === 'string') result[key] = telemetryPath(value)
    else if (rule === 'count' && typeof value === 'number' && Number.isFinite(value)) {
      result[key] = Math.min(1_000_000, Math.max(0, Math.round(value)))
    } else if (rule === 'boolean' && typeof value === 'boolean') result[key] = value
    else if (Array.isArray(rule) && typeof value === 'string' && rule.includes(value)) {
      result[key] = value
    }
  }
  return result
}

export function durationBucket(milliseconds: number) {
  if (milliseconds < 1000) return 'under_1s'
  if (milliseconds < 10_000) return 'under_10s'
  if (milliseconds < 60_000) return 'under_60s'
  return 'over_60s'
}
