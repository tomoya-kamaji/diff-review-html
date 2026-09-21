#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage:
  node build-review.mjs --model <model.json> --groups <groups.json> --out <review.html> [--check]
`;

const KINDS = new Set(['refactor', 'feat', 'fix', 'test', 'docs', 'chore', 'generated']);
const RISKS = new Set(['high', 'medium', 'low']);
const FINDING_TYPES = new Set(['improve', 'unclear', 'note']);
const LEVEL_RANK = { high: 3, medium: 2, low: 1 };
const HEAVY_LINES = 1000;
const HEAVY_KEEP = 40;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { model: null, groups: null, outPath: null, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    }
    if (arg === '--check') {
      out.check = true;
      continue;
    }
    if (arg === '--model' || arg === '--groups' || arg === '--out') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`${arg} にはパスが必要です`);
      if (arg === '--model') out.model = resolve(value);
      if (arg === '--groups') out.groups = resolve(value);
      if (arg === '--out') out.outPath = resolve(value);
      i += 1;
      continue;
    }
    fail(`不明な引数: ${arg}\n${USAGE}`);
  }
  if (!out.model || !out.groups) fail(`--model と --groups は必須です\n${USAGE}`);
  if (!out.check && !out.outPath) fail(`--out は必須です（--check 時を除く）\n${USAGE}`);
  return out;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} を読めません: ${error.message}`);
  }
}

function hunkLineRange(hunk, side) {
  if (side === 'old') {
    if (hunk.oldLines === 0) return null;
    return { start: hunk.oldStart, end: hunk.oldStart + hunk.oldLines - 1 };
  }
  if (hunk.newLines === 0) return null;
  return { start: hunk.newStart, end: hunk.newStart + hunk.newLines - 1 };
}

function lineInHunk(hunk, line, side) {
  if (side === 'old' || side === 'new') {
    const range = hunkLineRange(hunk, side);
    return range ? line >= range.start && line <= range.end : false;
  }
  const oldR = hunkLineRange(hunk, 'old');
  const newR = hunkLineRange(hunk, 'new');
  return Boolean(
    (oldR && line >= oldR.start && line <= oldR.end) ||
      (newR && line >= newR.start && line <= newR.end),
  );
}

