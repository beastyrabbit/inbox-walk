import { AsyncLocalStorage } from 'node:async_hooks'

const operationSignal = new AsyncLocalStorage<AbortSignal>()
export class IoError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

// One budget spans all upstream calls in an HTTP operation, including batches.
export function withIoDeadline<T>(work: () => T, timeoutMs = 5 * 60_000): T {
  return operationSignal.run(AbortSignal.timeout(timeoutMs), work)
}

// Detached jobs retain their own cancellation signal and per-call I/O limits.
export function withoutIoDeadline<T>(work: () => T): T {
  return operationSignal.exit(work)
}

export function ioSignal(timeoutMs = 30_000, signal?: AbortSignal) {
  return AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...[signal, operationSignal.getStore()].filter((item): item is AbortSignal => Boolean(item)),
  ])
}

export async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Callers may already have started a fetch/read with the cancelled signal.
    // Observe its rejection even though this operation must stop immediately.
    void work.catch(() => {})
    signal.throwIfAborted()
  }
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () =>
      reject(
        new IoError(
          'Der externe Abruf hat sein Zeitlimit überschritten oder wurde abgebrochen.',
          'IO_TIMEOUT',
        ),
      )
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([work, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export async function readBoundedBody(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    if (Number(response.headers.get('content-length')) > maximumBytes)
      throw new IoError('Die Antwort überschreitet das Größenlimit.', 'RESPONSE_TOO_LARGE')
    while (true) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > maximumBytes)
        throw new IoError('Die Antwort überschreitet das Größenlimit.', 'RESPONSE_TOO_LARGE')
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
