// The session program start.sh runs (PIPELINE_SESSION): argv is the prompt, the settings JSON,
// the MCP config JSON and the runs directory, as start.sh passes them. Events go out as JSON
// lines on the file descriptor PIPELINE_EVENTS_FD names (stdout when unset), so the service
// that started run.sh reads them through a pipe. PIPELINE_SESSION_TRACE names a file every raw
// SDK message is appended to; PIPELINE_SESSION_TIMEOUT_MS bounds the session (the driver's default
// otherwise); PIPELINE_SESSION_PULL_REQUESTS=off refuses every push and pull request. The exit code is 0 for a completed session, 1 for any other ending.
import fs from 'node:fs'
import { driveSession, type SessionEvent } from './driver.ts'

const [prompt, settings, mcpJson, runsDir] = process.argv.slice(2)
if (!prompt || !settings || !mcpJson || !runsDir) {
  console.error('usage: session <prompt> <settings json> <mcp json> <runs dir>')
  process.exit(2)
}

const eventsFd = Number(process.env.PIPELINE_EVENTS_FD ?? 1)
const emit = (event: SessionEvent) => fs.writeSync(eventsFd, JSON.stringify(event) + '\n')
const tracePath = process.env.PIPELINE_SESSION_TRACE
const trace = tracePath ? (m: unknown) => fs.appendFileSync(tracePath, JSON.stringify(m) + '\n') : undefined

const controller = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => controller.abort())

const parsed: unknown = JSON.parse(mcpJson)
const mcpServers =
  typeof parsed === 'object' && parsed !== null && 'mcpServers' in parsed
    ? (parsed as { mcpServers: Parameters<typeof driveSession>[0]['mcpServers'] }).mcpServers
    : {}

const timeoutMs = Number(process.env.PIPELINE_SESSION_TIMEOUT_MS) || undefined
const ending = await driveSession(
  { prompt, settings, mcpServers, runsDir, cwd: process.cwd(), env: process.env, signal: controller.signal, timeoutMs, pullRequests: process.env.PIPELINE_SESSION_PULL_REQUESTS !== 'off' },
  emit,
  { trace, stderr: (d) => process.stderr.write(d) },
)
process.exitCode = ending.kind === 'completed' ? 0 : 1
