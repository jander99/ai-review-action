/**
 * Generates the study fixtures: for each squash commit, the pathspec-filtered
 * diff (capped), the text of touched files, and three hand-written findings.
 *
 * Run once from the repo root: node packages/review-pipeline/study/generate-fixtures.cjs
 */

const { execFileSync } = require('node:child_process');
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const { findingId } = require('../../review-contract/dist/index.cjs');

const SHAS = ['08ce3f1', '6b6a416', '06b3c7e', '9b2a47f', 'da63f0b', '9b3cbf4', '5f297fc', 'baccc98', '9587bc5', '1fac215'];
const CAP = 200_000;
const EXCLUDES = ['.', ':(exclude)dist/**', ':(exclude)packages/*/dist*/**'];

const git = (args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

const OUT = join(__dirname, 'fixtures');
mkdirSync(OUT, { recursive: true });

for (const sha of SHAS) {
  const changed = git(['diff', '--name-only', `${sha}~1`, sha])
    .split('\n')
    .filter((p) => p && !/^dist\/|(^|\/)dist[^/]*\//.test(p))
    .slice(0, 12);
  const files = {};
  for (const p of changed) {
    try { files[p] = git(['show', `${sha}:${p}`]); } catch { /* deleted */ }
  }
  const diff = git(['diff', `${sha}~1`, sha, '--', ...EXCLUDES]).slice(0, CAP);
  const file = changed[0] ?? 'unknown';

  const findings = [
    {
      id: findingId(file, 'changed file is missing its test'),
      file,
      relatedFiles: [],
      startLine: 1,
      endLine: 40,
      title: 'changed file is missing its test',
      claim: `${file} changed in this commit, but no test file for it appears in the diff.`,
      evidence: 'The diff lists no matching test/*.test.cjs for this source file.',
      suggestedFix: null,
      expected: 'borderline',
    },
    {
      id: findingId(file, 'error paths in new code are not exercised'),
      file,
      relatedFiles: [],
      startLine: 1,
      endLine: 120,
      title: 'error paths in new code are not exercised',
      claim: 'The new code branches on errors but the added tests only cover the happy path.',
      evidence: 'Added tests name only success cases; catch/else branches have no assertions.',
      suggestedFix: null,
      expected: 'borderline',
    },
    {
      id: findingId(file, 'hardcoded value should be configuration'),
      file,
      relatedFiles: [],
      startLine: 1,
      endLine: 20,
      title: 'hardcoded value should be configuration',
      claim: 'A magic number or literal was introduced where an existing constant or input could be used.',
      evidence: 'Search the file for a literal that duplicates an existing named constant.',
      suggestedFix: null,
      expected: 'borderline',
    },
  ];

  writeFileSync(join(OUT, `${sha}.json`), JSON.stringify({ sha, diff, files, findings }, null, 2) + '\n');
  console.log(`${sha} ${Object.keys(files).length} files, diff ${diff.length} chars`);
}
