import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { structuredOutput } from './transcript.ts'
import { DRAFTS_ONLY, driveSession, endingOf, publishing, readyPullRequest, sessionEnv, withoutPublishing, withoutReady, type QueryFn, type SessionEvent } from './driver.ts'

const INPUT = {
  prompt: '/ticket-pipeline KAZ-1',
  settings: '{}',
  mcpServers: {},
  runsDir: '/runs',
  cwd: '/wt',
  env: { HOME: '/home/x', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_OAUTH_TOKEN: 't' },
}

const init = {
  type: 'system', subtype: 'init', claude_code_version: '2.1.311', model: 'claude-opus-5-5',
  mcp_servers: [{ name: 'jira', status: 'connected' }],
} as unknown as SDKMessage

const result = (over: Record<string, unknown> = {}) =>
  ({
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, total_cost_usd: 1.5,
    result: 'Failed run: blocked:underspecified', errors: [], ...over,
  }) as unknown as SDKMessage

/** A query whose stream yields `messages`; when a message is a function it fires the hooks. */
function fakeQuery(messages: (SDKMessage | ((hooks: NonNullable<Parameters<QueryFn>[0]['options']>['hooks']) => Promise<void>))[]): QueryFn {
  return (params) => ({
    async *[Symbol.asyncIterator]() {
      for (const m of messages) {
        if (typeof m === 'function') await m(params.options?.hooks)
        else yield m
      }
    },
  })
}

const fireAgent = (event: 'SubagentStart' | 'SubagentStop', agent: string, lastMessage?: string, transcript?: string) =>
  async (hooks: NonNullable<Parameters<QueryFn>[0]['options']>['hooks']) => {
    const hook = hooks?.[event]?.[0]?.hooks[0]
    if (!hook) throw new Error(`no ${event} hook`)
    await hook({ hook_event_name: event, agent_type: agent, agent_id: 'a1', session_id: 's', transcript_path: '', cwd: '/wt', last_assistant_message: lastMessage, agent_transcript_path: transcript } as never, undefined, { signal: new AbortController().signal })
  }

async function run(query: QueryFn, over: Partial<Parameters<typeof driveSession>[0]> = {}) {
  const events: SessionEvent[] = []
  const ending = await driveSession({ ...INPUT, ...over }, (e) => events.push(e), { query })
  return { events, ending }
}

describe('driveSession', () => {
  it('reports init, the stages from the hooks, each turn and a completed ending', async () => {
    const { events, ending } = await run(fakeQuery([
      init, fireAgent('SubagentStart', 'ticket-investigator'), fireAgent('SubagentStop', 'ticket-investigator', '## Brief\nconfidence high'),
      fireAgent('SubagentStart', 'diff-preparer'), fireAgent('SubagentStop', 'diff-preparer'), result(),
    ]))
    expect(events.map((e) => e.type)).toEqual(['init', 'stage-start', 'stage-stop', 'stage-start', 'stage-stop', 'turn', 'ended'])
    expect(events[0]).toMatchObject({ version: '2.1.311', model: 'claude-opus-5-5', mcp: { jira: 'connected' } })
    expect(events[1]).toMatchObject({ agent: 'ticket-investigator', agentId: 'a1' })
    expect(events[2]).toMatchObject({ type: 'stage-stop', agent: 'ticket-investigator', text: '## Brief\nconfidence high' })
    expect(events[4]).not.toHaveProperty('text')
    expect(ending).toEqual({ kind: 'completed', text: 'Failed run: blocked:underspecified', costUsd: 1.5 })
  })

  it('takes the last result as the ending when the session has several turns', async () => {
    const { ending } = await run(fakeQuery([init, result({ result: 'workflow started' }), result({ result: 'done' })]))
    expect(ending).toMatchObject({ kind: 'completed', text: 'done' })
  })

  it('ends on the usage limit when the rate limit was rejected', async () => {
    const { events, ending } = await run(fakeQuery([
      init,
      { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1700000000, rateLimitType: 'five_hour' } } as unknown as SDKMessage,
      result({ is_error: true, result: 'You\'ve hit your limit' }),
    ]))
    expect(events).toContainEqual(expect.objectContaining({ type: 'rate-limit', status: 'rejected', resetsAt: 1700000000 }))
    expect(ending).toEqual({ kind: 'usage-limit', resetsAt: 1700000000, text: 'You\'ve hit your limit' })
  })

  it('ends aborted when cancelled, and does not report what the SDK throws then', async () => {
    const controller = new AbortController()
    const query: QueryFn = (params) => ({
      async *[Symbol.asyncIterator]() {
        yield init
        controller.abort()
        if (params.options?.abortController?.signal.aborted) throw new Error('aborted by user')
      },
    })
    const { ending } = await run(query, { signal: controller.signal })
    expect(ending).toEqual({ kind: 'aborted', reason: 'cancelled' })
  })

  it('ends with an error when the SDK throws, and no-result when the stream ends without one', async () => {
    const thrower: QueryFn = () => ({ async *[Symbol.asyncIterator]() { throw new Error('spawn failed') } })
    expect((await run(thrower)).ending).toEqual({ kind: 'error', reason: 'spawn failed' })
    expect((await run(fakeQuery([init]))).ending).toEqual({ kind: 'no-result' })
  })
})

