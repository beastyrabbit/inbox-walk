import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai/compat'
import {
  type AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  type ExtensionAPI,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent'
import { type Static, type TSchema, Type } from 'typebox'
import {
  type CodexSpeed,
  type CodexThinkingLevel,
  codexModelLabel,
  isCodexModelId,
  isCodexSpeed,
  isCodexThinkingLevel,
} from '../src/shared.ts'
import {
  codexAuthFilePath,
  codexConfigPath,
  createCodexHomeAuthBackend,
  hasCodexChatgptAuth,
  readCodexConfigSettings,
  readCodexModelCatalog,
} from './codex-home.ts'
import { codexRequestSignal, createCodexAuthStorage, withCodexRequest } from './codex-request.ts'
import { abortable } from './io.ts'

const CODEX_PROVIDER = 'openai-codex'
const DEFAULT_CODEX_MODEL: string = 'gpt-5.6-sol'
const DEFAULT_CODEX_THINKING_LEVEL: CodexThinkingLevel = 'high'
const DEFAULT_CODEX_SPEED: CodexSpeed = 'standard'
/** Unknown-to-Pi Codex models inherit this model's transport settings. */
const CODEX_MODEL_TEMPLATE: string = 'gpt-5.6-sol'
/** Codex sends its `fast` service tier as this request value. */
const CODEX_FAST_SERVICE_TIER = 'priority'
export function finalCodexToolResult(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    details: {},
    terminate: true,
  }
}

export class CodexAuthenticationError extends Error {
  constructor(options?: ErrorOptions) {
    super('Codex authentication is unavailable.', options)
    this.name = 'CodexAuthenticationError'
  }
}

export function isCodexAuthenticationFailure(error: unknown) {
  if (error instanceof CodexAuthenticationError) return true
  const message = error instanceof Error ? error.message : String(error)
  return (
    /\b(?:http(?: status)?\s*)?401\b|\bunauthori[sz]ed\b/i.test(message) ||
    /invalid[_ -]?grant|(?:access|refresh|oauth) token (?:has )?expired|expired (?:access|refresh|oauth) token/i.test(
      message,
    ) ||
    /no api key|oauth (?:login |token |refresh )?(?:failed|failure)|failed to refresh oauth token/i.test(
      message,
    )
  )
}

function rethrowCodexAuthenticationFailure(error: unknown): never {
  if (error instanceof CodexAuthenticationError) throw error
  if (isCodexAuthenticationFailure(error)) {
    throw new CodexAuthenticationError({ cause: error })
  }
  throw error
}

async function requireCodexRequestAuth(
  registry: ModelRegistry,
  model: NonNullable<ReturnType<ModelRegistry['find']>>,
) {
  const signal = codexRequestSignal()
  signal.throwIfAborted()
  const auth = await abortable(registry.getApiKeyAndHeaders(model), signal)
  signal.throwIfAborted()
  if (!auth.ok) {
    rethrowCodexAuthenticationFailure(new Error(auth.error))
  }
  if (!auth.apiKey) {
    throw new CodexAuthenticationError({
      cause: new Error('No API key for Codex.'),
    })
  }
}

export interface CodexSettings {
  model: string
  thinkingLevel: CodexThinkingLevel
  speed: CodexSpeed
}

export type CodexSettingsSource = 'codex' | 'environment' | 'default'

export function selectedCodexModel(): string {
  return selectedCodexSettings().model
}

/**
 * Model, reasoning effort and speed follow the Codex configuration in
 * CODEX_HOME/config.toml. Environment variables only fill keys Codex leaves
 * unset, and the deployment defaults cover the rest.
 */
export function selectedCodexSettings(): CodexSettings {
  return resolvedCodexSettings().settings
}

