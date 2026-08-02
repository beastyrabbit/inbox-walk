import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { codexAuthStoragePath, ensureCodexStorageReady, runCodexReply } from './codex.ts'

const originalDataDir = process.env.DATA_DIR
const temporaryDirectories: string[] = []

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
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
})
