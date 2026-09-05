import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DefaultResourceLoader, SettingsManager } from '@earendil-works/pi-coding-agent'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bundleDecisionSystemPrompt,
  bundlePartitionPrompt,
  bundlePartitionSystemPrompt,
  bundlePartitionToolSchema,
  CodexAuthenticationError,
  CodexContextLengthError,
  codexAuthStoragePath,
  codexBundleTimeoutMs,
  DEFAULT_CODEX_BUNDLE_TIMEOUT_MS,
  ensureCodexStorageReady,
  finalCodexToolResult,
  isCodexAuthenticationFailure,
  isolatedResourceOptions,
  MAX_CODEX_BUNDLE_TIMEOUT_MS,
  requireSubmittedBundlePartition,
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

  it('sizes all partition tool collections from the frozen snapshot', () => {
    const schema = bundlePartitionToolSchema(10_001)
    expect(schema.properties.stories).toMatchObject({ maxItems: 10_001 })
    expect(schema.properties.stories.items.properties.emailIds).toMatchObject({ maxItems: 10_001 })
    expect(schema.properties.standaloneEmailIds).toMatchObject({ maxItems: 10_001 })
  })
  it('terminates the agent loop after accepting a structured result', () => {
    expect(finalCodexToolResult('accepted')).toMatchObject({ terminate: true })
  })

  it('gives the global partition a 30 minute default and a 60 minute safety ceiling', () => {
    expect(codexBundleTimeoutMs(undefined)).toBe(DEFAULT_CODEX_BUNDLE_TIMEOUT_MS)
    expect(codexBundleTimeoutMs('300000')).toBe(300_000)
    expect(codexBundleTimeoutMs('9999999')).toBe(MAX_CODEX_BUNDLE_TIMEOUT_MS)
    expect(codexBundleTimeoutMs('invalid')).toBe(DEFAULT_CODEX_BUNDLE_TIMEOUT_MS)
  })

  it('reports provider context exhaustion separately from malformed partition output', () => {
    expect(() => requireSubmittedBundlePartition({ stopReason: 'length' }, [])).toThrow(
      CodexContextLengthError,
    )
    expect(() =>
      requireSubmittedBundlePartition(
        { errorMessage: 'maximum number of tokens exceeded', stopReason: 'error' },
        [],
      ),
    ).toThrow(CodexContextLengthError)
    expect(() => requireSubmittedBundlePartition({ stopReason: 'stop' }, [])).toThrow(
      'did not submit exactly one complete bundle partition',
    )
  })

  it('requires a complete global partition before materializing review stories', () => {
    const prompt = bundlePartitionSystemPrompt()

    expect(prompt).toContain('Inspect every supplied email summary together')
    expect(prompt).toContain('complete set')
    expect(prompt).toContain('Every supplied ID must appear exactly once')
    expect(prompt).toContain('A story may be transitive')
    expect(prompt).toContain('Never group generic card notifications with each other')
    expect(prompt).toContain('unique compatible charge event within minutes')
    expect(prompt).toContain('several items or parcels')
    expect(prompt).toContain('continuous unresolved incident across successive SHAs or providers')
    expect(prompt).toContain('stories contains only groups of at least two emails')
    expect(prompt).toContain('standaloneEmailIds contains every remaining email')
    expect(prompt).toContain('submit_bundle_partition exactly once')
  })

  it('sends every frozen summary field to the global partition', () => {
    const email = {
      from: [{ email: 'orders@example.com', name: 'Orders' }],
      hasAttachment: true,
      id: 'message-1',
      isNewsletter: true,
      mailboxNames: ['Inbox', 'Orders'],
      preview: 'A short preview',
      receivedAt: '2026-08-31T10:00:00.000Z',
      subject: 'Order update',
      threadId: 'thread-1',
      to: [{ email: 'account@example.com', name: 'Account' }],
    }
    const parsed = JSON.parse(bundlePartitionPrompt({ emails: [email], examples: [] })) as {
      emails: unknown[]
    }
    expect(parsed.emails).toEqual([email])
  })

  it('defines entity-level lifecycle, recurring-series, evidence, and title rules', () => {
    const single = bundleDecisionSystemPrompt(false)
    const batch = bundleDecisionSystemPrompt(true)

    for (const prompt of [single, batch]) {
      expect(prompt).toContain('same underlying story')
      expect(prompt).toContain('same narrow real-world entity and activity')
      expect(prompt).toContain(
        'notification template, broad category, wording, or time window alone',
      )
      expect(prompt).toContain('require a discriminating combination')
      expect(prompt).toContain('one or more carrier parcels')
      expect(prompt).toContain('candidate need not match the seed directly')
      expect(prompt).toContain('Different provider roles are not a conflict')
      expect(prompt).toContain('Prefer a concrete lifecycle over a recurring series')
      expect(prompt).toContain('Never group generic card notifications with each other')
      expect(prompt).toContain('unique compatible charge event within minutes')
      expect(prompt).toContain('several items or parcels')
      expect(prompt).toContain('continuous unresolved incident across successive SHAs or providers')
      expect(prompt).toContain('commission start to completion to review')
      expect(prompt).toContain("one repository's same change or bounded failure episode")
      expect(prompt).toContain('return each included ID at most once')
      expect(prompt).toContain('latest state or activity')
      expect(prompt).toContain(
        'Write title, currentState, summary, and linkEvidence in concise German',
      )
      expect(prompt).toContain('Avoid generic titles')
      expect(prompt).toContain('Never invent a missing fact')
    }
    expect(single).toContain('Never return seed IDs')
    expect(single).toContain('submit_bundle_decision exactly once')
    expect(batch).toContain('Evaluate every supplied cohort independently')
    expect(batch).toContain('Candidate IDs may only be returned within their own cohort')
    expect(batch).toContain('submit_bundle_decision_batch exactly once')
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
