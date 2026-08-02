import { describe, expect, it } from 'vitest'
import { detectSafeImageType } from './safe-http.ts'

describe('safe remote image type detection', () => {
  it.each([
    [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'],
    [Buffer.from([0x00, 0x00, 0x01, 0x00]), 'image/x-icon'],
    [Buffer.from('BMfake bitmap'), 'image/bmp'],
    [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'),
      'image/svg+xml',
    ],
  ])('recognizes a supported image by bytes', (body, expected) => {
    expect(detectSafeImageType(body)).toBe(expected)
  })

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/a"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>path{fill:url(https://tracker.example)}</style></svg>',
  ])('rejects active or externally-referencing SVG images', (source) => {
    expect(detectSafeImageType(Buffer.from(source))).toBeNull()
  })
})
