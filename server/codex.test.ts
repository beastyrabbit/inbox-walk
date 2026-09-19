import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AuthStorage,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRegistry,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CodexAuthenticationError,
  codexAuthSource,
  codexAuthStoragePath,
  codexSpeedExtensions,
  ensureCodexStorageReady,
  finalCodexToolResult,
  isCodexAuthenticationFailure,
  isolatedResourceOptions,
  resolveCodexModel,
  resolvedCodexSettings,
  runCodexReply,
  selectedCodexModel,
  selectedCodexSettings,
} from './codex.ts'
import {
  codexAuthToPiStorage,
  codexReasoningToThinkingLevel,
  codexServiceTierToSpeed,
  piStorageToCodexAuth,
} from './codex-home.ts'

const originalDataDir = process.env.DATA_DIR
const originalCodexModel = process.env.CODEX_MODEL
const originalCodexThinkingLevel = process.env.CODEX_THINKING_LEVEL
const originalCodexHome = process.env.CODEX_HOME
const temporaryDirectories: string[] = []

afterEach(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR
  else process.env.DATA_DIR = originalDataDir
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = originalCodexHome
  delete process.env.CODEX_SPEED
  if (originalCodexModel === undefined) delete process.env.CODEX_MODEL
  else process.env.CODEX_MODEL = originalCodexModel
  if (originalCodexThinkingLevel === undefined) delete process.env.CODEX_THINKING_LEVEL
  else process.env.CODEX_THINKING_LEVEL = originalCodexThinkingLevel
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true })
  }
})

