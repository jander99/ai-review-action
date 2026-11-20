/**
 * Unified-diff parsing for review anchoring.
 *
 * Findings cite `file:line` on the new side of the diff, so this tracks the
 * new-file line numbers of each hunk (added + context lines) and lets the
 * pipeline check that a cited range is actually visible in the diff.
 */

export interface DiffHunk {
  readonly header: string;
  readonly text: string;
  /** Added + context lines, numbered on the new file. */
  readonly rightLines: ReadonlySet<number>;
}

export interface DiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly text: string;
  readonly hunks: ReadonlyArray<DiffHunk>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

function stripDiffPath(raw: string): string {
  const path = raw.trim().split('\t')[0];
  const withoutPrefix = path.replace(/^[ab]\//, '');
  return withoutPrefix === '/dev/null' ? '' : withoutPrefix;
}

export function parseUnifiedDiff(diff: string): ReadonlyArray<DiffFile> {
  const files: DiffFile[] = [];
  const lines = diff.split('\n');

  let path = '';
  let status: DiffFile['status'] = 'modified';
  let fileLines: string[] = [];
  let hunks: DiffHunk[] = [];
  let hunkHeader = '';
  let hunkLines: string[] = [];
  let hunkRight = new Set<number>();
  let rightCursor = 0;

  const flushHunk = () => {
    if (hunkHeader) {
      hunks.push({ header: hunkHeader, text: hunkLines.join('\n'), rightLines: hunkRight });
    }
    hunkHeader = '';
    hunkLines = [];
    hunkRight = new Set();
    rightCursor = 0;
  };
  const flushFile = () => {
    flushHunk();
    if (path) {
      files.push({ path, status, text: fileLines.join('\n'), hunks });
    }
    path = '';
    status = 'modified';
    fileLines = [];
    hunks = [];
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      path = match ? match[2] : '';
      fileLines = [line];
      continue;
    }
    if (!path && line.trim() === '') {
      continue;
    }
    fileLines.push(line);

    if (hunkHeader || line.startsWith('@@')) {
      const match = line.match(HUNK_HEADER);
      if (match) {
        flushHunk();
        hunkHeader = line;
        hunkLines = [line];
        rightCursor = Number.parseInt(match[1], 10);
        continue;
      }
    }
    if (line.startsWith('new file mode')) {
      status = 'added';
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      status = 'deleted';
      continue;
    }
    if (line.startsWith('rename from')) {
      status = 'renamed';
      continue;
    }
    if (line.startsWith('+++')) {
      if (stripDiffPath(line.slice(4)) === '') {
        status = 'deleted';
      }
      continue;
    }
    if (line.startsWith('---')) {
      continue;
    }
    if (!hunkHeader) {
      continue;
    }
    hunkLines.push(line);
    if (line.startsWith('+')) {
      hunkRight.add(rightCursor);
      rightCursor += 1;
    } else if (line.startsWith(' ')) {
      hunkRight.add(rightCursor);
      rightCursor += 1;
    } else if (line.startsWith('-')) {
      // removed line: no new-file number
    } else {
      // '\ No newline at end of file' and similar annotations
    }
  }
  flushFile();

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

/** The single hunk whose right-side lines contain every line in [startLine, endLine], or null. */
export function findAnchorHunk(file: DiffFile, startLine: number, endLine: number): DiffHunk | null {
  if (startLine > endLine) {
    return null;
  }
  for (const hunk of file.hunks) {
    let all = true;
    for (let n = startLine; n <= endLine; n++) {
      if (!hunk.rightLines.has(n)) {
        all = false;
        break;
      }
    }
    if (all) {
      return hunk;
    }
  }
  return null;
}

/** Added + removed lines, excluding file headers. */
export function countChangedLines(files: ReadonlyArray<DiffFile>): number {
  let count = 0;
  for (const file of files) {
    for (const line of file.text.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) {
        continue;
      }
      if (line.startsWith('+') || line.startsWith('-')) {
        count += 1;
      }
    }
  }
  return count;
}
