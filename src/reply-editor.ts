import type { MailAddress, ReplyEditorState } from './shared.ts'

export function addressesToText(addresses: readonly MailAddress[]) {
  return addresses
    .map(({ name, email }) => (name ? `${JSON.stringify(name)} <${email}>` : email))
    .join(', ')
}

const LINE_BREAK = /[\n\r\u2028\u2029]/
// The domain needs a dot with at least one character on each side; matching the first dot
// after the domain's first character keeps the pattern free of backtracking.
const EMAIL_ADDRESS = /^[^\s<>@,;]+@[^\s<>@,;][^\s<>@,;.]*\.[^\s<>@,;]+$/

/** Splits `Name <address>` exactly like `/^(.*?)\s*<([^<>]+)>$/`, without regex backtracking. */
function splitNamedAddress(value: string) {
  if (!value.endsWith('>')) return undefined
  const open = value.lastIndexOf('<')
  if (open === -1) return undefined
  const address = value.slice(open + 1, -1)
  if (!address || address.includes('>')) return undefined
  const name = value.slice(0, open).trimEnd()
  return LINE_BREAK.test(name) ? undefined : { address, name }
}

// Support address lists and quoted display names, retaining raw edits until save.
export function parseAddresses(value: string): MailAddress[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      escaped = true
      continue
    }
    if (char === '"') quoted = !quoted
    if (char === ',' && !quoted) {
      parts.push(value.slice(start, index))
      start = index + 1
    }
  }
  if (quoted || escaped)
    throw new Error('Bitte schließe den Anzeigenamen mit einem Anführungszeichen.')
  parts.push(value.slice(start))
  return parts
    .filter((part) => part.trim())
    .map((part) => {
      const match = splitNamedAddress(part.trim())
      const name = match?.name.trim() ?? ''
      const email = (match?.address ?? part).trim()
      if (!EMAIL_ADDRESS.test(email)) {
        throw new Error('Bitte prüfe die Empfängeradressen und trenne sie mit Kommas.')
      }
      return {
        name: /^"(?:[^"\\]|\\.)*"$/.test(name) ? name.slice(1, -1).replace(/\\(.)/g, '$1') : name,
        email,
      }
    })
}

export function patchReplyEditor(
  editor: ReplyEditorState,
  patch: Partial<ReplyEditorState>,
): ReplyEditorState {
  const changesDraft = ['bodyText', 'cc', 'ccText', 'identityId', 'subject', 'to', 'toText'].some(
    (key) => key in patch,
  )
  return { ...editor, ...patch, ...(changesDraft ? { draftRequestId: undefined } : {}) }
}

export function applyReplyProposal(
  current: ReplyEditorState,
  requested: ReplyEditorState,
  bodyText: string,
): ReplyEditorState {
  // A user edit wins over an inference result that started with an older body.
  if (current.bodyText !== requested.bodyText) return current
  return patchReplyEditor(current, {
    bodyText,
    ...(current.revisionInstruction === requested.revisionInstruction
      ? { revisionInstruction: '' }
      : {}),
  })
}
