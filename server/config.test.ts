import { describe, expect, it } from 'vitest'
import { configFromEnv } from './config.ts'

describe('configFromEnv', () => {
  it('starts runs from master with pull requests on by default, the console open on 0.0.0.0:8787 without a login', () => {
    const c = configFromEnv({})
    expect(c.baseBranch).toBe('master')
    expect(c.pullRequests).toBe('on')
    expect([c.host, c.port]).toEqual(['0.0.0.0', 8787])
    expect(c.guard).toEqual({ hostnames: [], login: null, realm: 'Pipeline console' })
    expect(c.jira).toBeNull()
    expect(c.bitbucket).toBeNull()
    expect(c.backupDir).toBe(`${c.dataDir}/backups`)
    expect(c.logFile).toBe(`${c.dataDir}/serve.log`)
  })

  it('takes the base branch, trimmed, and pull requests on, draft or off whatever the branch', () => {
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: ' dev\n' }).baseBranch).toBe('dev')
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: '  ' }).baseBranch).toBe('master')
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: 'dev' }).pullRequests).toBe('on')
    expect(configFromEnv({ PIPELINE_BASE_BRANCH: 'dev', PIPELINE_PULL_REQUESTS: 'off' }).pullRequests).toBe('off')
    expect(configFromEnv({ PIPELINE_PULL_REQUESTS: 'on' }).pullRequests).toBe('on')
    expect(configFromEnv({ PIPELINE_PULL_REQUESTS: ' draft ' }).pullRequests).toBe('draft')
    expect(() => configFromEnv({ PIPELINE_PULL_REQUESTS: 'no' })).toThrow(/PIPELINE_PULL_REQUESTS is on, draft or off, not no/)
  })

  it("refuses the code freeze's launch-script ref rather than ignore it", () => {
    expect(() => configFromEnv({ PIPELINE_LAUNCH_SESSION_REF: 'pipeline-improvements' })).toThrow(
      /PIPELINE_LAUNCH_SESSION_REF is no longer read: set PIPELINE_BASE_BRANCH/,
    )
    expect(() => configFromEnv({ PIPELINE_START_SH_REF: 'pipeline-improvements' })).toThrow(/PIPELINE_START_SH_REF is no longer read/)
  })

  it('names every bad value at once', () => {
    expect(() => configFromEnv({ PIPELINE_PORT: 'eighty', PIPELINE_PULL_REQUESTS: 'maybe', JIRA_BASE_URL: 'site.atlassian.net' })).toThrow(
      /Bad configuration: PIPELINE_PORT .*; PIPELINE_PULL_REQUESTS is on, draft or off, not maybe; JIRA_BASE_URL is the Jira site with its scheme/,
    )
  })

  it('reads Jira, Bitbucket and the console settings into the config', () => {
    const c = configFromEnv({
      JIRA_BASE_URL: 'https://site.example/',
      JIRA_EMAIL: 'e@x',
      JIRA_API_TOKEN: 't',
      BITBUCKET_TOKEN: 'b',
      PIPELINE_HOSTNAMES: 'Pipeline.local, console',
      PIPELINE_USER: 'op',
      PIPELINE_PASSWORD: 'pw',
      PIPELINE_BACKUP_DIR: '/var/backups/pipeline',
      PIPELINE_LOG_FILE: '/var/log/pipeline.log',
    })
    expect(c.jira).toEqual({ siteUrl: 'https://site.example', email: 'e@x', token: 't', cloudId: undefined })
    expect(c.jiraSite).toBe('https://site.example')
    expect(c.portalUrl).toBeNull()
    expect(c.bitbucket).toEqual({ token: 'b' })
    expect(c.guard).toEqual({ hostnames: ['pipeline.local', 'console'], login: { user: 'op', password: 'pw' }, realm: 'Pipeline console' })
    expect(c.backupDir).toBe('/var/backups/pipeline')
    expect(c.logFile).toBe('/var/log/pipeline.log')
  })

  it('refuses a user without a password and the other way round', () => {
    expect(() => configFromEnv({ PIPELINE_USER: 'op' })).toThrow(/PIPELINE_USER and PIPELINE_PASSWORD go together/)
    expect(() => configFromEnv({ PIPELINE_PASSWORD: 'pw' })).toThrow(/PIPELINE_USER and PIPELINE_PASSWORD go together/)
  })
})