function validate(model, groupsDoc) {
  const errors = [];
  const hunkIds = new Set((model.hunks ?? []).map((h) => h.id));
  const hunkMap = new Map((model.hunks ?? []).map((h) => [h.id, h]));
  const seedMap = new Map((model.seeds ?? []).map((s) => [s.id, s]));
  const owner = new Map();

  if (!groupsDoc || groupsDoc.version !== 1) errors.push('groups.version は 1 である必要があります');
  if (!groupsDoc?.title || String(groupsDoc.title).trim() === '') errors.push('title は必須です');
  if (!groupsDoc?.summary || String(groupsDoc.summary).trim() === '') errors.push('summary は必須です');
  if (!groupsDoc?.problem || String(groupsDoc.problem).trim() === '') errors.push('problem は必須です');
  if (!groupsDoc?.doneWhen || String(groupsDoc.doneWhen).trim() === '') errors.push('doneWhen は必須です');
  if (!Array.isArray(groupsDoc?.groups) || groupsDoc.groups.length === 0) errors.push('groups は1件以上必要です');
  const groupIds = new Set((groupsDoc?.groups ?? []).map((group) => group?.id).filter(Boolean));
  if (!groupsDoc?.core || !groupIds.has(groupsDoc.core)) {
    errors.push('core は存在する group.id である必要があります');
  }

  for (const [index, group] of (groupsDoc?.groups ?? []).entries()) {
    const label = group?.id || `groups[${index}]`;
    if (group && typeof group === 'object') {
      const fromSeeds = (group.seedIds ?? []).flatMap((seedId) => seedMap.get(seedId)?.hunkIds ?? []);
      group.hunkIds = [...new Set([...(group.hunkIds ?? []), ...fromSeeds])];
    }
    if (!group?.title || String(group.title).trim() === '') errors.push(`${label}: title は必須です`);
    if (!group?.intent || String(group.intent).trim() === '') errors.push(`${label}: intent は必須です`);
    if (!KINDS.has(group?.kind)) errors.push(`${label}: kind が不正です (${group?.kind})`);
    if (!RISKS.has(group?.risk)) errors.push(`${label}: risk が不正です (${group?.risk})`);
    if (!Array.isArray(group?.hunkIds) || group.hunkIds.length === 0) {
      errors.push(`${label}: hunkIds は1件以上必要です`);
    }

    for (const hunkId of group?.hunkIds ?? []) {
      if (!hunkIds.has(hunkId)) errors.push(`${label}: 存在しない hunkId ${hunkId}`);
      if (owner.has(hunkId)) errors.push(`${hunkId}: 複数グループに所属 (${owner.get(hunkId)} と ${label})`);
      else owner.set(hunkId, label);
    }

    for (const seedId of group?.seedIds ?? []) {
      if (!seedMap.has(seedId)) errors.push(`${label}: 存在しない seedId ${seedId}`);
    }

    for (const [ai, annotation] of (group?.annotations ?? []).entries()) {
      const al = `${label} annotation[${ai}]`;
      if (!annotation?.goal || String(annotation.goal).trim() === '') errors.push(`${al}: goal は必須です`);
      if (!annotation?.hunkId) errors.push(`${al}: hunkId は必須です`);
      else if (!(group.hunkIds ?? []).includes(annotation.hunkId)) {
        errors.push(`${al}: hunkId ${annotation.hunkId} はこのグループに所属していません`);
      }
    }

    for (const [fi, finding] of (group?.findings ?? []).entries()) {
      const fl = `${label} finding[${fi}]`;
      if (!FINDING_TYPES.has(finding?.type)) errors.push(`${fl}: type が不正です (${finding?.type})`);
      if (!finding?.text || String(finding.text).trim() === '') errors.push(`${fl}: text は必須です`);
      if (!hunkIds.has(finding?.hunkId)) errors.push(`${fl}: 存在しない hunkId ${finding?.hunkId}`);
      const hunk = hunkMap.get(finding?.hunkId);
      if (hunk && finding.line !== undefined && finding.line !== null) {
        if (hunk.meta) {
          errors.push(`${fl}: 本文のない hunk に line は指定できません`);
        } else if (!lineInHunk(hunk, finding.line, finding.side)) {
          errors.push(`${fl}: line ${finding.line} が hunk ${finding.hunkId} の範囲外です`);
        }
      }
    }

    const relatedFileIds = new Set();
    for (const hunkId of group?.hunkIds ?? []) {
      const hunk = hunkMap.get(hunkId);
      if (hunk) relatedFileIds.add(hunk.fileId);
    }
    let maxLevel = 0;
    for (const signal of model.signals ?? []) {
      const fileId = signal.target?.fileId;
      if (fileId && relatedFileIds.has(fileId)) {
        maxLevel = Math.max(maxLevel, LEVEL_RANK[signal.level] ?? 0);
      }
    }
    const riskRank = LEVEL_RANK[group?.risk] ?? 0;
    if (maxLevel > 0 && riskRank < maxLevel) {
      if (!group?.riskReason || String(group.riskReason).trim() === '') {
        errors.push(`${label}: signals の最大 level より低い risk には riskReason が必要です`);
      }
    }
  }

  for (const hunkId of hunkIds) {
    if (!owner.has(hunkId)) errors.push(`${hunkId}: どのグループにも所属していません`);
  }

  for (const seed of model.seeds ?? []) {
    const groupsForSeed = new Set();
    for (const hunkId of seed.hunkIds) {
      if (owner.has(hunkId)) groupsForSeed.add(owner.get(hunkId));
    }
    if (groupsForSeed.size > 1) {
      errors.push(`${seed.id}: seed の hunk が複数グループに分裂しています (${[...groupsForSeed].join(', ')})`);
    }
  }

  return errors;
}

function stateKey(hunks) {
  const joined = hunks.map((h) => h.contentHash).sort().join('');
  return createHash('sha1').update(joined).digest('hex').slice(0, 12);
}

function prepareHunk(hunk, file) {
  const tags = file?.tags ?? [];
  const heavy = tags.includes('data') || tags.includes('generated');
  if (heavy && hunk.lines.length > HEAVY_LINES) {
    return {
      ...hunk,
      lines: hunk.lines.slice(0, HEAVY_KEEP),
      truncated: hunk.lines.length - HEAVY_KEEP,
    };
  }
  return hunk;
}

