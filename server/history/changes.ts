// Whether a merged pull request went in as the pipeline opened it: the patch the pipeline pushed
// against the patch that was merged, both read from the webui checkout with `git diff`. The
// pipeline's commit stays there after the push (it was made there), even when the branch was
// rebased or amended on Bitbucket and its old commit is gone from Bitbucket; the merged commits
// arrive with the service's `git fetch origin` before every run, or are fetched here: objects
// only (no ref, no FETCH_HEAD is written, so it cannot race the entry point's fetch). Only the
// lines added and removed are compared: a rebase moves the lines around them and the hunks'
// numbers, and changes nothing that was written. Read only (ADR statistics).
/** Runs git in the webui checkout and resolves with its stdout; rejects when it fails (entry.ts's gitIn). */
export type Git = (args: string[]) => Promise<string>

/** What a patch touches: files, lines added, lines removed. */
export type DiffStat = { files: number; added: number; removed: number }

/** A range of commits as a three-dot diff reads it: what `to` has since it parted from `from`. */
export type Range = { from: string; to: string }

const HASH = /^[0-9a-f]{7,40}$/

/** The patch's file lines and its added and removed lines, trailing space dropped: what was written, not where. */
export function patchLines(patch: string): string[] {
  return patch.split('\n').filter((l) => /^(diff --git |[+-])/.test(l)).map((l) => l.trimEnd())
}

export function diffStat(patch: string): DiffStat {
  const lines = patch.split('\n')
  return {
    files: lines.filter((l) => l.startsWith('diff --git ')).length,
    added: lines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length,
    removed: lines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length,
  }
}

const BRANCH = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/

/**
 * The opened and the merged patch, compared. When a commit is missing from the checkout, the
 * branch the PR was merged into is fetched from origin, its objects only; when the commit is
 * still missing, the answer says which.
 */
export async function compareRanges(git: Git, opened: Range, merged: Range, branch: string | null): Promise<{ changed: boolean; opened: DiffStat; merged: DiffStat } | { why: string }> {
  const hashes = [opened.from, opened.to, merged.from, merged.to]
  const bad = hashes.find((h) => !HASH.test(h))
  if (bad) return { why: `not a commit: ${bad}` }
  const missing = async () => {
    for (const h of hashes) {
      try {
        await git(['cat-file', '-e', `${h}^{commit}`])
      } catch {
        return h
      }
    }
    return null
  }
  const absent = await missing()
  if (absent && branch && BRANCH.test(branch)) {
    try {
      await git(['fetch', '--quiet', '--no-write-fetch-head', '--refmap=', 'origin', branch])
    } catch {
      /* said below, by the commit still missing */
    }
  }
  const still = absent && (await missing())
  if (still) return { why: `commit ${still} is not in the webui checkout` }
  const diff = (r: Range) => git(['diff', '--no-color', '--no-ext-diff', `${r.from}...${r.to}`])
  const [a, b] = await Promise.all([diff(opened), diff(merged)])
  const [la, lb] = [patchLines(a), patchLines(b)]
  return { changed: la.length !== lb.length || la.some((l, i) => l !== lb[i]), opened: diffStat(a), merged: diffStat(b) }
}
