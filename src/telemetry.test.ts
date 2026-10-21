import { describe, expect, it, vi } from 'vitest'
import { createTelemetry } from './telemetry.ts'
import { type ClientConfig, eventProperties, telemetryPath } from './telemetry-contract.ts'

const config: ClientConfig = {
  release: 'inbox-walk@0.11.0',
  umami: {
    url: 'https://analytics.test',
    websiteId: '11111111-1111-4111-8111-111111111111',
    replay: true,
  },
  glitchtip: { dsn: 'https://public@errors.test/17', environment: 'test', tracesSampleRate: 0.1 },
}
function harness(settings: ClientConfig = config) {
  let hook: (type: string, payload: Record<string, unknown>) => Record<string, unknown> | null =
    () => null
  const sent: unknown[] = []
  const loadScript = vi.fn(async () => {})
  const startErrors = vi.fn(async () => {})
  const startReplay = vi.fn(async () => {})
  const telemetry = createTelemetry({
    config: async () => settings,
    hostname: 'inbox.test',
    loadScript,
    startErrors,
    startReplay,
    tracker: () => ({
      track: (payload) => {
        sent.push(hook('event', payload))
      },
    }),
    beforeSend: (callback) => {
      hook = callback
    },
  })
  return {
    telemetry,
    loadScript,
    startErrors,
    startReplay,
    sent,
    hook: (type: string, payload: Record<string, unknown>) => hook(type, payload),
  }
}

describe('telemetry', () => {
  it('queues bounded early events, deduplicates startup, and loads only configured scripts', async () => {
    const test = harness()
    test.telemetry.page('/bucket')
    test.telemetry.page('/bucket')
    test.telemetry.track('bucket_done', {
      message_count: 3,
      subject: 'Private dinner',
      interaction: 'keyboard',
    })
    await Promise.all([test.telemetry.start(), test.telemetry.start()])
    expect(test.loadScript).toHaveBeenCalledTimes(1)
    expect(test.loadScript).toHaveBeenCalledWith(
      'https://analytics.test/script.js',
      expect.objectContaining({
        'data-domains': 'inbox.test',
        'data-before-send': 'inboxWalkBeforeSend',
        'data-auto-pageview': 'false',
        'data-exclude-search': 'true',
        'data-exclude-hash': 'true',
        'data-performance': 'true',
        'data-fetch-credentials': 'omit',
      }),
    )
    expect(test.startErrors).toHaveBeenCalledWith(config)
    expect(test.startReplay).toHaveBeenCalledWith('https://analytics.test', config.umami?.websiteId)
    expect(test.sent).toEqual([
      expect.objectContaining({ url: '/bucket', title: 'Inbox Walk', referrer: '' }),
      expect.objectContaining({
        name: 'bucket_done',
        data: { message_count: 3, interaction: 'keyboard' },
      }),
    ])
  })
  it('does nothing when config is unset, and can disable replay independently', async () => {
    const off = harness({ release: config.release })
    off.telemetry.track('app_loaded', { mode: 'demo' })
    await off.telemetry.start()
    off.telemetry.track('bucket_opened')
    expect(off.sent).toEqual([])
    expect(off.loadScript).not.toHaveBeenCalled()
    expect(off.startErrors).not.toHaveBeenCalled()
    expect(off.startReplay).not.toHaveBeenCalled()
    if (!config.umami) throw new Error('Test config missing Umami')
    const noReplay = harness({ ...config, umami: { ...config.umami, replay: false } })
    await noReplay.telemetry.start()
    expect(noReplay.startReplay).not.toHaveBeenCalled()
    noReplay.telemetry.track('app_loaded', { mode: 'demo' })
    expect(noReplay.sent).toEqual([
      expect.objectContaining({ name: 'app_loaded', data: { mode: 'demo' } }),
    ])
  })
  it('fails closed for unknown events, properties, identities, URLs and performance fields', async () => {
    const test = harness()
    await test.telemetry.start()
    expect(test.hook('identify', { id: 'private@example.com' })).toBeNull()
    expect(test.hook('event', { name: 'Secret subject' })).toBeNull()
    expect(
      test.hook('event', {
        url: 'https://inbox.test/buckets/Mf1a2b3?subject=secret#secret',
        title: 'Secret subject',
        referrer: 'private@example.com',
        data: { note: 'secret' },
        id: 'Mf1a2b3',
      }),
    ).toEqual({
      website: config.umami?.websiteId,
      hostname: 'inbox.test',
      title: 'Inbox Walk',
      url: '/bucket',
      referrer: '',
      tag: config.release,
    })
    expect(
      test.hook('performance', { lcp: 1234.56, cls: 0.01234, subject: 'secret' }),
    ).toMatchObject({ lcp: 1235, cls: 0.012 })
    expect(test.hook('performance', { lcp: 100 })).toBeNull()
    expect(
      eventProperties('bucket_done', { message_count: 'Mf1a2', interaction: 'secret' }),
    ).toEqual({})
    expect(eventProperties('outbound_link', { hostname: 'mail.example.com' })).toEqual({})
  })
  it('templates every API route without IDs, searches or hashes', () => {
    expect(telemetryPath('/api/todo/emails/Mf1a2b3/images/private?token=jwt#mail')).toBe(
      '/api/todo/emails/:id/images/:id',
    )
    expect(telemetryPath('/api/todo/threads/private?emailId=secret')).toBe('/api/todo/threads/:id')
    expect(telemetryPath('/api/todo/memory/proposals/private/accept')).toBe(
      '/api/todo/memory/proposals/:id/accept',
    )
    expect(
      telemetryPath('https://api.fastmail.com/jmap/download/account/Mf1a2b3/subject.eml'),
    ).toBe('/:id')
    expect(telemetryPath('/totally-private/subject')).toBe('/:id')
  })
})
