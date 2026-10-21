import { describe, expect, it } from 'vitest'
import { scrubRecording } from './telemetry-replay.ts'

const privateText = 'Secret subject alex@example.com Mf1a2b3c4d5e6f preview notes reply'
describe('recorder privacy', () => {
  it('removes unmasked text, attributes, CSS, custom events and raw URLs', () => {
    const input = {
      type: 'record',
      payload: {
        website: 'secret',
        timestamp: 100,
        events: [
          {
            type: 4,
            timestamp: 100,
            data: {
              href: 'https://app.test/buckets/Mf1a2b3c4d5e6f?token=secret#private',
              width: 1000,
              height: 600,
            },
          },
          {
            type: 2,
            timestamp: 101,
            data: {
              node: {
                type: 2,
                id: 1,
                tagName: 'div',
                attributes: {
                  title: privateText,
                  'data-mail-id': privateText,
                  srcdoc: privateText,
                  class: `rr-block ${privateText}`,
                  rr_width: '123px',
                  _cssText: `a { content: "${privateText}" }`,
                },
                childNodes: [{ type: 3, id: 2, textContent: privateText }],
              },
            },
          },
          {
            type: 3,
            timestamp: 102,
            data: {
              source: 0,
              attributes: [{ id: 1, attributes: { title: privateText, value: privateText } }],
              texts: [{ id: 2, value: privateText }],
            },
          },
          { type: 5, data: { tag: 'private', payload: privateText } },
          { type: 3, data: { source: 8, rules: [{ rule: privateText }] } },
          { type: 'umami:rrweb-event-fragment', data: { value: privateText } },
        ],
      },
    }
    const result = scrubRecording(input, 'website')
    const body = JSON.stringify(result)
    for (const leak of privateText.split(' ')) expect(body).not.toContain(leak)
    expect(result?.payload.events).toHaveLength(3)
    expect(result?.payload.events[0]).toMatchObject({ data: { href: '/bucket' } })
    expect(body).toContain('rr-block')
    expect(body).toContain('123px')
    expect(
      scrubRecording({ type: 'record', payload: { events: [], timestamp: 1 } }, 'website'),
    ).toBeNull()
  })
  it('allows only heatmap coordinates, fixed types and virtual URLs', () => {
    const result = scrubRecording(
      {
        type: 'heatmap',
        payload: {
          timestamp: 1,
          events: [
            {
              type: 'click',
              url: '/buckets/private?secret=1',
              x: 12.4,
              y: 20,
              text: privateText,
              selector: privateText,
            },
          ],
        },
      },
      'website',
    )
    expect(result).toEqual({
      type: 'heatmap',
      payload: {
        website: 'website',
        timestamp: 1,
        events: [{ type: 'click', url: '/bucket', x: 12, y: 20 }],
      },
    })
  })
})
