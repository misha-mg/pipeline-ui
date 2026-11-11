import { describe, expect, it } from 'vitest'
import { stepOfTrace } from './preparation.ts'

describe('stepOfTrace', () => {
  it("names the step each of prepare-worktree.sh's commands begins, as bash -x traces them", () => {
    // The lines of a real trace (webui origin/dev's prepare-worktree.sh, 2026-11-11), paths shortened.
    const trace = [
      '+ set -euo pipefail',
      '+ key=KAZ-1',
      '+++ git rev-parse --path-format=absolute --git-common-dir',
      '++ dirname /w/.git',
      '+ git -C /w fetch origin',
      '+ git -C /w rev-parse -q --verify refs/remotes/origin/master',
      '+ git -C /w worktree add --no-track -b KAZ-1 /w/.claude/worktrees/KAZ-1 origin/master',
      '+ cd /w/.claude/worktrees/KAZ-1',
      '+ [[ ! -d node_modules ]]',
      '+ npm ci',
      '+ for c in bwrap socat',
      '+ command -v bwrap',
      '+ command -v socat',
      '++ tools/device-mock/rpc.sh board',
      '++ tools/device-mock/control.sh reset',
      '+ reset=\'{"ok":true}\'',
      '+ exec tools/ticket-pipeline/launch-session.sh KAZ-1',
    ]
    expect(trace.map(stepOfTrace).filter(Boolean)).toEqual([
      'git fetch',
      'worktree',
      'npm ci',
      'sandbox check',
      'sandbox check',
      'mock reset',
      'mock reset',
      'session start',
    ])
  })

  it('takes nothing from a line that is not a traced command', () => {
    expect(stepOfTrace('npm ci')).toBeNull()
    expect(stepOfTrace('+ echo "git -C /w fetch origin"')).toBeNull()
    expect(stepOfTrace("+ git -C '/a b' fetch origin")).toBe('git fetch')
  })
})
