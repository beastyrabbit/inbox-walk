import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAuthenticationError,
  codexAuthStoragePath,
  ensureCodexStorageReady,
  isCodexAuthenticationFailure,
  runCodexReply,
  selectCodexModel,
  selectCodexSettings,
  selectedCodexModel,
  selectedCodexSettings,
} from './codex.ts'

const originalDataDir = process.env.DATA_DIR
const originalCodexModel = process.env.CODEX_MODEL
const originalCodexThinkingLevel = process.env.CODEX_THINKING_LEVEL
const temporaryDirectories: string[] = []

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
  if (originalCodexModel === undefined) delete process.env.CODEX_MODEL
  else process.env.CODEX_MODEL = originalCodexModel
  if (originalCodexThinkingLevel === undefined) delete process.env.CODEX_THINKING_LEVEL
  else process.env.CODEX_THINKING_LEVEL = originalCodexThinkingLevel
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

describe('Codex provider boundary', () => {
  it('keeps the OAuth record below DATA_DIR and verifies writable storage', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-codex-'))
    temporaryDirectories.push(directory)
    process.env.DATA_DIR = directory
    expect(codexAuthStoragePath()).toBe(path.join(directory, 'pi', 'auth.json'))
    expect(ensureCodexStorageReady()).toBe(path.join(directory, 'pi', 'auth.json'))
    expect(fs.statSync(path.join(directory, 'pi')).isDirectory()).toBe(true)
  })

  it('blocks live provider inference under Vitest before reading credentials', async () => {
    await expect(
      runCodexReply({ images: [], prompt: 'untrusted test data', systemPrompt: 'test' }),
    ).rejects.toThrow('Live AI inference is disabled')
  })

  it('classifies only conservative Codex authentication failures', () => {
    for (const failure of [
      new CodexAuthenticationError(),
      new Error('OpenAI Codex token refresh failed (401): invalid_grant'),
      new Error('No API key found for "openai-codex"'),
      new Error('OAuth token expired'),
      new Error('Request failed: 401 Unauthorized'),
    ]) {
      expect(isCodexAuthenticationFailure(failure)).toBe(true)
    }
    for (const failure of [
      new Error('Request failed: 403 Forbidden'),
      new Error('Request failed: 429 rate limit exceeded'),
      new Error('fetch failed: ECONNRESET'),
      new Error('Codex inference timed out after 30000 ms.'),
      new Error('Codex returned malformed output'),
    ]) {
      expect(isCodexAuthenticationFailure(failure)).toBe(false)
    }
  })

  it('persists a supported model below DATA_DIR and prefers it over the deployment default', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-codex-model-'))
    temporaryDirectories.push(directory)
    process.env.DATA_DIR = directory
    process.env.CODEX_MODEL = 'gpt-5.6-sol'

    expect(selectedCodexModel()).toBe('gpt-5.6-sol')
    selectCodexModel('gpt-5.6-luna')
    expect(selectedCodexModel()).toBe('gpt-5.6-luna')
    expect(
      JSON.parse(fs.readFileSync(path.join(directory, 'codex-settings.json'), 'utf8')),
    ).toEqual({
      model: 'gpt-5.6-luna',
      thinkingLevel: 'high',
    })
  })

  it('persists model and thinking level as one atomic Codex setting', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-codex-settings-'))
    temporaryDirectories.push(directory)
    process.env.DATA_DIR = directory
    process.env.CODEX_MODEL = 'gpt-5.6-sol'
    process.env.CODEX_THINKING_LEVEL = 'medium'

    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-5.6-sol',
      thinkingLevel: 'medium',
    })
    selectCodexSettings({ model: 'gpt-5.6-terra', thinkingLevel: 'xhigh' })
    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-5.6-terra',
      thinkingLevel: 'xhigh',
    })
  })
})