export function resolvedCodexSettings(): {
  settings: CodexSettings
  source: CodexSettingsSource
  path: string
} {
  const configPath = codexConfigPath()
  const configured = readCodexConfigSettings(configPath)
  const environmentModel = process.env.CODEX_MODEL?.trim()
  const environmentThinking = process.env.CODEX_THINKING_LEVEL?.trim()
  const environmentSpeed = process.env.CODEX_SPEED?.trim()
  const settings: CodexSettings = {
    model:
      configured.model ??
      (isCodexModelId(environmentModel) ? environmentModel : DEFAULT_CODEX_MODEL),
    thinkingLevel:
      configured.thinkingLevel ??
      (isCodexThinkingLevel(environmentThinking)
        ? environmentThinking
        : DEFAULT_CODEX_THINKING_LEVEL),
    speed:
      configured.speed ?? (isCodexSpeed(environmentSpeed) ? environmentSpeed : DEFAULT_CODEX_SPEED),
  }
  let source: CodexSettingsSource = 'default'
  if (configured.model) source = 'codex'
  else if (isCodexModelId(environmentModel)) source = 'environment'
  return { settings, source, path: configPath }
}

type CodexModel = NonNullable<ReturnType<ModelRegistry['find']>>

/**
 * Finds the configured model in Pi's catalog, or derives it from the Codex
 * model cache when Pi does not know the slug yet.
 */
export function resolveCodexModel(registry: ModelRegistry, modelId: string): CodexModel {
  const known = registry.find(CODEX_PROVIDER, modelId)
  if (known) return known
  const template = registry.find(CODEX_PROVIDER, CODEX_MODEL_TEMPLATE)
  const catalogEntry = readCodexModelCatalog().find((entry) => entry.id === modelId)
  if (!template || !catalogEntry) throw new Error(`Codex model ${modelId} is unavailable.`)
  return {
    ...template,
    id: catalogEntry.id,
    name: catalogEntry.label,
    input: catalogEntry.supportsImages ? ['text', 'image'] : ['text'],
    ...(catalogEntry.contextWindow ? { contextWindow: catalogEntry.contextWindow } : {}),
  }
}

/** Inline Pi extension that asks the Codex backend for the fast service tier. */
export function codexSpeedExtensions(speed: CodexSpeed) {
  if (speed !== 'fast') return []
  return [
    (pi: ExtensionAPI) => {
      pi.on('before_provider_request', (event) => {
        if (!event.payload || typeof event.payload !== 'object') return undefined
        return {
          ...(event.payload as Record<string, unknown>),
          service_tier: CODEX_FAST_SERVICE_TIER,
        }
      })
    },
  ]
}

export interface CodexReplyInput {
  images: ImageContent[]
  prompt: string
  systemPrompt: string
}

export interface CodexReplyOutput {
  bodyText: string
  questions: string[]
  supportedDetails: Array<{ detail: string; sourceMessageIds: string[] }>
  warnings: string[]
}

function hasStoredAuth(file: string) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    return Boolean(value && typeof value === 'object' && Object.keys(value).length > 0)
  } catch {
    return false
  }
}

export function isolatedResourceOptions() {
  return {
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: [] as string[],
  }
}

/** The Codex CLI login wins; otherwise Pi's own record below DATA_DIR or the workstation. */
export function codexAuthStoragePath() {
  const codexPath = codexAuthFilePath()
  if (hasCodexChatgptAuth(codexPath)) return codexPath
  const dataDir = process.env.DATA_DIR ?? path.resolve('data')
  const persistentPath = path.join(dataDir, 'pi', 'auth.json')
  const workstationPath = path.join(os.homedir(), '.pi', 'agent', 'auth.json')
  return !process.env.DATA_DIR && !hasStoredAuth(persistentPath) && hasStoredAuth(workstationPath)
    ? workstationPath
    : persistentPath
}

export function codexAuthSource(authPath = codexAuthStoragePath()): 'codex' | 'pi' {
  return authPath === codexAuthFilePath() ? 'codex' : 'pi'
}

