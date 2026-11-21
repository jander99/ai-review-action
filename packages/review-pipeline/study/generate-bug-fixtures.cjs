/**
 * Known-bug fixtures. PR #49 (commit 122576e) fixed real defects that shipped
 * in v2. Reversing each fix puts the original bug back as "the change", so a
 * reviewer that works should flag it. Ground truth = the lines the fix touched.
 *
 * Run from the repo root: node packages/review-pipeline/study/generate-bug-fixtures.cjs
 */
const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

const FIX = '122576e';
const BUGGY = `${FIX}~1`;
const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const BUGS = [
  { name: 'post-review-swallowed-error', file: 'packages/post-comment/src/review.ts', description: 'Non-422 createReview errors, and a failed fallback retry, are swallowed and reported as success with an empty reviewUrl.' },
  { name: 'diff-header-in-hunk', file: 'packages/review-contract/src/diff.ts', description: 'Lines starting with +++ or --- inside a hunk are treated as file headers, so added/removed lines like "++x" or "-- comment" corrupt the parse.' },
  { name: 'diff-section-split', file: 'packages/review-pipeline/src/context.ts', description: 'splitDiffSections re-derives paths and string-searches for markers; renames, quoted paths, or repeated markers split wrongly or drop sections.' },
  { name: 'render-unsanitized', file: 'packages/review-pipeline/src/render.ts', description: 'Model-controlled title, claim and file path are rendered unsanitized, so newlines or markdown in them break the review document format.' },
  { name: 'event-on-failed-review', file: 'packages/root-action/src/orchestrate.ts', description: 'A failed or incomplete pipeline run can still submit an APPROVE/REQUEST_CHANGES event; only a completed review may.' },
  { name: 'git-diff-failure-silent', file: 'packages/run-reviews/src/main.ts', description: 'A failing git diff (missing base commit) returns an empty diff, so the action silently reports nothing to review; large diffs hitting ENOBUFS are also discarded.' },
  { name: 'secrets-passed-as-env', file: '.github/workflows/ai-review.yml', description: 'API keys are passed as env vars but the action reads inputs, not env, so the keys never reach the adapters.' },
];

/** Drop the removed (fix) side so the diff cannot leak the answer; recompute hunk counts. */
function stripFixSide(diff) {
  const out = [];
  let hunk = null;
  const flush = () => {
    if (!hunk) return;
    const oldCount = hunk.lines.filter((l) => l[0] === ' ').length;
    const newCount = hunk.lines.filter((l) => l[0] === ' ' || l[0] === '+').length;
    out.push(`@@ -${hunk.start},${oldCount} +${hunk.start},${newCount} @@`, ...hunk.lines);
    hunk = null;
  };
  for (const line of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (h) { flush(); hunk = { start: Number(h[1]), lines: [] }; continue; }
    if (!hunk) { if (line) out.push(line); continue; }
    if (line.startsWith('-')) continue;
    if (line !== '') hunk.lines.push(line);
  }
  flush();
  return out.join('\n') + '\n';
}

mkdirSync(join(__dirname, 'bug-fixtures'), { recursive: true });
for (const bug of BUGS) {
  // Reverse diff: the buggy side becomes "new".
  const diff = stripFixSide(git(['diff', '-U3', FIX, BUGGY, '--', bug.file]));
  const ranges = [];
  let newLine = 0;
  let cur = null;
  for (const line of diff.split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
    if (h) { newLine = Number(h[1]); cur = null; continue; }
    if (!newLine) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      if (cur && cur.endLine === newLine - 1) cur.endLine = newLine; else { cur = { startLine: newLine, endLine: newLine }; ranges.push(cur); }
      newLine++;
    } else if (line.startsWith('-')) { /* removed side: no new-line advance */ } else { newLine++; cur = null; }
  }
  const files = { [bug.file]: git(['show', `${BUGGY}:${bug.file}`]) };
  const out = { sha: `bug-${bug.name}`, diff, files, bug: { file: bug.file, description: bug.description, ranges } };
  writeFileSync(join(__dirname, 'bug-fixtures', `${bug.name}.json`), JSON.stringify(out, null, 2) + '\n');
  console.log(bug.name, JSON.stringify(ranges));
}
