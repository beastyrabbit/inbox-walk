import type { Event } from '@sentry/react'
import { describe, expect, it } from 'vitest'
import { scrubBreadcrumb, scrubEvent } from './telemetry-scrub.ts'

const leaks = [
  'Private dinner on Tuesday',
  'alex@example.com',
  'Mf1a2b3c4d5e6f7890',
  'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.secret',
  'sk-private-token-abcdefghijklmnopqrstuvwxyz1234567890',
  'Here is the private preview',
  'Remember that Alex is away next week',
  'My private reply text',
]
const secret = leaks.join(' | ')

describe('shared GlitchTip scrubber', () => {
  it.each([
    'ReplyError',
    'JmapError',
    'TriageStoreError',
    'CustomException',
    'PromiseRejection',
    `A${'b'.repeat(63)}Error`,
  ])('preserves the custom exception class %s while withholding its value', (type) => {
    const clean = scrubEvent({ exception: { values: [{ type, value: secret }] } })
    expect(clean.exception?.values?.[0]).toMatchObject({
      type,
      value: 'Application error (details withheld)',
    })
    for (const leak of leaks) expect(JSON.stringify(clean)).not.toContain(leak)
  })

  it.each([
    'replyError',
    'Private dinner Error',
    'alex@example.comError',
    'Custom_Error',
    'CustomFailure',
    `A${'b'.repeat(64)}Error`,
    'Custom.Error',
  ])('normalizes unsupported exception types: %j', (type) => {
    const clean = scrubEvent({ exception: { values: [{ type, value: secret }] } })
    expect(clean.exception?.values?.[0]).toMatchObject({
      type: 'Error',
      value: 'Application error (details withheld)',
    })
  })

  it('discards arbitrary mail text, credentials, request metadata and console/DOM details', () => {
    const event: Event = {
      event_id: 'a'.repeat(32),
      timestamp: 100,
      release: 'inbox-walk@0.11.0',
      environment: 'production',
      message: secret,
      logentry: { message: secret, params: [secret] },
      user: { email: leaks[1], id: leaks[2] },
      server_name: secret,
      extra: { notes: secret, reply: secret },
      tags: { bucket: secret },
      fingerprint: [secret],
      transaction: secret,
      request: {
        url: `https://inbox.example/api/todo/emails/${leaks[2]}?token=secret#subject`,
        data: secret,
        headers: { Authorization: secret },
        cookies: { session: secret },
        query_string: secret,
      },
      exception: {
        values: [
          {
            type: secret,
            value: secret,
            mechanism: { type: secret, data: { error: secret } },
            stacktrace: {
              frames: [
                {
                  filename: 'https://inbox.example/assets/index-AbCd1234.js',
                  lineno: 12,
                  colno: 34,
                  function: secret,
                  vars: { body: secret },
                  context_line: secret,
                  pre_context: [secret],
                  post_context: [secret],
                },
                {
                  filename: `https://api.fastmail.com/jmap/download/${leaks[2]}`,
                  function: secret,
                },
                { filename: `https://inbox.example/assets/index-${leaks[2]}.js` },
              ],
            },
          },
        ],
      },
      breadcrumbs: [
        { category: 'console', message: secret, data: { arguments: [secret] } },
        { category: 'ui.click', message: secret, data: { selector: secret } },
        { category: 'http', data: { url: secret, headers: { Authorization: secret } } },
        { category: secret, message: secret },
      ],
      contexts: {
        browser: { name: secret },
        trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), data: { secret }, op: secret },
      },
      sdkProcessingMetadata: {
        dynamicSamplingContext: { transaction: secret },
      },
    }
    const clean = scrubEvent(event)
    for (const leak of leaks) expect(JSON.stringify(clean)).not.toContain(leak)
    expect(clean).toMatchObject({
      release: 'inbox-walk@0.11.0',
      environment: 'production',
      request: { url: '/api/todo/emails/:id' },
    })
    expect(clean.request).toEqual({ url: '/api/todo/emails/:id' })
    expect(clean.exception?.values?.[0]).toMatchObject({
      type: 'Error',
      value: 'Application error (details withheld)',
      stacktrace: {
        frames: [{ filename: '~/assets/index-AbCd1234.js', lineno: 12, colno: 34, in_app: true }],
      },
    })
    expect(clean.breadcrumbs).toEqual([
      { category: 'console' },
      { category: 'ui.click' },
      { category: 'http' },
    ])
    for (const key of [
      'user',
      'server_name',
      'extra',
      'tags',
      'fingerprint',
      'sdkProcessingMetadata',
    ])
      expect(clean).not.toHaveProperty(key)
    expect(event.extra).toEqual({ notes: secret, reply: secret })
  })
  it('scrubs transaction names and spans, preserving only safe trace IDs and timings', () => {
    const clean = scrubEvent({
      type: 'transaction',
      transaction: `/buckets/${leaks[2]}?subject=${leaks[0]}`,
      start_timestamp: 100,
      timestamp: 101,
      spans: [
        {
          span_id: 'a'.repeat(16),
          trace_id: 'b'.repeat(32),
          start_timestamp: 100,
          description: secret,
          data: { secret },
        },
      ],
    })
    expect(clean).toMatchObject({
      type: 'transaction',
      transaction: '/bucket',
      spans: [],
      start_timestamp: 100,
      timestamp: 101,
    })
    for (const leak of leaks) expect(JSON.stringify(clean)).not.toContain(leak)
  })
  it('keeps build debug IDs and supported errors without keeping arbitrary paths or messages', () => {
    const clean = scrubEvent({
      debug_meta: {
        images: [
          {
            type: 'sourcemap',
            code_file: 'https://inbox.example/assets/errors-aBcD1234.js',
            debug_id: '11111111-1111-4111-8111-111111111111',
          },
          { type: 'sourcemap', code_file: secret, debug_id: secret },
        ],
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: secret,
            stacktrace: { frames: [{ filename: 'file:///app/dist-server/index.js', lineno: 12 }] },
          },
        ],
      },
    })
    expect(clean.debug_meta?.images).toHaveLength(1)
    expect(clean.exception?.values?.[0]?.type).toBe('TypeError')
    expect(clean.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
      'app:///dist-server/index.js',
    )
    expect(scrubBreadcrumb({ category: secret, message: secret })).toBeNull()
  })
})