export function ensureCodexStorageReady() {
  const authPath = codexAuthStoragePath()
  const directory = path.dirname(authPath)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK)
  return authPath
}

const authStores = new Map<string, AuthStorage>()

export function getCodexAuthStorage() {
  const authPath = ensureCodexStorageReady()
  let storage = authStores.get(authPath)
  if (!storage) {
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    storage =
      codexAuthSource(authPath) === 'codex'
        ? createCodexAuthStorage(authPath, createCodexHomeAuthBackend(authPath))
        : createCodexAuthStorage(authPath)
    authStores.set(authPath, storage)
  }
  return storage
}

export function codexAuthStatus() {
  const { settings, source, path: settingsPath } = resolvedCodexSettings()
  const details = {
    ...settings,
    modelLabel:
      readCodexModelCatalog().find((entry) => entry.id === settings.model)?.label ??
      codexModelLabel(settings.model),
    settingsSource: source,
    settingsPath,
  }
  try {
    const authPath = codexAuthStoragePath()
    const storage = getCodexAuthStorage()
    storage.reload()
    return {
      ...storage.getAuthStatus(CODEX_PROVIDER),
      ...details,
      authSource: codexAuthSource(authPath),
    }
  } catch {
    return { configured: false, ...details }
  }
}

const replyToolSchema = Type.Object(
  {
    bodyText: Type.String({ maxLength: 256_000 }),
    supportedDetails: Type.Array(
      Type.Object(
        {
          detail: Type.String({ maxLength: 16_000 }),
          sourceMessageIds: Type.Array(Type.String({ maxLength: 512 }), { maxItems: 500 }),
        },
        { additionalProperties: false },
      ),
      { maxItems: 500 },
    ),
    questions: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 100 }),
    warnings: Type.Array(Type.String({ maxLength: 16_000 }), { maxItems: 100 }),
  },
  { additionalProperties: false },
)

function codexInferenceTimeoutMs() {
  const configured = Number(process.env.CODEX_INFERENCE_TIMEOUT_MS ?? 5 * 60_000)
  return Number.isFinite(configured)
    ? Math.min(15 * 60_000, Math.max(30_000, configured))
    : 5 * 60_000
}

type CodexTool = ReturnType<typeof defineTool>

export interface CodexToolSessionOptions<Result> {
  cancelSignal?: AbortSignal
  /** Validates the finished session and produces the result. */
  complete: (message: AssistantMessage | undefined) => Result
  images?: ImageContent[]
  prompt: string
  settings: CodexSettings
  systemPrompt: string
  timeoutMs: number
  /** The only tools the model can call. End the session with finalCodexToolResult. */
  tools: CodexTool[]
}

/** A tool that collects structured submissions and ends the session. */
export function codexSubmitTool<Schema extends TSchema>(definition: {
  accepted: string
  description: string
  label: string
  name: string
  parameters: Schema
}) {
  const submitted: Static<Schema>[] = []
  const tool = defineTool({
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_callId, args) {
      submitted.push(args)
      return finalCodexToolResult(definition.accepted)
    },
  })
  return { submitted, tool }
}

/**
 * Runs one isolated Codex session restricted to the supplied tools. Builtin
 * tools, skills, extensions and context files stay disabled. The session ends
 * when a tool terminates it, the deadline passes, or the caller cancels.
 */
