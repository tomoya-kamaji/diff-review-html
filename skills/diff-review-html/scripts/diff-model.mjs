#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';

const USAGE = `Usage:
  node diff-model.mjs [--uncommitted | --base <ref> | --range <a>..<b>] [--cwd <repo>] --out <model.json>

  引数なしのモード: git status が非空なら --uncommitted、空なら既定ブランチとの merge-base
`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { cwd: process.cwd(), outPath: null, mode: null, base: null, range: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--uncommitted') {
      if (out.mode) fail('モードは1つだけ指定してください');
      out.mode = 'uncommitted';
      continue;
    }
    if (arg === '--base') {
      if (out.mode) fail('モードは1つだけ指定してください');
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('--base には ref が必要です');
      out.mode = 'base';
      out.base = value;
      i += 1;
      continue;
    }
    if (arg === '--range') {
      if (out.mode) fail('モードは1つだけ指定してください');
      const value = argv[i + 1];
      if (!value || !value.includes('..')) fail('--range は a..b 形式です');
      out.mode = 'range';
      out.range = value;
      i += 1;
      continue;
    }
    if (arg === '--cwd') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('--cwd にはパスが必要です');
      out.cwd = resolve(value);
      i += 1;
      continue;
    }
    if (arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail('--out にはパスが必要です');
      out.outPath = resolve(value);
      i += 1;
      continue;
    }
    fail(`不明な引数: ${arg}\n${USAGE}`);
  }
  if (!out.outPath) fail(`--out は必須です\n${USAGE}`);
  return out;
}

function git(args, cwd, { allowFail = false, env = {} } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0 && result.status !== 1 && !allowFail) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(detail || `git ${args.join(' ')} が失敗しました (exit ${result.status})`);
  }
  if (result.status !== 0 && result.status !== 1 && allowFail) {
    return { ok: false, stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
  }
  return { ok: result.status === 0 || result.status === 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

function gitStrict(args, cwd) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(detail || `git ${args.join(' ')} が失敗しました (exit ${result.status})`);
  }
  return (result.stdout ?? '').trim();
}

function refExists(cwd, ref) {
  const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8' });
  return result.status === 0;
}

function detectDefaultBase(cwd) {
  const symbolic = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], cwd, { allowFail: true });
  if (symbolic.ok && symbolic.status === 0) {
    const ref = symbolic.stdout.trim();
    if (ref) return ref;
  }
  for (const name of ['main', 'master', 'staging']) {
    if (refExists(cwd, `refs/remotes/origin/${name}`)) return `origin/${name}`;
    if (refExists(cwd, `refs/heads/${name}`)) return name;
  }
  return null;
}

function shortDefaultName(baseRef) {
  return baseRef.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '').replace(/^refs\/heads\//, '');
}

function sanitizeSlug(branch, defaultShort) {
  if (!branch || branch === 'HEAD') return null;
  const short = branch.replace(/^refs\/heads\//, '');
  if (short === defaultShort || short === 'main' || short === 'master' || short === 'staging') return null;
  const prefixes = new Set(['feature', 'feat', 'fix', 'chore', 'docs', 'refactor', 'hotfix', 'bugfix', 'release', 'perf', 'test', 'ci', 'build', 'revert']);
  const parts = short.split('/');
  const rest = parts.length > 1 && prefixes.has(parts[0]) ? parts.slice(1).join('/') : short;
  const cleaned = rest
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return cleaned || null;
}

function makeId(prefix, n) {
  const width = n >= 1000 ? String(n).length : 3;
  return `${prefix}${String(n).padStart(width, '0')}`;
}

function parseGitDiffPaths(line) {
  const rest = line.slice('diff --git '.length).trim();
  const unquote = (s) => {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
      return s.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
    }
    return s;
  };
  const stripAb = (p) => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);
  if (rest.startsWith('"')) {
    const match = rest.match(/^("(?:\\.|[^"\\])*")\s+("(?:\\.|[^"\\])*")$/);
    if (match) return { old: stripAb(unquote(match[1])), neu: stripAb(unquote(match[2])) };
  }
  const marker = ' b/';
  const idx = rest.indexOf(marker);
  if (rest.startsWith('a/') && idx !== -1) {
    return { old: rest.slice(2, idx), neu: rest.slice(idx + 3) };
  }
  const parts = rest.split(' ');
  if (parts.length >= 2) {
    return { old: stripAb(unquote(parts[0])), neu: stripAb(unquote(parts.slice(1).join(' '))) };
  }
  return { old: rest, neu: rest };
}

