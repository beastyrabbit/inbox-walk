// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardRecorder } from './telemetry-replay.ts'

const url = 'https://umami.test'
const website = '11111111-1111-4111-8111-111111111111'
const secret = 'Private subject alex@example.com Mf1a2b3c4d5e6f'
const fetchTransport = vi.fn<typeof fetch>()
const beaconTransport = vi.fn<Navigator['sendBeacon']>()
const xhrOpen = XMLHttpRequest.prototype.open
const xhrSend = XMLHttpRequest.prototype.send

beforeEach(() => {
  fetchTransport.mockReset().mockResolvedValue(new Response('{}'))
  beaconTransport.mockReset().mockReturnValue(true)
  vi.stubGlobal('fetch', fetchTransport)
  vi.stubGlobal('navigator', { sendBeacon: beaconTransport })
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  XMLHttpRequest.prototype.open = xhrOpen
  XMLHttpRequest.prototype.send = xhrSend
})

describe('Umami transport allowlist', () => {
  it('passes analytics POSTs before and after the replay guard is installed', async () => {
    const init = { method: 'POST', body: '{"type":"event"}' }
    await window.fetch(`${url}/api/send`, init)
    guardRecorder(url, website)
    await window.fetch(`${url}/api/send`, init)
    expect(fetchTransport).toHaveBeenCalledTimes(2)
    for (const call of fetchTransport.mock.calls) expect(call).toEqual([`${url}/api/send`, init])
  })

  it('passes only the configured recorder GET and preserves non-Umami fetch arguments', async () => {
    guardRecorder(url, website)
    const config = new Request(`${url}/api/websites/${website}/recorder`)
    await window.fetch(config)
    expect(fetchTransport).toHaveBeenLastCalledWith(config, undefined)
    const request = new Request('https://app.test/api/todo')
    const init = { headers: { 'X-Test': 'unchanged' } }
    await window.fetch(request, init)
    expect(fetchTransport).toHaveBeenLastCalledWith(request, init)
    await window.fetch('https://errors.test/api/17/envelope/', { method: 'POST', body: secret })
    expect(fetchTransport).toHaveBeenLastCalledWith('https://errors.test/api/17/envelope/', {
      method: 'POST',
      body: secret,
    })
    expect(fetchTransport).toHaveBeenCalledTimes(3)
  })

  it.each([
    ['/api/other', 'POST'],
    ['/api/record/new', 'POST'],
    ['/api/record', 'GET'],
    ['/api/send', 'PUT'],
    ['/api/send?mail=private', 'POST'],
    [`/api/websites/${website}/recorder`, 'POST'],
    ['/api/websites/other/recorder', 'GET'],
  ])('drops unknown fetches without sending their bodies: %s %s', async (path, method) => {
    guardRecorder(url, website)
    const response = await window.fetch(`${url}${path}`, { method, body: secret })
    expect(response.status).toBe(204)
    expect(fetchTransport).not.toHaveBeenCalled()
  })

  it('scrubs exactly POST /api/record and drops unsupported recording bodies', async () => {
    guardRecorder(url, website)
    await window.fetch(`${url}/api/record`, {
      method: 'POST',
      body: JSON.stringify({
        type: 'record',
        payload: {
          timestamp: 1,
          events: [{ type: 4, data: { href: `https://app.test/buckets/${secret}` } }],
        },
      }),
    })
    expect(fetchTransport).toHaveBeenCalledTimes(1)
    const [target, init] = fetchTransport.mock.calls[0]
    expect(target).toBe(`${url}/api/record`)
    expect(JSON.parse(String(init?.body)).payload.events[0].data.href).toBe('/bucket')
    expect(JSON.stringify(init)).not.toContain(secret)
    const response = await window.fetch(`${url}/api/record`, { method: 'POST', body: secret })
    expect(response.status).toBe(204)
    expect(fetchTransport).toHaveBeenCalledTimes(1)
  })

  it('drops recorder and unknown beacons while preserving analytics and non-Umami beacons', () => {
    guardRecorder(url, website)
    for (const path of ['/api/record', '/api/other', '/api/send?mail=private'])
      expect(navigator.sendBeacon(`${url}${path}`, secret)).toBe(true)
    expect(beaconTransport).not.toHaveBeenCalled()
    navigator.sendBeacon(`${url}/api/send`, 'safe event')
    expect(beaconTransport).toHaveBeenLastCalledWith(`${url}/api/send`, 'safe event')
    navigator.sendBeacon('https://errors.test/api/17/envelope/', secret)
    expect(beaconTransport).toHaveBeenLastCalledWith('https://errors.test/api/17/envelope/', secret)
    expect(beaconTransport).toHaveBeenCalledTimes(2)
  })

  it('drops all Umami XHRs while preserving other XHR arguments and instance reuse', () => {
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open').mockImplementation(() => {})
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send').mockImplementation(() => {})
    const abort = vi.spyOn(XMLHttpRequest.prototype, 'abort').mockImplementation(() => {})
    guardRecorder(url, website)
    const xhr = new XMLHttpRequest()
    for (const path of ['/api/record', '/api/other', '/api/send']) {
      xhr.open('POST', `${url}${path}`)
      xhr.send(secret)
    }
    expect(open).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(3)
    xhr.open('POST', '/api/todo', false)
    xhr.send(secret)
    expect(open).toHaveBeenCalledExactlyOnceWith('POST', '/api/todo', false)
    expect(send).toHaveBeenCalledExactlyOnceWith(secret)
  })
})
