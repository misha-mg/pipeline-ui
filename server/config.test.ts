import { describe, expect, it } from 'vitest'
import { configFromEnv } from './config.ts'

describe('configFromEnv', () => {
  it('starts runs from master with pull requests on by default', () => {
    const c = configFromEnv({})
    expect(c.baseBranch).toBe('master')
    expect(c.pullRequests).toBe(true)
  })

  it('takes the base branch, trimmed, and pull requests on or off whatever the branch', () => {
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: ' dev\n' }).baseBranch).toBe('dev')
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: '  ' }).baseBranch).toBe('master')
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: 'dev' }).pullRequests).toBe(true)
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: 'dev', PIPELINE_PULL_REQUESTS: 'off' }).pullRequests).toBe(false)
    expect(configFromEnv({ PIPELINE_PULL_REQUESTS: 'on' }).pullRequests).toBe(true)
    expect(() => configFromEnv({ PIPELINE_PULL_REQUESTS: 'no' })).toThrow(/on or off, not no/)
  })

  it('refuses the code freeze\'s launch-script ref rather than ignore it', () => {
    expect(() => configFromEnv({ PIPELINE_LAUNCH_SESSION_REF: 'pipeline-improvements' })).toThrow(/PIPELINE_LAUNCH_SESSION_REF is no longer read: set PIPELINE_BASE_BRANCH/)
    expect(() => configFromEnv({ PIPELINE_START_SH_REF: 'pipeline-improvements' })).toThrow(/PIPELINE_START_SH_REF is no longer read/)
  })
})
