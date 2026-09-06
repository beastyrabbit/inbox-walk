import { describe, expect, it } from 'vitest'
import { abortable, ioSignal, readBoundedBody, withIoDeadline, withoutIoDeadline } from './io.ts'

describe('upstream operation budgets', () => {
  it('detaches background work while preserving explicit cancellation and per-call deadlines', async () => {
    const controller = new AbortController()
    const job = withIoDeadline(
      () =>
        withoutIoDeadline(async () => {
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
          expect(ioSignal(1000).aborted).toBe(false)
          controller.abort()
          expect(ioSignal(1000, controller.signal).aborted).toBe(true)
          await expect(abortable(new Promise(() => {}), ioSignal(10))).rejects.toMatchObject({
            code: 'IO_TIMEOUT',
          })
        }),
      5,
    )
    await job
  })
  it('observes an already-rejected read when cancellation predates the call', async () => {
    const signal = AbortSignal.abort(new Error('Already cancelled'))
    await expect(abortable(Promise.reject(new Error('Read cancelled')), signal)).rejects.toThrow(
      'Already cancelled',
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  it('bounds a steadily progressing stream by total time and cancels it', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 3))
        if (!cancelled) controller.enqueue(new Uint8Array([1]))
      },
      cancel() {
        cancelled = true
      },
    })
    await expect(
      readBoundedBody(new Response(body), 1_000_000, ioSignal(20)),
    ).rejects.toMatchObject({ code: 'IO_TIMEOUT' })
    expect(cancelled).toBe(true)
  })

  it('carries one deadline across sequential calls and isolates concurrent requests', async () => {
    const expired = withIoDeadline(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15))
      return abortable(new Promise(() => {}), ioSignal(1000))
    }, 25)
    const independent = withIoDeadline(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35))
      return abortable(Promise.resolve('complete'), ioSignal(1000))
    }, 100)
    await expect(expired).rejects.toMatchObject({ code: 'IO_TIMEOUT' })
    await expect(independent).resolves.toBe('complete')
  })

  it('cancels a response as soon as streamed bytes exceed the bound', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(8))
          controller.enqueue(new Uint8Array(8))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    await expect(readBoundedBody(response, 10, ioSignal())).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
    expect(cancelled).toBe(true)
  })
})