describe('Codex provider boundary', () => {
  it('does not load ambient prompts, context, extensions or skills', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-loader-'))
    temporaryDirectories.push(directory)
    fs.writeFileSync(path.join(directory, 'APPEND_SYSTEM.md'), 'SYNTHETIC_APPEND_MARKER')
    fs.writeFileSync(path.join(directory, 'AGENTS.md'), 'SYNTHETIC_CONTEXT_MARKER')
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: SettingsManager.inMemory(),
      ...isolatedResourceOptions(),
      systemPrompt: 'Explicit prompt only',
    })
    await loader.reload()
    expect(loader.getAppendSystemPrompt()).toEqual([])
    expect(loader.getAgentsFiles().agentsFiles).toEqual([])
    expect(loader.getSkills().skills).toEqual([])
    expect(loader.getExtensions().extensions).toEqual([])
  })

  it('terminates the agent loop after accepting a structured result', () => {
    expect(finalCodexToolResult('accepted')).toMatchObject({ terminate: true })
  })

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

  it('reads model, reasoning effort and speed from the Codex configuration', () => {
    const home = temporaryCodexHome()
    process.env.CODEX_MODEL = 'gpt-5.6-sol'
    process.env.CODEX_THINKING_LEVEL = 'medium'
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      [
        'model_reasoning_effort = "xhigh" # trailing comment',
        "service_tier = 'fast'",
        'model = "gpt-6-astra"',
        'notify = ["/usr/bin/true", "turn-ended"]',
        '',
        '[projects."/tmp/# not a comment"]',
        'trust_level = "trusted"',
        'model = "gpt-5.6-luna"',
      ].join('\n'),
    )

    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-6-astra',
      thinkingLevel: 'xhigh',
      speed: 'fast',
    })
    expect(selectedCodexModel()).toBe('gpt-6-astra')
    expect(resolvedCodexSettings()).toMatchObject({
      source: 'codex',
      path: path.join(home, 'config.toml'),
    })
  })

  it('lets the active Codex profile override the root configuration', () => {
    const home = temporaryCodexHome()
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      [
        'model = "gpt-5.6-sol"',
        'model_reasoning_effort = "high"',
        'profile = "inbox"',
        '',
        '[profiles.inbox]',
        'model = "gpt-5.6-luna"',
        'model_reasoning_effort = "ultra"',
        '',
        '[profiles.other]',
        'model = "gpt-5.6-terra"',
      ].join('\n'),
    )

    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-5.6-luna',
      thinkingLevel: 'max',
      speed: 'standard',
    })
  })

  it('falls back to the deployment defaults when Codex has no model configured', () => {
    temporaryCodexHome()
    process.env.CODEX_MODEL = 'gpt-5.6-terra'
    process.env.CODEX_THINKING_LEVEL = 'medium'
    process.env.CODEX_SPEED = 'fast'

    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-5.6-terra',
      thinkingLevel: 'medium',
      speed: 'fast',
    })
    expect(resolvedCodexSettings().source).toBe('environment')

    delete process.env.CODEX_MODEL
    delete process.env.CODEX_THINKING_LEVEL
    delete process.env.CODEX_SPEED
    expect(selectedCodexSettings()).toEqual({
      model: 'gpt-5.6-sol',
      thinkingLevel: 'high',
      speed: 'standard',
    })
    expect(resolvedCodexSettings().source).toBe('default')
  })

  it('maps Codex reasoning efforts and service tiers onto Pi request values', () => {
    expect(codexReasoningToThinkingLevel('none')).toBe('off')
    expect(codexReasoningToThinkingLevel('XHigh')).toBe('xhigh')
    expect(codexReasoningToThinkingLevel('ultra')).toBe('max')
    expect(codexReasoningToThinkingLevel('bogus')).toBeUndefined()
    expect(codexServiceTierToSpeed('fast')).toBe('fast')
    expect(codexServiceTierToSpeed('priority')).toBe('fast')
    expect(codexServiceTierToSpeed('flex')).toBe('standard')
    expect(codexServiceTierToSpeed(undefined)).toBeUndefined()
  })

  it('prefers the Codex CLI login and writes refreshed tokens back in Codex format', () => {
    const home = temporaryCodexHome()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-data-'))
    temporaryDirectories.push(dataDir)
    process.env.DATA_DIR = dataDir
    const access = syntheticJwt({
      exp: 1_800_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1' },
    })
    const codexAuth = {
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'old-id-token',
        access_token: access,
        refresh_token: 'old-refresh',
        account_id: 'acct-1',
      },
      last_refresh: '2026-09-01T00:00:00.000Z',
    }
    const authPath = path.join(home, 'auth.json')
    fs.writeFileSync(authPath, JSON.stringify(codexAuth))

    expect(codexAuthStoragePath()).toBe(authPath)
    expect(codexAuthSource()).toBe('codex')
    expect(JSON.parse(codexAuthToPiStorage(JSON.stringify(codexAuth)))).toEqual({
      'openai-codex': {
        type: 'oauth',
        access,
        refresh: 'old-refresh',
        expires: 1_800_000_000_000,
        accountId: 'acct-1',
      },
    })
    const next = piStorageToCodexAuth(
      JSON.stringify(codexAuth),
      JSON.stringify({
        'openai-codex': {
          type: 'oauth',
          access: 'new-access',
          refresh: 'new-refresh',
          expires: 1,
          accountId: 'acct-1',
          idToken: 'new-id-token',
        },
      }),
      new Date('2026-09-15T08:00:00.000Z'),
    )
    expect(JSON.parse(next ?? '')).toEqual({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: 'new-id-token',
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        account_id: 'acct-1',
      },
      last_refresh: '2026-09-15T08:00:00.000Z',
    })
    expect(piStorageToCodexAuth(JSON.stringify(codexAuth), '{}')).toBeUndefined()
  })

  it('ignores Codex API-key logins and keeps the Pi record below DATA_DIR', () => {
    const home = temporaryCodexHome()
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-data-'))
    temporaryDirectories.push(dataDir)
    process.env.DATA_DIR = dataDir
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-synthetic', tokens: null }),
    )

    expect(codexAuthStoragePath()).toBe(path.join(dataDir, 'pi', 'auth.json'))
    expect(codexAuthSource()).toBe('pi')
  })

  it('derives models Pi does not know yet from the Codex model cache', () => {
    const home = temporaryCodexHome()
    fs.writeFileSync(
      path.join(home, 'models_cache.json'),
      JSON.stringify({
        models: [
          {
            slug: 'gpt-6-astra',
            display_name: 'GPT 6.0 Astra',
            visibility: 'list',
            context_window: 272_000,
            input_modalities: ['text', 'image'],
            additional_speed_tiers: ['fast'],
          },
          { slug: 'codex-auto-review', display_name: 'Hidden', visibility: 'hide' },
        ],
      }),
    )
    const registry = ModelRegistry.inMemory(AuthStorage.create(path.join(home, 'pi-auth.json')))

    expect(resolveCodexModel(registry, 'gpt-5.6-sol')).toMatchObject({ id: 'gpt-5.6-sol' })
    expect(resolveCodexModel(registry, 'gpt-6-astra')).toMatchObject({
      api: 'openai-codex-responses',
      contextWindow: 272_000,
      id: 'gpt-6-astra',
      input: ['text', 'image'],
      name: 'GPT 6.0 Astra',
      provider: 'openai-codex',
      reasoning: true,
    })
    expect(() => resolveCodexModel(registry, 'codex-auto-review')).toThrow('unavailable')
    expect(() => resolveCodexModel(registry, 'gpt-9-unknown')).toThrow('unavailable')
  })

  it('requests the priority service tier only for the fast Codex speed', () => {
    expect(codexSpeedExtensions('standard')).toEqual([])
    const handlers: Array<(event: unknown, context: unknown) => unknown> = []
    for (const factory of codexSpeedExtensions('fast')) {
      factory({
        on: (_event: string, handler: (event: unknown, context: unknown) => unknown) => {
          handlers.push(handler)
        },
      } as unknown as ExtensionAPI)
    }
    expect(handlers).toHaveLength(1)
    expect(
      handlers[0]({ type: 'before_provider_request', payload: { model: 'gpt-6-astra' } }, {}),
    ).toEqual({ model: 'gpt-6-astra', service_tier: 'priority' })
    expect(handlers[0]({ type: 'before_provider_request', payload: null }, {})).toBeUndefined()
  })
})

function temporaryCodexHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-walk-codex-home-'))
  temporaryDirectories.push(home)
  process.env.CODEX_HOME = home
  delete process.env.CODEX_MODEL
  delete process.env.CODEX_THINKING_LEVEL
  delete process.env.CODEX_SPEED
  return home
}

function syntheticJwt(claims: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode(claims)}.signature`
}