function parseSidePath(raw) {
  let value = raw.replace(/\t.*$/, '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (value === '/dev/null') return '/dev/null';
  if (value.startsWith('a/') || value.startsWith('b/')) return value.slice(2);
  return value;
}

function parseHunkHeader(line) {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return null;
  return {
    header: line.split(' @@').slice(0, 2).join(' @@') + (line.includes(' @@') ? ' @@' : ''),
    rawHeader: line,
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function displayHeader(line) {
  const match = line.match(/^(@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/);
  return match ? match[1] : line;
}

function parseUnifiedDiff(text) {
  const files = [];
  const lines = text.split('\n');
  let current = null;
  let i = 0;

  const startFile = () => {
    current = {
      oldPath: null,
      newPath: null,
      status: 'modified',
      binary: false,
      hunks: [],
    };
    files.push(current);
  };

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      startFile();
      const paths = parseGitDiffPaths(line);
      current.oldPath = paths.old;
      current.newPath = paths.neu;
      i += 1;
      continue;
    }
    if (!current) {
      i += 1;
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.oldPath = line.slice('rename from '.length);
      current.status = 'renamed';
      i += 1;
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.newPath = line.slice('rename to '.length);
      current.status = 'renamed';
      i += 1;
      continue;
    }
    if (line.startsWith('new file mode')) {
      if (current.status !== 'renamed') current.status = 'added';
      i += 1;
      continue;
    }
    if (line.startsWith('deleted file mode')) {
      if (current.status !== 'renamed') current.status = 'deleted';
      i += 1;
      continue;
    }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.binary = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ')) {
      const parsed = parseSidePath(line.slice(4));
      if (parsed === '/dev/null') {
        if (current.status === 'modified') current.status = 'added';
      } else {
        current.oldPath = parsed;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const parsed = parseSidePath(line.slice(4));
      if (parsed === '/dev/null') {
        if (current.status === 'modified') current.status = 'deleted';
      } else {
        current.newPath = parsed;
      }
      i += 1;
      continue;
    }
    if (line.startsWith('@@ ')) {
      const meta = parseHunkHeader(line);
      if (!meta) {
        i += 1;
        continue;
      }
      i += 1;
      const hunkLines = [];
      let walkOld = meta.oldLines === 0 ? 0 : meta.oldStart;
      let walkNew = meta.newLines === 0 ? 0 : meta.newStart;
      while (i < lines.length) {
        const body = lines[i];
        if (
          body.startsWith('diff --git ') ||
          body.startsWith('@@ ') ||
          body.startsWith('diff --cc ')
        ) {
          break;
        }
        if (body === '') break;
        if (body.startsWith('\\')) {
          i += 1;
          continue;
        }
        const kind = body[0];
        if (kind !== ' ' && kind !== '+' && kind !== '-') {
          break;
        }
        if (kind === '+') {
          hunkLines.push({ type: 'add', oldNo: null, newNo: walkNew, text: body.slice(1) });
          walkNew += 1;
        } else if (kind === '-') {
          hunkLines.push({ type: 'del', oldNo: walkOld, newNo: null, text: body.slice(1) });
          walkOld += 1;
        } else {
          const text = body.startsWith(' ') ? body.slice(1) : body;
          hunkLines.push({ type: 'context', oldNo: walkOld, newNo: walkNew, text });
          walkOld += 1;
          walkNew += 1;
        }
        i += 1;
      }
      current.hunks.push({
        header: displayHeader(meta.rawHeader),
        oldStart: meta.oldStart,
        oldLines: meta.oldLines,
        newStart: meta.newStart,
        newLines: meta.newLines,
        lines: hunkLines,
      });
      continue;
    }
    i += 1;
  }
  return files;
}

function fileTags(path) {
  const p = path.replace(/\\/g, '/');
  const base = p.split('/').pop() ?? p;
  const tags = [];
  if (/\.spec\./.test(base) || /\.test\./.test(base) || p.includes('/__tests__/')) tags.push('test');
  if (/\.mdx?$/.test(base) || /(^|\/)docs\//.test(p)) tags.push('docs');
  if (
    base === 'pnpm-lock.yaml' ||
    base === 'package-lock.json' ||
    base === 'yarn.lock' ||
    /openapi.*\.(ya?ml|json)$/i.test(base) ||
    /\.generated\./.test(base) ||
    /(^|\/)generated\//.test(p) ||
    /(^|\/)__generated__\//.test(p) ||
    /(^|\/)gen\//.test(p)
  ) {
    tags.push('generated');
  }
  if (
    /\.config\./.test(base) ||
    /^tsconfig.*\.json$/.test(base) ||
    base.startsWith('.eslintrc') ||
    base === 'package.json'
  ) {
    tags.push('config');
  }
  if (/(^|\/)migrations\//.test(p) || base === 'schema.prisma') tags.push('migration');
  if (!tags.includes('config') && !base.startsWith('.') && /\.(json|jsonl|ndjson|csv|tsv)$/.test(base)) {
    tags.push('data');
  }
  return tags;
}

function isImportish(text) {
  const t = text.trim();
  if (t === '') return true;
  if (/^import\b/.test(t)) return true;
  if (/^export\b/.test(t) && /\bfrom\b/.test(t)) return true;
  if (/\brequire\s*\(/.test(t)) return true;
  if (/^from\s+\S+\s+import\b/.test(t)) return true;
  if (/^(?:\w+\s+)?["'][^"']+["']$/.test(t)) return true;
  return false;
}

function hunkTags(hunk) {
  const changed = hunk.lines.filter((line) => line.type === 'add' || line.type === 'del');
  if (changed.length === 0) return [];
  if (changed.every((line) => isImportish(line.text))) return ['import-only'];
  return [];
}

function contentHash(hunk) {
  const body = hunk.lines
    .map((line) => {
      const prefix = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ';
      return prefix + line.text;
    })
    .join('\n');
  return createHash('sha1').update(body).digest('hex').slice(0, 12);
}

function stripExt(path) {
  return path.replace(/\\/g, '/').replace(/\.[^./]+$/, '');
}

/** import 文の specifier を、hunk のファイル位置から repo 相対パス（拡張子なし）に解決する。相対 import のみ対象。 */
function importTargets(text, fromPath) {
  const specs = [...text.matchAll(/["']((?:\.\.?\/)[^"']+)["']/g)].map((m) => m[1]);
  const dir = posix.dirname(fromPath.replace(/\\/g, '/'));
  return specs.map((spec) => stripExt(posix.normalize(posix.join(dir, spec))).replace(/\/index$/, ''));
}

function pairingKey(path) {
  const norm = path.replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const dir = slash === -1 ? '' : norm.slice(0, slash);
  const base = slash === -1 ? norm : norm.slice(slash + 1);
  const noExt = base.replace(/\.[^.]+$/, '');
  const stem = noExt.replace(/\.(spec|test)$/, '');
  const parent = dir.endsWith('/__tests__') ? dir.slice(0, -'/__tests__'.length) : dir;
  return `${parent}/${stem}`;
}

function isImplSource(path, tags) {
  if (tags.includes('test')) return false;
  return /\.(ts|tsx|js|jsx|py|go)$/.test(path);
}

function isSensitivePath(path) {
  return /auth|billing|payment|security|migration|prisma/i.test(path);
}

function requireDefaultBase(cwd) {
  const base = detectDefaultBase(cwd);
  if (!base) fail('既定ブランチを特定できませんでした (origin/HEAD, main, master, staging)');
  return base;
}

function collectUncommittedDiff(cwd) {
  const tmp = mkdtempSync(join(tmpdir(), 'diff-review-'));
  try {
    const indexRel = gitStrict(['rev-parse', '--git-path', 'index'], cwd);
    const realIndex = resolve(cwd, indexRel);
    const tmpIndex = join(tmp, 'index');
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    const add = spawnSync('git', ['add', '-A'], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, ...env },
    });
    if (add.error) fail(add.error.message);
    if (add.status !== 0) {
      fail((add.stderr || add.stdout || '').trim() || 'git add -A (temp index) が失敗しました');
    }
    const diff = git(['diff', '-U3', '-M', '--no-color', '--no-ext-diff', '--cached', 'HEAD'], cwd, { env });
    return diff.stdout;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function resolveScope(args) {
  const { cwd } = args;
  let mode = args.mode;
  if (!mode) {
    const status = gitStrict(['status', '--porcelain'], cwd);
    mode = status ? 'uncommitted' : 'base';
    if (mode === 'base') args.base = requireDefaultBase(cwd);
  }

  const repoRoot = gitStrict(['rev-parse', '--show-toplevel'], cwd);
  const branch = gitStrict(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const head = gitStrict(['rev-parse', 'HEAD'], cwd);
  const defaultBase = detectDefaultBase(cwd);
  const slug = sanitizeSlug(branch, defaultBase ? shortDefaultName(defaultBase) : null);

  if (mode === 'uncommitted') {
    const command = 'git add -A (temp index) && git diff -U3 -M --no-color --no-ext-diff --cached HEAD';
    const diffText = collectUncommittedDiff(cwd);
    return {
      repo: { root: repoRoot, branch, head },
      scope: { mode, base: 'HEAD', head: 'WORKTREE', command },
      slug,
      diffText,
    };
  }

  if (mode === 'base') {
    const baseRef = args.base || requireDefaultBase(cwd);
    const mergeBase = gitStrict(['merge-base', baseRef, 'HEAD'], cwd);
    const command = `git diff -U3 -M --no-color --no-ext-diff ${mergeBase}..HEAD`;
    const diff = git(['diff', '-U3', '-M', '--no-color', '--no-ext-diff', `${mergeBase}..HEAD`], cwd);
    return {
      repo: { root: repoRoot, branch, head },
      scope: { mode, base: mergeBase, head, command },
      slug,
      diffText: diff.stdout,
    };
  }

  const [from, to] = args.range.split('..');
  if (!from || !to) fail('--range は a..b 形式です');
  const command = `git diff -U3 -M --no-color --no-ext-diff ${from}..${to}`;
  const diff = git(['diff', '-U3', '-M', '--no-color', '--no-ext-diff', `${from}..${to}`], cwd);
  const rangeHead = refExists(cwd, to) ? gitStrict(['rev-parse', to], cwd) : head;
  return {
    repo: { root: repoRoot, branch, head },
    scope: { mode: 'range', base: from, head: rangeHead, command },
    slug,
    diffText: diff.stdout,
  };
}

function buildSeeds(files, hunks) {
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  const assigned = new Map();
  const seeds = [];
  let seedN = 0;

  const claim = (hunkIds, kind, reason) => {
    const fresh = hunkIds.filter((id) => !assigned.has(id));
    if (fresh.length === 0) return;
    seedN += 1;
    const id = makeId('s', seedN);
    for (const hunkId of fresh) assigned.set(hunkId, id);
    seeds.push({ id, kind, hunkIds: fresh, reason });
  };

  for (const file of files) {
    if (file.status !== 'renamed') continue;
    const ids = [...file.hunkIds];
    const oldNoExt = stripExt(file.oldPath || '').replace(/\/index$/, '');
    if (oldNoExt) {
      for (const hunk of hunks) {
        if (!hunk.tags.includes('import-only') || hunk.fileId === file.id) continue;
        const hit = hunk.lines.some((line) => line.type === 'del' && importTargets(line.text, hunk.path).includes(oldNoExt));
        if (hit) ids.push(hunk.id);
      }
    }
    claim([...new Set(ids)], 'rename', `rename ${file.oldPath} → ${file.path}`);
  }

  const pairs = new Map();
  for (const file of files) {
    const key = pairingKey(file.path);
    const entry = pairs.get(key) ?? { impl: [], test: [] };
    if (file.tags.includes('test')) entry.test.push(file);
    else if (isImplSource(file.path, file.tags)) entry.impl.push(file);
    pairs.set(key, entry);
  }
  for (const [key, group] of pairs) {
    if (group.impl.length === 0 || group.test.length === 0) continue;
    const ids = [...group.impl, ...group.test].flatMap((file) => file.hunkIds);
    claim(ids, 'impl-test', `impl↔test ${key}`);
  }

  const generatedIds = files.filter((file) => file.tags.includes('generated')).flatMap((file) => file.hunkIds);
  claim(generatedIds, 'generated', 'generated タグのファイルをまとめる');

  const docsIds = files.filter((file) => file.tags.includes('docs')).flatMap((file) => file.hunkIds);
  claim(docsIds, 'docs', 'docs タグのファイルをまとめる');

  return seeds;
}

function buildSignals(files) {
  const signals = [];
  const hasTestFor = (file) => {
    const key = pairingKey(file.path);
    return files.some((other) => other.tags.includes('test') && pairingKey(other.path) === key);
  };

  for (const file of files) {
    if (file.status === 'deleted') {
      signals.push({
        code: 'deleted-file',
        level: 'high',
        target: { fileId: file.id },
        detail: `${file.path} が削除されています`,
      });
    }
    if (file.additions + file.deletions > 200) {
      signals.push({
        code: 'large-change',
        level: 'medium',
        target: { fileId: file.id },
        detail: `${file.path} は ${file.additions + file.deletions} 行の変更です`,
      });
    }
    if (isSensitivePath(file.path) || (file.oldPath && isSensitivePath(file.oldPath))) {
      signals.push({
        code: 'sensitive-path',
        level: 'high',
        target: { fileId: file.id },
        detail: `${file.path} は機微なパスを含みます`,
      });
    }
    if (isImplSource(file.path, file.tags) && !hasTestFor(file)) {
      signals.push({
        code: 'impl-without-test',
        level: 'medium',
        target: { fileId: file.id },
        detail: `${file.path} に実装変更がありますが対応テストが差分にありません`,
      });
    }
  }
  return signals;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolved = resolveScope(args);
  const parsed = parseUnifiedDiff(resolved.diffText);

  const files = [];
  const hunks = [];
  let fileN = 0;
  let hunkN = 0;
  let additions = 0;
  let deletions = 0;

  for (const raw of parsed) {
    const path = raw.status === 'deleted' ? raw.oldPath : raw.newPath || raw.oldPath;
    if (!path) continue;
    fileN += 1;
    const fileId = makeId('f', fileN);
    const fileHunkIds = [];
    let fileAdd = 0;
    let fileDel = 0;
    if (raw.hunks.length === 0) {
      hunkN += 1;
      let meta = 'empty';
      let header = '(no content change)';
      if (raw.binary) {
        meta = 'binary';
        header = '(binary)';
      } else if (raw.status === 'renamed') {
        meta = 'rename-only';
        header = '(rename only)';
      }
      const hunk = {
        id: makeId('h', hunkN),
        fileId,
        path,
        header,
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        lines: [],
        additions: 0,
        deletions: 0,
        tags: [],
        contentHash: createHash('sha1').update(`${raw.status}:${raw.oldPath ?? ''}->${path}`).digest('hex').slice(0, 12),
        meta,
      };
      fileHunkIds.push(hunk.id);
      hunks.push(hunk);
    }
    for (const rawHunk of raw.hunks) {
      hunkN += 1;
      const add = rawHunk.lines.filter((line) => line.type === 'add').length;
      const del = rawHunk.lines.filter((line) => line.type === 'del').length;
      fileAdd += add;
      fileDel += del;
      const hunk = {
        id: makeId('h', hunkN),
        fileId,
        path,
        header: rawHunk.header,
        oldStart: rawHunk.oldStart,
        oldLines: rawHunk.oldLines,
        newStart: rawHunk.newStart,
        newLines: rawHunk.newLines,
        lines: rawHunk.lines,
        additions: add,
        deletions: del,
        tags: hunkTags(rawHunk),
        contentHash: contentHash(rawHunk),
      };
      fileHunkIds.push(hunk.id);
      hunks.push(hunk);
    }
    additions += fileAdd;
    deletions += fileDel;
    files.push({
      id: fileId,
      path,
      oldPath: raw.status === 'renamed' ? raw.oldPath : null,
      status: raw.status,
      binary: raw.binary,
      tags: fileTags(path),
      additions: fileAdd,
      deletions: fileDel,
      hunkIds: fileHunkIds,
    });
  }

  const seeds = buildSeeds(files, hunks);
  const signals = buildSignals(files);
  const model = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: resolved.repo,
    scope: resolved.scope,
    slug: resolved.slug,
    stats: { files: files.length, hunks: hunks.length, additions, deletions },
    files,
    hunks,
    seeds,
    signals,
  };

  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, `${JSON.stringify(model, null, 2)}\n`);
  console.log(`出力: ${args.outPath}`);
  console.log(`files=${model.stats.files} hunks=${model.stats.hunks} +${model.stats.additions} -${model.stats.deletions} seeds=${seeds.length} signals=${signals.length}`);
}

main();
