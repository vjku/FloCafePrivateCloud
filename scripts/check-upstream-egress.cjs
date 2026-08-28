#!/usr/bin/env node
/**
 * check-upstream-egress.cjs — conservative network-egress scanner for FloCafePrivateCloud.
 *
 * FloCafePrivateCloud guarantees that all network egress is strictly opt-in. This
 * script is a backstop that fails closed: when in doubt it flags a line and lets
 * a human confirm the egress is behind an explicit, owner-level consent setting.
 *
 * Usage:
 *   node scripts/check-upstream-egress.cjs <base> <head> [--strict-files] [--self-pr]
 *
 *   --strict-files  Only scan files matching SENSITIVE_GLOBS. Used when pulling
 *                   upstream, where docs/tests legitimately contain URLs and we
 *                   only care about new network code in runtime paths.
 *   --self-pr       Exclude docs, i18n, tests, workflows, package.json, and this
 *                   scanner from the scan (advisory check for first-party PRs, so
 *                   legitimate URL/README changes and the scanner itself don't
 *                   trip the check). Network primitives in main/frontend code are
 *                   still flagged.
 *
 *   (default)       Scan every added line for egress patterns.
 *
 * Exit codes: 0 = clean, 1 = egress detected, 2 = bad usage.
 */

const { execFileSync } = require('child_process');

const base = process.argv[2];
const head = process.argv[3];
if (!base || !head) {
  console.error('usage: node scripts/check-upstream-egress.cjs <base> <head> [--strict-files] [--self-pr]');
  process.exit(2);
}
const strictFiles = process.argv.includes('--strict-files');
const selfPr = process.argv.includes('--self-pr');

const SENSITIVE_GLOBS = [
  'main/**/*.ts',
  'main/**/*.js',
  'main/**/*.cjs',
  'frontend/src/**/*.ts',
  'frontend/src/**/*.tsx',
  'scripts/**/*.cjs',
  'scripts/**/*.js',
];

const SELF_PR_EXCLUDE_GLOBS = [
  '*.md',
  'docs/**',
  'CHANGELOG.md',
  'frontend/src/lib/i18n/**',
  'tests/**',
  '.github/**',
  'package.json',
  'package-lock.json',
  'scripts/check-upstream-egress.cjs',
];

function globToRegex(glob) {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<dbl>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<dbl>>/g, '(?:.*/)?');
  return new RegExp('^' + esc + '$');
}
const sensitiveRe = SENSITIVE_GLOBS.map(globToRegex);
const selfPrExcludeRe = SELF_PR_EXCLUDE_GLOBS.map(globToRegex);

function matchesAny(regexes, file) {
  return regexes.some((re) => re.test(file));
}

function isComment(line) {
  const t = line.trimStart();
  return (
    t.startsWith('//') ||
    t.startsWith('#') ||
    t.startsWith('/*') ||
    t.startsWith('*') ||
    t.startsWith('<!--') ||
    t.startsWith('--') ||
    t.startsWith(';')
  );
}

// Network primitives — an added line containing one of these is egress unless it
// is demonstrably gated by a consent setting (a human confirms that).
const EGRESS_PATTERNS = [
  /\bfetch\s*\(/i,
  /\bXMLHttpRequest\b/i,
  /\baxios\b/i,
  /\bWebSocket\b/i,
  /\bnet\.request\b/i,
  /\bsendBeacon\b/i,
  /\bautoUpdater\b/i,
  /\bcheckForUpdates\b/i,
  /\bquitAndInstall\b/i,
  /\bdownloadUpdate\b/i,
  /\bhttps?:\/\//i,
];

function main() {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', '--no-color', `${base}...${head}`], { encoding: 'utf8' });
  } catch {
    try {
      diff = execFileSync('git', ['diff', '--unified=0', '--no-color', base, head], { encoding: 'utf8' });
    } catch (e) {
      console.error('git diff failed:', e.message);
      process.exit(2);
    }
  }

  const lines = diff.split('\n');
  const hits = [];
  let currentFile = null;
  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const m = line.match(/diff --git a\/(.*) b\//);
      if (m) currentFile = m[1];
      continue;
    }
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice('+++ b/'.length).trim();
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    if (!added.trim()) continue;
    if (isComment(added)) continue;
    if (!currentFile) continue;

    if (strictFiles && !matchesAny(sensitiveRe, currentFile)) continue;
    if (selfPr && matchesAny(selfPrExcludeRe, currentFile)) continue;

    for (const re of EGRESS_PATTERNS) {
      if (re.test(added)) {
        hits.push({ file: currentFile, line: added.trim(), pattern: re.source });
        break;
      }
    }
  }

  if (hits.length === 0) {
    console.log('✅ No new network egress detected.');
    process.exit(0);
  }

  console.error('⚠️  Potential new network egress detected in added lines:');
  for (const h of hits) {
    console.error(`  ${h.file}: +${h.line}`);
    console.error(`      matched: ${h.pattern}`);
  }
  if (strictFiles) {
    console.error('\nUpstream introduced network code in runtime paths. Sync was BLOCKED to protect the');
    console.error('opt-in egress guarantee. Add/confirm consent gates in this fork, then re-run the sync.');
  } else {
    console.error('\nAny new egress must be gated behind an explicit, owner-level consent setting');
    console.error('(auto_update_consent / tax_pack_catalog_consent). Confirm a consent gate exists, or');
    console.error('document why this is a false positive before merging.');
  }
  process.exit(1);
}

main();