function buildView(model, groupsDoc) {
  const hunkMap = new Map(model.hunks.map((h) => [h.id, h]));
  const fileMap = new Map(model.files.map((f) => [f.id, f]));
  const seedMap = new Map(model.seeds.map((s) => [s.id, s]));

  const groups = groupsDoc.groups.map((group) => {
    const hunks = group.hunkIds.map((id) => {
      const hunk = hunkMap.get(id);
      if (!hunk) return null;
      return prepareHunk(hunk, fileMap.get(hunk.fileId));
    }).filter(Boolean);
    const fileIds = [...new Set(hunks.map((h) => h.fileId))];
    const files = fileIds.map((id) => fileMap.get(id)).filter(Boolean);
    const containedSeeds = (model.seeds ?? []).filter((seed) =>
      seed.hunkIds.length > 0 && seed.hunkIds.every((id) => group.hunkIds.includes(id)),
    );
    const listedSeeds = (group.seedIds ?? []).map((id) => seedMap.get(id)).filter(Boolean);
    const seedNotes = [...new Map([...containedSeeds, ...listedSeeds].map((s) => [s.id, s])).values()];
    const signals = (model.signals ?? []).filter((signal) => fileIds.includes(signal.target?.fileId));
    const findings = group.findings ?? [];
    return {
      id: group.id,
      title: group.title,
      intent: group.intent,
      kind: group.kind,
      risk: group.risk,
      riskReason: group.riskReason ?? '',
      hunkIds: group.hunkIds,
      seedIds: group.seedIds ?? [],
      findings,
      annotations: group.annotations ?? [],
      isCore: group.id === groupsDoc.core,
      stateKey: stateKey(hunks),
      hunks,
      files,
      seeds: seedNotes,
      signals,
      hunkCount: hunks.length,
      findingCount: findings.length,
      issueCount: findings.filter((f) => f.type === 'improve' || f.type === 'unclear').length,
      additions: hunks.reduce((sum, h) => sum + h.additions, 0),
      deletions: hunks.reduce((sum, h) => sum + h.deletions, 0),
    };
  });

  const fileGroupIds = new Map();
  for (const group of groups) {
    for (const file of group.files) {
      const ids = fileGroupIds.get(file.id) ?? [];
      ids.push(group.id);
      fileGroupIds.set(file.id, ids);
    }
  }
  const files = model.files.map((file) => {
    const ids = [...new Set(fileGroupIds.get(file.id) ?? [])];
    if (ids.length > 1) return { ...file, groupIds: ids };
    if (ids.length === 1) return { ...file, groupId: ids[0] };
    return { ...file };
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: model.repo,
    scope: model.scope,
    slug: model.slug,
    stats: model.stats,
    title: groupsDoc.title,
    summary: groupsDoc.summary,
    problem: groupsDoc.problem,
    core: groupsDoc.core,
    doneWhen: groupsDoc.doneWhen,
    groups,
    files,
    signals: model.signals ?? [],
  };
}

function inject(template, data) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  if (!template.includes('__DATA__')) fail('templates/app.html に __DATA__ がありません');
  return template.replace('__DATA__', () => json);
}

function riskCounts(groups) {
  const counts = { high: 0, medium: 0, low: 0 };
  for (const group of groups) counts[group.risk] += 1;
  return counts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const model = readJson(args.model);
  const groupsDoc = readJson(args.groups);
  const errors = validate(model, groupsDoc);
  if (errors.length > 0) {
    console.error(`検証エラー ${errors.length} 件:`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }

  if (args.check) {
    console.log('検証OK');
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const templatePath = resolve(here, '../templates/app.html');
  let template;
  try {
    template = readFileSync(templatePath, 'utf8');
  } catch (error) {
    fail(`テンプレートを読めません: ${error.message}`);
  }

  const view = buildView(model, groupsDoc);
  const html = inject(template, view);
  mkdirSync(dirname(args.outPath), { recursive: true });
  writeFileSync(args.outPath, html);

  const issues = view.groups.reduce((sum, g) => sum + g.issueCount, 0);
  const risks = riskCounts(view.groups);
  const truncated = view.groups.reduce((sum, g) => sum + g.hunks.filter((h) => h.truncated).length, 0);
  console.log(`出力: ${args.outPath}`);
  console.log(`グループ: ${view.groups.length} / 要改善: ${issues} / risk: high=${risks.high} medium=${risks.medium} low=${risks.low}`);
  console.log(`省略 hunk: ${truncated} 件`);
}

main();
