import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AuthStorageBackend } from '@earendil-works/pi-coding-agent'
import { FileAuthStorageBackend } from '@earendil-works/pi-coding-agent'
import {
  type CodexSpeed,
  type CodexThinkingLevel,
  isCodexModelId,
  isCodexThinkingLevel,
} from '../src/shared.ts'

// The Codex CLI and desktop app keep their login, configuration and model
// catalog below CODEX_HOME (default ~/.codex). This module reads that state so
// the app follows the model, reasoning effort and speed chosen in Codex.

export function codexHomeDir() {
  const configured = process.env.CODEX_HOME?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.codex')
}

export function codexConfigPath() {
  return path.join(codexHomeDir(), 'config.toml')
}

export function codexAuthFilePath() {
  return path.join(codexHomeDir(), 'auth.json')
}

export function codexModelsCachePath() {
  return path.join(codexHomeDir(), 'models_cache.json')
}

// ---------------------------------------------------------------------------
// config.toml
// ---------------------------------------------------------------------------

type TomlScalar = string | number | boolean

/**
 * Minimal TOML reader for the scalar keys Codex writes: bare keys with string,
 * number or boolean values, grouped by `[table]` headers. Arrays, inline tables
 * and multi-line strings are skipped because none of the keys read here use
 * them.
 */
export function parseCodexToml(content: string) {
  const tables = new Map<string, Map<string, TomlScalar>>()
  let table = ''
  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim()
    if (!line) continue
    const header = tomlTableHeader(line)
    if (header !== undefined) {
      table = normalizeTomlTableName(header)
      continue
    }
    // `line` is trimmed, so a value always ends with a non-space character.
    const assignment = /^([A-Za-z0-9_-]+|"[^"]*")\s*=\s*(\S.*)$/.exec(line)
    if (!assignment) continue
    const key = assignment[1].replace(/^"|"$/g, '')
    const value = parseTomlScalar(assignment[2].trim())
    if (value === undefined) continue
    let entries = tables.get(table)
    if (!entries) {
      entries = new Map()
      tables.set(table, entries)
    }
    entries.set(key, value)
  }
  return tables
}

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/

/**
 * Table name of a `[table]` or `[[array]]` header, or undefined for other
 * lines. Captures what /^\[\[?\s*(.+?)\s*\]\]?$/ captures, without its
 * super-linear backtracking.
 */
function tomlTableHeader(line: string) {
  if (!line.startsWith('[') || !line.endsWith(']')) return undefined
  for (const opening of line[1] === '[' ? [2, 1] : [1]) {
    const name = tomlHeaderName(line.slice(opening, -1))
    if (name !== undefined) return name
  }
  return undefined
}

/** Header text between the opening bracket(s) and the final `]`. */
function tomlHeaderName(inner: string) {
  const closing = inner.endsWith(']')
  const name = (closing ? inner.slice(0, -1) : inner).trim()
  if (name) return LINE_TERMINATOR.test(name) ? undefined : name
  if (closing) return ']'
  // Only whitespace: the pattern captures the last character that is not a line break.
  for (let index = inner.length - 1; index >= 0; index -= 1) {
    if (!LINE_TERMINATOR.test(inner[index])) return inner[index]
  }
  return undefined
}

function normalizeTomlTableName(name: string) {
  return name
    .split('.')
    .map((part) => part.trim().replace(/^"|"$/g, ''))
    .join('.')
}

function stripTomlComment(line: string) {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}

function parseTomlScalar(raw: string): TomlScalar | undefined {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\(["\\ntr])/g, (_match, escaped: string) => {
      if (escaped === 'n') return '\n'
      if (escaped === 't') return '\t'
      if (escaped === 'r') return '\r'
      return escaped
    })
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^[+-]?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return undefined
}

export interface CodexConfigSettings {
  model?: string
  thinkingLevel?: CodexThinkingLevel
  speed?: CodexSpeed
}

