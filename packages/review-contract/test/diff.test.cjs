const { test } = require('node:test');
const assert = require('node:assert');
const { parseUnifiedDiff, findAnchorHunk, countChangedLines } = require('../dist/index.cjs');

const TWO_HUNKS = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,3 +1,4 @@',
  ' one',
  '+two',
  ' three',
  ' four',
  '@@ -10,2 +10,3 @@',
  ' ten',
  '+eleven',
  ' twelve',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1 +1 @@',
  '-old',
  '+new',
].join('\n');

test('findAnchorHunk: a range inside one hunk resolves, one spanning hunks does not', () => {
  const [a] = parseUnifiedDiff(TWO_HUNKS).filter((f) => f.path === 'a.ts');
  assert.ok(findAnchorHunk(a, 10, 12));
  assert.equal(findAnchorHunk(a, 3, 11), null);
});

test('deleted files keep the a/ path and have no right lines', () => {
  const diff = ['diff --git a/gone.ts b/gone.ts', 'deleted file mode 100644', '--- a/gone.ts', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-x', '-y'].join('\n');
  const [f] = parseUnifiedDiff(diff);
  assert.equal(f.status, 'deleted');
  assert.equal(f.path, 'gone.ts');
  assert.equal(f.hunks[0].rightLines.size, 0);
});

test('files come back sorted by path', () => {
  const diff = ['diff --git a/z.ts b/z.ts', '--- a/z.ts', '+++ b/z.ts', '@@ -1 +1 @@', '-a', '+b', 'diff --git a/m.ts b/m.ts', '--- a/m.ts', '+++ b/m.ts', '@@ -1 +1 @@', '-a', '+b'].join('\n');
  assert.deepEqual(parseUnifiedDiff(diff).map((f) => f.path), ['m.ts', 'z.ts']);
});

test('countChangedLines excludes headers and context', () => {
  assert.equal(countChangedLines(parseUnifiedDiff(TWO_HUNKS)), 4);
});

test('parseUnifiedDiff ignores +++/--- content lines inside hunks', () => {
  const diff = [
    'diff --git a/a.md b/a.md',
    'index 1..2 100644',
    '--- a/a.md',
    '+++ b/a.md',
    '@@ -1,2 +1,3 @@',
    ' keep',
    '+++',
    '+x',
    '',
  ].join('\n');
  const [file] = parseUnifiedDiff(diff);
  assert.equal(file.status, 'modified');
  assert.deepEqual([...file.hunks[0].rightLines], [1, 2, 3]);
});