describe('pull requests off', () => {
  const LAUNCH_SETTINGS = JSON.stringify({
    permissions: { allow: ['Workflow', 'mcp__bitbucket__createPullRequest', 'mcp__bitbucket__createDraftPullRequest', 'Bash(git push origin KAZ-1)'], deny: ['Read(~/.ssh/**)'] },
    sandbox: { excludedCommands: ['git push origin KAZ-1'], filesystem: { allowWrite: ['/runs'] } },
  })

  it('takes the push and the pull request, ready or draft, out of the settings and denies them', () => {
    expect(JSON.parse(withoutPublishing(LAUNCH_SETTINGS))).toEqual({
      permissions: { allow: ['Workflow'], deny: ['Read(~/.ssh/**)', 'Bash(git push:*)', 'mcp__bitbucket__createPullRequest', 'mcp__bitbucket__createDraftPullRequest'] },
      sandbox: { excludedCommands: [], filesystem: { allowWrite: ['/runs'] } },
    })
    expect(withoutPublishing('not json')).toBe('not json')
  })

  it('knows a push and a pull request from other calls', () => {
    expect(publishing('mcp__bitbucket__createPullRequest', {})).toBe('open a pull request')
    expect(publishing('mcp__bitbucket__createDraftPullRequest', {})).toBe('open a draft pull request')
    for (const command of ['git push origin KAZ-1', 'git -C /wt push', 'cd /wt && git push -u origin HEAD', 'git -c a=b push --force']) expect(publishing('Bash', { command })).not.toBeNull()
    for (const command of ['git status', 'git commit -m "push the button"', 'echo git', 'npm run push']) expect(publishing('Bash', { command })).toBeNull()
    expect(publishing('mcp__bitbucket__getPullRequest', {})).toBeNull()
  })

  it('refuses them through a PreToolUse hook and reports each refusal', async () => {
    let options: Parameters<QueryFn>[0]['options']
    const decisions: unknown[] = []
    const query: QueryFn = (params) => {
      options = params.options
      return {
        async *[Symbol.asyncIterator]() {
          const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks[0]
          if (!hook) throw new Error('no PreToolUse hook')
          for (const [tool_name, tool_input] of [['Bash', { command: 'git push origin KAZ-1' }], ['mcp__bitbucket__createPullRequest', {}], ['Bash', { command: 'git status' }]] as const) {
            decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '/wt' } as never, 'u', { signal: new AbortController().signal }))
          }
          yield result({ result: 'Failed run: blocked:tooling' })
        },
      }
    }
    const { events } = await run(query, { settings: LAUNCH_SETTINGS, pullRequests: 'off' })
    expect(JSON.parse(options!.settings as string).permissions.deny).toContain('Bash(git push:*)')
    expect(decisions.map((d) => (d as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision ?? 'none')).toEqual(['deny', 'deny', 'none'])
    expect(events.filter((e) => e.type === 'refused')).toEqual([
      expect.objectContaining({ tool: 'Bash', detail: 'git push origin KAZ-1' }),
      expect.objectContaining({ tool: 'mcp__bitbucket__createPullRequest', detail: 'open a pull request' }),
    ])
  })

  it('leaves the settings and the hooks alone by default', async () => {
    let options: Parameters<QueryFn>[0]['options']
    await run((params) => { options = params.options; return fakeQuery([result()])(params) }, { settings: LAUNCH_SETTINGS })
    expect(options!.settings).toBe(LAUNCH_SETTINGS)
    expect(options!.hooks?.PreToolUse).toBeUndefined()
  })
})

