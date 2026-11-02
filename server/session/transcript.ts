// What an agent of a ticket-pipeline workflow handed back, read from its transcript: such an agent
// ends on a StructuredOutput call, not on text, so the SubagentStop hook's last message is empty
// for it. Read by the session as the agent stops (driver.ts) and by the service when the call was
// not on disk yet then (http/view.ts).
import fs from 'node:fs'

/**
 * What a workflow's agent handed back: its last StructuredOutput call in its transcript, the
 * `report` last under the short fields (confidence, verdict, outcome) as `name: value` lines and
 * any other long field under its own heading. Such an agent ends on that call, not on text, so
 * the hook's last_assistant_message is empty for it. Null when there is no transcript or no call.
 */
export function structuredOutput(transcriptPath: string | undefined): string | null {
  if (!transcriptPath) return null
  let lines: string[]
  try {
    lines = fs.readFileSync(transcriptPath, 'utf8').split('\n')
  } catch {
    return null
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"StructuredOutput"')) continue
    let entry: { type?: string; message?: { content?: unknown } }
    try {
      entry = JSON.parse(lines[i]!)
    } catch {
      continue
    }
    const blocks = entry.type === 'assistant' && Array.isArray(entry.message?.content) ? entry.message.content as { type?: string; name?: string; input?: unknown }[] : []
    // The UI's type check sees this file with ES2022's library, which has no findLast.
    const call = [...blocks].reverse().find((b) => b.type === 'tool_use' && b.name === 'StructuredOutput')
    if (call && typeof call.input === 'object' && call.input !== null) return formatOutput(call.input as Record<string, unknown>)
  }
  return null
}

function formatOutput(fields: Record<string, unknown>): string {
  const short: string[] = []
  const long: string[] = []
  for (const [name, value] of Object.entries(fields)) {
    if (name === 'report' || value === null || value === undefined || value === '') continue
    const strings = Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null
    const line = typeof value === 'string' ? value : strings ? strings.join(', ') : JSON.stringify(value)
    if (!line.includes('\n') && line.length <= 160) short.push(`${name}: ${line}`)
    else long.push(`## ${name}\n${strings ? strings.map((v) => `- ${v}`).join('\n') : typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`)
  }
  const report = typeof fields.report === 'string' ? fields.report : ''
  return [short.join('\n'), report, ...long].filter(Boolean).join('\n\n')
}
