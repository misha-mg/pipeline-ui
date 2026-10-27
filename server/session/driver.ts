// Drives one ticket-pipeline session through the Claude Agent SDK and reports what happens in it
// as typed events: the stages (from the SubagentStart/SubagentStop hooks), rate limits, API
// retries, each turn's result, and one ending. Everything else the SDK streams is passed to the
// optional trace sink and otherwise ignored. See .about/prd/pipeline-web-ui.md.
import { USAGE_LIMIT_ERROR_PREFIXES, query as sdkQuery } from '@anthropic-ai/claude-agent-sdk'
import type {
  HookCallback,
  HookCallbackMatcher,
  McpServerConfig,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'

export type SessionInput = {
  prompt: string
  /** The settings JSON start.sh built (sandbox, permissions). */
  settings: string
  mcpServers: Record<string, McpServerConfig>
  /** The .pipeline-runs directory the session may write to. */
  runsDir: string
  /** The ticket's worktree. */
  cwd: string
  /** The environment the session gets; API keys are removed so the subscription token is used. */
  env: Record<string, string | undefined>
  /** Cancels the session; the ending is then `aborted`. */
  signal?: AbortSignal
  timeoutMs?: number
}

export type SessionEvent =
  | { type: 'init'; at: string; version: string; model: string; mcp: Record<string, string> }
  | { type: 'stage-start'; at: string; agent: string; agentId: string }
  | { type: 'stage-stop'; at: string; agent: string; agentId: string }
  | { type: 'rate-limit'; at: string; status: SDKRateLimitInfo['status']; resetsAt?: number; rateLimitType?: string }
  | { type: 'api-retry'; at: string; attempt: number; error?: string }
  | { type: 'turn'; at: string; subtype: SDKResultMessage['subtype']; isError: boolean; turns: number; costUsd: number; text: string }
  | { type: 'ended'; at: string; ending: SessionEnding }

export type SessionEnding =
  | { kind: 'completed'; text: string; costUsd: number }
  | { kind: 'usage-limit'; resetsAt?: number; text: string }
  | { kind: 'error'; reason: string }
  | { kind: 'aborted'; reason: 'cancelled' | 'timeout' }
  | { kind: 'no-result' }

/** The one SDK call the driver makes; a test passes a fake. */
export type QueryFn = (params: Parameters<typeof sdkQuery>[0]) => AsyncIterable<SDKMessage>

export type SessionDeps = {
  query?: QueryFn
  /** Every raw SDK message, for a debug log. */
  trace?: (message: SDKMessage) => void
  /** The SDK process's stderr. */
  stderr?: (data: string) => void
}

const DEFAULT_TIMEOUT_MS = 120 * 60 * 1000
const TEXT_LIMIT = 2000

/**
 * Runs the session to its end and returns its ending; events arrive through `emit` as they
 * happen, the ending last. Never throws for what the session does: an SDK error is the `error`
 * ending.
 */
export async function driveSession(
  input: SessionInput,
  emit: (event: SessionEvent) => void,
  deps: SessionDeps = {},
): Promise<SessionEnding> {
  const query = deps.query ?? sdkQuery
  const now = () => new Date().toISOString()
  const controller = new AbortController()
  let abortReason: 'cancelled' | 'timeout' | null = null
  const abort = (reason: 'cancelled' | 'timeout') => {
    abortReason ??= reason
    controller.abort()
  }
  if (input.signal?.aborted) abort('cancelled')
  input.signal?.addEventListener('abort', () => abort('cancelled'), { once: true })
  const timer = setTimeout(() => abort('timeout'), input.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  const onAgent: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name === 'SubagentStart') {
      emit({ type: 'stage-start', at: now(), agent: hookInput.agent_type, agentId: hookInput.agent_id })
    } else if (hookInput.hook_event_name === 'SubagentStop') {
      emit({ type: 'stage-stop', at: now(), agent: hookInput.agent_type, agentId: hookInput.agent_id })
    }
    return {}
  }
  const matcher: HookCallbackMatcher = { hooks: [onAgent] }

  let lastResult: SDKResultMessage | null = null
  let lastRateLimit: SDKRateLimitInfo | null = null
  let ending: SessionEnding
  try {
    const stream = query({
      prompt: input.prompt,
      options: {
        cwd: input.cwd,
        settings: input.settings,
        mcpServers: input.mcpServers,
        permissionMode: 'dontAsk',
        additionalDirectories: [input.runsDir],
        hooks: { SubagentStart: [matcher], SubagentStop: [matcher] },
        env: sessionEnv(input.env),
        abortController: controller,
        stderr: deps.stderr,
      },
    })
    for await (const message of stream) {
      deps.trace?.(message)
      if (message.type === 'system' && message.subtype === 'init') {
        emit({
          type: 'init',
          at: now(),
          version: message.claude_code_version,
          model: message.model,
          mcp: Object.fromEntries(message.mcp_servers.map((s) => [s.name, s.status])),
        })
      } else if (message.type === 'system' && message.subtype === 'api_retry') {
        emit({ type: 'api-retry', at: now(), attempt: message.attempt, error: message.error })
      } else if (message.type === 'rate_limit_event') {
        lastRateLimit = message.rate_limit_info
        const { status, resetsAt, rateLimitType } = message.rate_limit_info
        emit({ type: 'rate-limit', at: now(), status, resetsAt, rateLimitType })
      } else if (message.type === 'result') {
        lastResult = message
        emit({
          type: 'turn',
          at: now(),
          subtype: message.subtype,
          isError: message.is_error,
          turns: message.num_turns,
          costUsd: message.total_cost_usd,
          text: resultText(message),
        })
      }
    }
    ending = abortReason ? { kind: 'aborted', reason: abortReason } : endingOf(lastResult, lastRateLimit)
  } catch (error) {
    ending = abortReason
      ? { kind: 'aborted', reason: abortReason }
      : { kind: 'error', reason: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
  emit({ type: 'ended', at: now(), ending })
  return ending
}

/** The session's environment: no API key, so the CLI signs in with the subscription token; no
 *  wait ceiling, so a workflow running in the background is waited for however long it takes. */
export function sessionEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== 'ANTHROPIC_API_KEY' && k !== 'ANTHROPIC_AUTH_TOKEN') env[k] = v
  }
  env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS = '0'
  return env
}

/** The ending the last turn's result and the last rate-limit event give, when nothing aborted. */
export function endingOf(result: SDKResultMessage | null, rateLimit: SDKRateLimitInfo | null): SessionEnding {
  if (!result) return { kind: 'no-result' }
  const text = resultText(result)
  const hitUsageLimit =
    rateLimit?.status === 'rejected' || USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p))
  if (hitUsageLimit) return { kind: 'usage-limit', resetsAt: rateLimit?.resetsAt, text }
  if (result.subtype !== 'success') return { kind: 'error', reason: `${result.subtype}: ${result.errors.join('; ') || text}` }
  if (result.is_error) return { kind: 'error', reason: text || 'the turn ended on an API error' }
  return { kind: 'completed', text, costUsd: result.total_cost_usd }
}

function resultText(result: SDKResultMessage): string {
  const text = result.subtype === 'success' ? result.result : result.errors.join('; ')
  return text.length > TEXT_LIMIT ? text.slice(0, TEXT_LIMIT) : text
}
