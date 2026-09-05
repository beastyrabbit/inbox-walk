import { EventEmitter } from 'node:events'
import type { RequestOptions } from 'node:https'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withIoDeadline } from './io.ts'

const transport = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }))
vi.mock('node:dns/promises', () => ({ lookup: transport.lookup }))
vi.mock('node:https', () => ({ request: transport.request }))

import { fetchRemoteImage } from './safe-http.ts'

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
let respond: (
  response: PassThrough & { headers: Record<string, string>; statusCode: number },
) => void
beforeEach(() => {
  vi.resetAllMocks()
  transport.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }])
  respond = (response) => response.end(png)
  transport.request.mockImplementation(
    (options: RequestOptions, callback: (response: unknown) => void) => {
      const req = new EventEmitter() as EventEmitter & {
        end: () => void
        destroy: (error: Error) => void
      }
      let response: ReturnType<typeof makeResponse>
      const abort = () => req.destroy(new Error('Request aborted'))
      req.destroy = (error) => {
        response?.destroy()
        req.emit('error', error)
      }
      req.end = () => {
        response = makeResponse()
        callback(response)
        respond(response)
      }
      options.signal?.addEventListener('abort', abort, { once: true })
      req.on('error', () => options.signal?.removeEventListener('abort', abort))
      return req
    },
  )
})
afterEach(() => vi.restoreAllMocks())
function makeResponse() {
  return Object.assign(new PassThrough(), {
    headers: {} as Record<string, string>,
    statusCode: 200,
  })
}

describe('remote image transport policy', () => {
  it('connects to the resolved public IP while retaining the original TLS name', async () => {
    expect((await fetchRemoteImage('https://image.example.test/picture')).body).toEqual(png)
    expect(transport.request.mock.calls[0]?.[0]).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'image.example.test',
      headers: { Host: 'image.example.test' },
    })
  })
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '0:0:0:0:0:ffff:7f00:1',
  ])('rejects private DNS result %s before connecting', async (address) => {
    transport.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }])
    await expect(fetchRemoteImage('https://image.example.test/picture')).rejects.toMatchObject({
      code: 'ADDRESS_FORBIDDEN',
    })
    expect(transport.request).not.toHaveBeenCalled()
  })
  it('revalidates the redirected hostname before opening another connection', async () => {
    respond = (response) => {
      response.statusCode = 302
      response.headers.location = 'https://redirect.example.test/image'
      response.end()
    }
    // Status and headers must be present before the response callback.
    transport.request.mockImplementationOnce((_options, callback) => {
      const req = new EventEmitter() as EventEmitter & { end: () => void }
      req.end = () => {
        const response = makeResponse()
        response.statusCode = 302
        response.headers.location = 'https://redirect.example.test/image'
        callback(response)
        response.end()
      }
      return req
    })
    transport.lookup
      .mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }])
    await expect(fetchRemoteImage('https://image.example.test/picture')).rejects.toMatchObject({
      code: 'ADDRESS_FORBIDDEN',
    })
    expect(transport.request).toHaveBeenCalledTimes(1)
  })
  it('rejects excess streamed bytes', async () => {
    respond = (response) => response.end(Buffer.alloc(8 * 1024 * 1024 + 1))
    await expect(fetchRemoteImage('https://image.example.test/picture')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
  })
  it('bounds DNS resolution and slow response bodies by the total deadline', async () => {
    transport.lookup.mockImplementationOnce(() => new Promise(() => {}))
    await expect(
      withIoDeadline(() => fetchRemoteImage('https://image.example.test/picture'), 15),
    ).rejects.toMatchObject({ code: 'IO_TIMEOUT' })
    expect(transport.request).not.toHaveBeenCalled()
    respond = (response) => {
      const timer = setInterval(() => response.write(png), 2)
      response.on('close', () => clearInterval(timer))
    }
    await expect(
      withIoDeadline(() => fetchRemoteImage('https://image.example.test/picture'), 15),
    ).rejects.toThrow('Request aborted')
  })
})