/** Maps Codex `model_reasoning_effort` values onto the thinking levels the Pi adapter sends. */
export function codexReasoningToThinkingLevel(value: unknown): CodexThinkingLevel | undefined {
  if (typeof value !== 'string') return undefined
  const effort = value.trim().toLowerCase()
  if (effort === 'none') return 'off'
  if (effort === 'ultra') return 'max'
  return isCodexThinkingLevel(effort) ? effort : undefined
}

/** Maps Codex `service_tier` onto the app's speed setting. `fast` is sent as `priority`. */
export function codexServiceTierToSpeed(value: unknown): CodexSpeed | undefined {
  if (typeof value !== 'string') return undefined
  const tier = value.trim().toLowerCase()
  if (!tier) return undefined
  return tier === 'fast' || tier === 'priority' ? 'fast' : 'standard'
}

export function codexConfigSettings(content: string): CodexConfigSettings {
  const tables = parseCodexToml(content)
  const root = tables.get('') ?? new Map<string, TomlScalar>()
  const profile = root.get('profile')
  const profileTable =
    typeof profile === 'string' && profile ? tables.get(`profiles.${profile}`) : undefined
  const read = (key: string) => profileTable?.get(key) ?? root.get(key)
  const model = read('model')
  return {
    ...(isCodexModelId(model) ? { model } : {}),
    ...(codexReasoningToThinkingLevel(read('model_reasoning_effort'))
      ? { thinkingLevel: codexReasoningToThinkingLevel(read('model_reasoning_effort')) }
      : {}),
    ...(codexServiceTierToSpeed(read('service_tier'))
      ? { speed: codexServiceTierToSpeed(read('service_tier')) }
      : {}),
  }
}

export function readCodexConfigSettings(configPath = codexConfigPath()): CodexConfigSettings {
  try {
    return codexConfigSettings(fs.readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// models_cache.json
// ---------------------------------------------------------------------------

export interface CodexCatalogModel {
  id: string
  label: string
  description: string
  contextWindow?: number
  supportsImages: boolean
  fastAvailable: boolean
}

function modelsCacheEntries(content: string): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  return parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { models?: unknown }).models)
    ? ((parsed as { models: unknown[] }).models as unknown[])
    : []
}

function hasFastTier(model: Record<string, unknown>) {
  const tiers = Array.isArray(model.service_tiers) ? model.service_tiers : []
  const speedTiers = Array.isArray(model.additional_speed_tiers) ? model.additional_speed_tiers : []
  return (
    speedTiers.includes('fast') ||
    tiers.some(
      (tier) => tier && typeof tier === 'object' && (tier as { id?: unknown }).id === 'priority',
    )
  )
}

function codexCatalogModel(entry: unknown): CodexCatalogModel | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const model = entry as Record<string, unknown>
  if (!isCodexModelId(model.slug) || model.visibility === 'hide') return undefined
  const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : ['text']
  return {
    id: model.slug,
    label: typeof model.display_name === 'string' ? model.display_name : model.slug,
    description: typeof model.description === 'string' ? model.description : '',
    ...(typeof model.context_window === 'number' && model.context_window > 0
      ? { contextWindow: model.context_window }
      : {}),
    supportsImages: modalities.includes('image'),
    fastAvailable: hasFastTier(model),
  }
}

export function codexModelCatalog(content: string): CodexCatalogModel[] {
  const catalog: CodexCatalogModel[] = []
  for (const entry of modelsCacheEntries(content)) {
    const model = codexCatalogModel(entry)
    if (model) catalog.push(model)
  }
  return catalog
}

