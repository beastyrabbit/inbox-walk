import { describe, expect, it } from 'vitest'
import { addressesToText, applyReplyProposal, parseAddresses } from './reply-editor.ts'
import type { ReplyEditorState } from './shared.ts'

describe('reply editor updates', () => {
  const editor: ReplyEditorState = {
    bodyText: 'Original',
    cc: [],
    identityId: 'identity',
    revisionInstruction: 'Shorter',
    roughNotes: 'Notes',
    subject: 'Re: Fixture',
    to: [],
  }
  it('round-trips quoted names containing commas and escaped quotes', () => {
    const addresses = [
      { name: 'Doe, Alex "A"', email: 'alex@example.test' },
      { name: '', email: 'second@example.test' },
    ]
    expect(parseAddresses(addressesToText(addresses))).toEqual(addresses)
    expect(() => parseAddresses('"unfinished')).toThrow()
    expect(() => parseAddresses('incomplete@')).toThrow()
  })
  it('merges a proposal into the current editor while preserving other edits', () => {
    expect(
      applyReplyProposal(
        {
          ...editor,
          roughNotes: 'New notes',
          toText: 'new@example.test,',
          revisionInstruction: 'New instruction',
        },
        editor,
        'Generated',
      ),
    ).toMatchObject({
      bodyText: 'Generated',
      roughNotes: 'New notes',
      toText: 'new@example.test,',
      revisionInstruction: 'New instruction',
    })
    const editedBody = { ...editor, bodyText: 'Manual edit' }
    expect(applyReplyProposal(editedBody, editor, 'Generated')).toBe(editedBody)
  })
})