export async function runCodexToolSession<Result>(
  options: CodexToolSessionOptions<Result>,
): Promise<Result> {
  if (process.env.VITEST) {
    throw new Error(
      'Live AI inference is disabled in automated tests. A manual live run requires an explicit user request.',
    )
  }
  const { cancelSignal } = options
  cancelSignal?.throwIfAborted()
  const authStorage = getCodexAuthStorage()
  authStorage.reload()
  const registry = ModelRegistry.inMemory(authStorage)
  const model = resolveCodexModel(registry, options.settings.model)
  await requireCodexRequestAuth(registry, model)
  cancelSignal?.throwIfAborted()

  const sessionCwd = process.cwd()
  const agentDir = path.dirname(codexAuthStoragePath())
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false, provider: { maxRetries: 0 } },
    hideThinkingBlock: true,
  })
  const resourceLoader = new DefaultResourceLoader({
    cwd: sessionCwd,
    agentDir,
    settingsManager,
    ...isolatedResourceOptions(),
    extensionFactories: codexSpeedExtensions(options.settings.speed),
    systemPrompt: options.systemPrompt,
  })
  await abortable(resourceLoader.reload(), codexRequestSignal())
  codexRequestSignal().throwIfAborted()
  const { session } = await createAgentSession({
    cwd: sessionCwd,
    agentDir,
    authStorage,
    modelRegistry: registry,
    model,
    thinkingLevel: model.reasoning ? options.settings.thinkingLevel : 'off',
    noTools: 'builtin',
    tools: options.tools.map((tool) => tool.name),
    customTools: options.tools,
    sessionManager: SessionManager.inMemory(sessionCwd),
    settingsManager,
    resourceLoader,
  })
  const inferenceSignal = codexRequestSignal()
  const abortSession = () => void session.abort().catch(() => {})
  let rejectAbort: (error: Error) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const failOnAbort = () => {
    if (cancelSignal?.aborted) {
      rejectAbort(
        cancelSignal.reason instanceof Error
          ? cancelSignal.reason
          : new DOMException('Codex analysis cancelled.', 'AbortError'),
      )
      return
    }
    rejectAbort(new Error(`Codex inference timed out after ${options.timeoutMs} ms.`))
  }
  inferenceSignal.addEventListener('abort', abortSession, { once: true })
  inferenceSignal.addEventListener('abort', failOnAbort, { once: true })
  try {
    try {
      inferenceSignal.throwIfAborted()
      await Promise.race([
        session.prompt(options.prompt, {
          expandPromptTemplates: false,
          source: 'rpc',
          ...(options.images ? { images: options.images } : {}),
        }),
        aborted,
      ])
      const message = [...session.messages].reverse().find((entry) => entry.role === 'assistant') as
        | AssistantMessage
        | undefined
      return options.complete(message)
    } catch (error) {
      rethrowCodexAuthenticationFailure(error)
    }
  } finally {
    inferenceSignal.removeEventListener('abort', abortSession)
    inferenceSignal.removeEventListener('abort', failOnAbort)
    session.dispose()
  }
}

/** Runs work under the Codex request deadline required by the auth adapter. */
export function withCodexDeadline<T>(
  work: () => Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
) {
  return withCodexRequest(work, timeoutMs, signal)
}

export async function runCodexReply(input: CodexReplyInput): Promise<CodexReplyOutput> {
  return withCodexRequest(() => codexReply(input), codexInferenceTimeoutMs())
}

async function codexReply(input: CodexReplyInput): Promise<CodexReplyOutput> {
  const submit = codexSubmitTool({
    accepted: 'Der strukturierte Antwortentwurf wurde übernommen.',
    description:
      'Submit exactly one final structured email reply proposal. This is the only permitted output.',
    label: 'Antwortentwurf übernehmen',
    name: 'submit_reply_proposal',
    parameters: replyToolSchema,
  })
  return runCodexToolSession({
    complete(message) {
      if (!message) throw new Error('Codex returned no assistant response.')
      if (message.stopReason === 'error') {
        throw new Error(message.errorMessage || 'Codex stopped with an error.')
      }
      if (submit.submitted.length !== 1 || !submit.submitted[0]) {
        throw new Error('Codex did not submit exactly one structured reply proposal.')
      }
      return submit.submitted[0]
    },
    images: input.images,
    prompt: input.prompt,
    settings: selectedCodexSettings(),
    systemPrompt: input.systemPrompt,
    timeoutMs: codexInferenceTimeoutMs(),
    tools: [submit.tool],
  })
}