export function readCodexModelCatalog(cachePath = codexModelsCachePath()): CodexCatalogModel[] {
  try {
    return codexModelCatalog(fs.readFileSync(cachePath, 'utf8'))
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// auth.json
// ---------------------------------------------------------------------------

const PI_PROVIDER = 'openai-codex'

interface CodexAuthFile {
  auth_mode?: unknown
  OPENAI_API_KEY?: unknown
  tokens?: {
    id_token?: unknown
    access_token?: unknown
    refresh_token?: unknown
    account_id?: unknown
  } | null
  last_refresh?: unknown
}

function parseCodexAuthFile(content: string | undefined): CodexAuthFile {
  if (!content?.trim()) return {}
  try {
    const value = JSON.parse(content) as unknown
    return value && typeof value === 'object' ? (value as CodexAuthFile) : {}
  } catch {
    return {}
  }
}

function jwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as unknown
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function accessTokenExpiry(accessToken: string) {
  const exp = jwtClaims(accessToken)?.exp
  // Treat tokens without a readable expiry as expired so Pi refreshes them first.
  return typeof exp === 'number' && Number.isFinite(exp) ? exp * 1000 : 0
}

function accessTokenAccountId(accessToken: string) {
  const auth = jwtClaims(accessToken)?.['https://api.openai.com/auth']
  const accountId =
    auth && typeof auth === 'object'
      ? (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id
      : undefined
  return typeof accountId === 'string' && accountId ? accountId : undefined
}

function codexAccountId(tokens: CodexAuthFile['tokens'], access: string) {
  if (typeof tokens?.account_id === 'string' && tokens.account_id) return tokens.account_id
  return access ? accessTokenAccountId(access) : undefined
}

/** Pi's auth.json representation of the ChatGPT login stored by Codex. */
export function codexAuthToPiStorage(content: string | undefined): string {
  const file = parseCodexAuthFile(content)
  const tokens = file.tokens
  const access = typeof tokens?.access_token === 'string' ? tokens.access_token : ''
  const refresh = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : ''
  const accountId = codexAccountId(tokens, access)
  if (file.auth_mode !== 'chatgpt' || !access || !refresh || !accountId) return '{}'
  return JSON.stringify({
    [PI_PROVIDER]: {
      type: 'oauth',
      access,
      refresh,
      expires: accessTokenExpiry(access),
      accountId,
    },
  })
}

/** Writes refreshed Pi credentials back into the Codex file, keeping every other field. */
export function piStorageToCodexAuth(
  current: string | undefined,
  next: string,
  now = new Date(),
): string | undefined {
  let data: Record<string, unknown>
  try {
    data = JSON.parse(next) as Record<string, unknown>
  } catch {
    return undefined
  }
  const credential = data?.[PI_PROVIDER]
  if (!credential || typeof credential !== 'object') return undefined
  const { type, access, refresh, accountId, idToken } = credential as Record<string, unknown>
  if (type !== 'oauth' || typeof access !== 'string' || typeof refresh !== 'string') {
    return undefined
  }
  const file = parseCodexAuthFile(current)
  const tokens = file.tokens && typeof file.tokens === 'object' ? file.tokens : {}
  const merged: CodexAuthFile = {
    ...file,
    auth_mode: 'chatgpt',
    tokens: {
      ...tokens,
      ...(typeof idToken === 'string' && idToken ? { id_token: idToken } : {}),
      access_token: access,
      refresh_token: refresh,
      ...(typeof accountId === 'string' && accountId ? { account_id: accountId } : {}),
    },
    last_refresh: now.toISOString(),
  }
  return `${JSON.stringify(merged, null, 2)}\n`
}

export function hasCodexChatgptAuth(authPath = codexAuthFilePath()) {
  try {
    return codexAuthToPiStorage(fs.readFileSync(authPath, 'utf8')) !== '{}'
  } catch {
    return false
  }
}

/**
 * Pi auth storage backend on top of Codex's own auth.json. Pi sees its usual
 * `openai-codex` OAuth record; token refreshes are written back in Codex's
 * format so the Codex CLI and the app never hold diverging refresh tokens.
 */
export function createCodexHomeAuthBackend(authPath = codexAuthFilePath()): AuthStorageBackend {
  const file = new FileAuthStorageBackend(authPath)
  return {
    withLock(fn) {
      return file.withLock((current) => {
        const { result, next } = fn(codexAuthToPiStorage(current))
        return {
          result,
          next: next === undefined ? undefined : piStorageToCodexAuth(current, next),
        }
      })
    },
    withLockAsync(fn) {
      return file.withLockAsync(async (current) => {
        const { result, next } = await fn(codexAuthToPiStorage(current))
        return {
          result,
          next: next === undefined ? undefined : piStorageToCodexAuth(current, next),
        }
      })
    },
  }
}