describe('pull requests as drafts only', () => {
  const LAUNCH_SETTINGS = JSON.stringify({
    permissions: { allow: ['Workflow', 'mcp__bitbucket__createPullRequest', 'mcp__bitbucket__createDraftPullRequest', 'Bash(git push origin KAZ-1)'], deny: ['Read(~/.ssh/**)'] },
    sandbox: { excludedCommands: ['git push origin KAZ-1'] },
  })

  it('no longer allows the ready pull request, and leaves the push, the draft and the deny list alone', () => {
    expect(JSON.parse(withoutReady(LAUNCH_SETTINGS))).toEqual({
      permissions: { allow: ['Workflow', 'mcp__bitbucket__createDraftPullRequest', 'Bash(git push origin KAZ-1)'], deny: ['Read(~/.ssh/**)'] },
      sandbox: { excludedCommands: ['git push origin KAZ-1'] },
    })
    expect(withoutReady('not json')).toBe('not json')
    expect(readyPullRequest('mcp__bitbucket__createDraftPullRequest')).toBeNull()
  })

  it('sends a ready pull request to the draft tool and lets the push and the draft through', async () => {
    let options: Parameters<QueryFn>[0]['options']
    const decisions: unknown[] = []
    const query: QueryFn = (params) => {
      options = params.options
      return {
        async *[Symbol.asyncIterator]() {
          const hook = params.options?.hooks?.PreToolUse?.[0]?.hooks[0]
          if (!hook) throw new Error('no PreToolUse hook')
          for (const [tool_name, tool_input] of [['Bash', { command: 'git push origin KAZ-1' }], ['mcp__bitbucket__createPullRequest', {}], ['mcp__bitbucket__createDraftPullRequest', {}]] as const) {
            decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id: 'u', session_id: 's', transcript_path: '', cwd: '/wt' } as never, 'u', { signal: new AbortController().signal }))
          }
          yield result({ result: 'Run complete: done:pr-opened' })
        },
      }
    }
    const { events } = await run(query, { settings: LAUNCH_SETTINGS, pullRequests: 'draft' })
    expect(JSON.parse(options!.settings as string).permissions.allow).not.toContain('mcp__bitbucket__createPullRequest')
    const outputs = decisions.map((d) => (d as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput)
    expect(outputs.map((o) => o?.permissionDecision ?? 'none')).toEqual(['none', 'deny', 'none'])
    expect(outputs[1]?.permissionDecisionReason).toBe(DRAFTS_ONLY)
    expect(DRAFTS_ONLY).toContain('mcp__bitbucket__createDraftPullRequest')
    expect(events.filter((e) => e.type === 'refused')).toEqual([expect.objectContaining({ tool: 'mcp__bitbucket__createPullRequest' })])
  })
})

describe('endingOf', () => {
  it('maps an error subtype and an API error to error', () => {
    expect(endingOf({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: ['too many turns'] } as never, null))
      .toEqual({ kind: 'error', reason: 'error_max_turns: too many turns' })
    expect(endingOf({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500', errors: [] } as never, null))
      .toEqual({ kind: 'error', reason: 'API Error: 500' })
  })
})

describe('sessionEnv', () => {
  it('drops the API keys, keeps the rest and sets no wait ceiling', () => {
    expect(sessionEnv(INPUT.env)).toEqual({ HOME: '/home/x', CLAUDE_CODE_OAUTH_TOKEN: 't', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' })
  })
})

describe('an agent of a workflow', () => {
  it('hands back its StructuredOutput call, read from its transcript, waiting for the line when it is late', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-transcript-'))
    const file = path.join(dir, 'agent.jsonl')
    fs.writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'investigate' } }) + '\n')
    // The call reaches the transcript 300 ms after the agent stops.
    setTimeout(() => fs.appendFileSync(file, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input: { confidence: 'high', report: '## Brief' } }] } }) + '\n'), 300)
    const { events } = await run(fakeQuery([init, fireAgent('SubagentStart', 'ticket-investigator'), fireAgent('SubagentStop', 'ticket-investigator', undefined, file), result()]))
    expect(events.find((e) => e.type === 'stage-stop')).toMatchObject({ text: 'confidence: high\n\n## Brief', transcript: file })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('structuredOutput', () => {
  it('takes the last StructuredOutput call of a transcript: short fields, the report, then long fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-transcript-'))
    const file = path.join(dir, 'agent.jsonl')
    const call = (input: unknown) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'StructuredOutput', input }] } })
    fs.writeFileSync(file, [
      call({ report: 'first try' }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Structured output provided successfully' }] } }),
      call({ confidence: 'medium', report: '## Brief\nthe cause', user_visible: true, mocks: ['a', 'b'], assumptions: ['one '.repeat(40), 'two'], empty: '' }),
      'not json',
    ].join('\n'))
    expect(structuredOutput(file)).toBe(`confidence: medium\nuser_visible: true\nmocks: a, b\n\n## Brief\nthe cause\n\n## assumptions\n- ${'one '.repeat(40)}\n- two`)
    expect(structuredOutput(path.join(dir, 'missing.jsonl'))).toBeNull()
    expect(structuredOutput(undefined)).toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
