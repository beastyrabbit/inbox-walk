import { describe, expect, it } from 'vitest'
import { legalRoutes } from './legal/pages.ts'
import { isSafeRequestPath, pangolinView } from './request-path.ts'

describe('Pangolin path view', () => {
  it.each([
    ['/api/todo/threads/T1/%252e%252e/%252e%252e/%252e%252e/%252e%252e/privacy', '/privacy'],
    ['/api/todo/blobs/B1/x%252F..%252F..%252F..%252F..%252F..%252Fprivacy', '/privacy'],
    ['/api/%252e%252e/%2570rivacy', '/privacy'],
    ['/privacy/', '/privacy'],
    ['/%70rivacy', '/privacy'],
    ['/Privacy', '/Privacy'],
    ['//./api/../privacy//', '/privacy'],
    ['/../../privacy', '/privacy'],
    ['/caf%C3%A9', '/café'],
    ['/a+b', '/a+b'],
    ['/%25zz', '/%zz'],
    ['/%25FF', '/%FF'],
    ['/%FF', '/\uFFFD'],
    ['/%zz', null],
    ['/%', null],
    ['/%2', null],
  ] as const)('maps %s to %s', (path, view) => {
    expect(pangolinView(path)).toBe(view)
  })
})

describe('raw request paths', () => {
  it.each(Object.keys(legalRoutes))('requires the exact legal path %s', (path) => {
    expect(isSafeRequestPath(path)).toBe(true)
    expect(isSafeRequestPath(`${path}?next=%25`)).toBe(true)
    expect(isSafeRequestPath(`${path}/`)).toBe(false)
    const encoded = `/%${path.charCodeAt(1).toString(16)}${path.slice(2)}`
    expect(isSafeRequestPath(encoded)).toBe(false)
  })

  it.each([
    '/',
    '/impressum',
    '/Privacy',
    '/api/todo',
    '/healthz',
    '/readyz',
    '/assets/index-abc.js',
    '/api/todo/blobs/G123abc_-?inline=1',
    '/api/todo/emails/M123abc_-/images/aB12_-?token=example',
    '/buckets/unsorted%3AM123abc_-',
    '/a/',
    '/file%20name.txt',
    '/a%2eb',
    '/privacy?next=//host/%2F/../%zz/%25',
  ])('allows %s', (path) => {
    expect(isSafeRequestPath(path)).toBe(true)
  })

  it.each([
    '/api/todo/threads/T1/%252e%252e/%252e%252e/%252e%252e/%252e%252e/privacy',
    '/api/todo/blobs/B1/x%252F..%252F..%252F..%252F..%252F..%252Fprivacy',
    '/api/todo/blobs/B1/%25',
    '/privacy/',
    '/%70rivacy',
    '/api/todo/..%2F..%2Fprivacy',
    '/api/todo/x%2f..%2f..%2fprivacy',
    '/api/x/%2e%2e/privacy',
    '/api/x/../privacy',
    '/api/x/./privacy',
    '/api/x/.%2E/privacy',
    '/api/x/%2e./privacy',
    '/api/x/%2E/privacy',
    '//privacy',
    '//host/privacy',
    '/api//todo',
    '/privacy%2F',
    '/a%5cb',
    '/a%5Cb',
    '/a\\b',
    '/%zz',
    '/%',
    '/%2',
    '/%C0%AF',
    '/%E0%A4',
    'https://example.com/privacy',
    'privacy',
    '*',
    '',
    undefined,
  ])('rejects %s', (path) => {
    expect(isSafeRequestPath(path)).toBe(false)
  })
})
