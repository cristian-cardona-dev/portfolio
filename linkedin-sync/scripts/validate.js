#!/usr/bin/env node
'use strict';
/*
 * validate.js — deterministic local validation for linkedin-sync
 *
 * Runs entirely offline: no LinkedIn login, no Chrome, no network.
 * Checks:
 *   1. JS syntax (node --check) for every .js file in the sync tree
 *   2. UTF-8 validity (strict decode; no BOM, no UTF-16)
 *   3. Control characters (C0 except TAB/LF/CR, DEL, C1)
 *   4. Secret patterns (case-insensitive, fragmented regexes so this file never
 *      trips itself) + in-suite positive/negative probes for every pattern
 *   5. JSON integrity + reconciliation policy (no 'applied' without evidence,
 *      expected 2026-10-06 statuses, cross-file baseline consistency)
 *   6. edit-profile.js behavior: default dry-run, --apply fails closed,
 *      multi-field refused, snapshot/verify modes work, and a dry-run with
 *      failing baseline guards reports DRY-RUN BLOCKED with a nonzero exit
 *   7. package metadata: no unused dependencies, package-lock in sync
 *   8. Fix-round-3 regressions, each on a temp copy of the tree (offline,
 *      nothing in the repository is modified):
 *        - changes.json policy audit fails closed (unknown field / missing or
 *          non-array / empty list / invalid status / applied without evidence)
 *        - snapshot output is masked and --out is sandboxed to snapshots/
 *          (outside/traversal/non-.json/existing file refused, overwrite only
 *          with --allow-overwrite)
 *        - maskValue sanitizes control characters and never echoes multi-line
 *          values (no forged "Result:" lines)
 *        - verify detects drift for every captured/verified field (experience,
 *          arrays, baseline_evidence) and metadata/value contradictions
 *   9. sync-linkedin.ps1: PowerShell parser check + behavior run on temp files
 *      (UTF-8 no-BOM append, local ISO-8601 offset label, idempotent run-key,
 *      policy guard refuses to log invalid changes)
 *
 * Usage: node validate.js   (or: npm test / npm run validate)
 * Exit 0 = all checks passed; exit 1 = at least one failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SYNC_ROOT = path.resolve(__dirname, '..');
const SCRIPTS_DIR = __dirname;
const EDIT_SCRIPT = path.join(SCRIPTS_DIR, 'edit-profile.js');
// 'snapshots' holds local masked snapshot output (gitignored): generated
// artifacts are not validation sources, so they are not walked.
const SKIP_DIRS = new Set(['node_modules', '.git', 'snapshots']);

const LIVE_BASELINE = {
  headline: 'Senior Full Stack .NET Engineer | C#, Azure, Angular & Cloud-Native APIs | Building Scalable Systems and AI-Enabled Products',
  location: 'Elche, Valencian Community, Spain'
};

const EXPECTED_CHANGE_STATUSES = {
  'change-001': 'obsolete',
  'change-002': 'obsolete',
  'change-003': 'needs_review',
  'change-004': 'needs_review',
  'change-005': 'needs_review',
  'change-006': 'needs_review',
  'change-007': 'obsolete'
};

let failures = 0;
let checks = 0;

function pass(msg) {
  checks++;
  process.stdout.write(`PASS  ${msg}\n`);
}

function fail(msg) {
  checks++;
  failures++;
  process.stdout.write(`FAIL  ${msg}\n`);
}

function assertEq(actual, expected, msg) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) pass(msg);
  else fail(`${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function assertOk(cond, msg) {
  if (cond) pass(msg);
  else fail(msg);
}

/* ---------------------------------------------------------- file walking */

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    fail(`cannot read directory ${dir}: ${err.message}`);
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, acc);
    } else if (e.isFile()) {
      acc.push(full);
    }
  }
  return acc;
}

/* -------------------------------------------------------- secret patterns */
/* Built from fragments so the contiguous token never appears in this source
   and the validator does not flag itself. All patterns are case-insensitive:
   PASSWORD=, API_KEY:, CLIENT_SECRET= and apiKey= must be caught too, not just
   their lowercase spelling. Every pattern is exercised by in-suite positive
   probes and by negative (benign prose) probes — see checkSecretPatternCoverage. */

const SECRET_PATTERNS = [
  { name: 'AWS access key id', re: new RegExp('\\b' + 'AKIA' + '[0-9A-Z]{16}' + '\\b', 'i') },
  { name: 'AWS secret access key', re: new RegExp('aws' + '[^\\n]{0,40}secret' + '[^\\n]{0,40}[A-Za-z0-9/+=]{40}', 'i') },
  { name: 'GitHub token', re: new RegExp('gh' + '[pousrhd]_' + '[0-9A-Za-z]{36}', 'i') },
  { name: 'GitHub fine-grained token', re: new RegExp('github_' + 'pat_[A-Za-z0-9_]{22,}', 'i') },
  { name: 'Slack token', re: new RegExp('xox[baprs]-' + '[A-Za-z0-9-]{10,}', 'i') },
  { name: 'Private key block', re: new RegExp('-----BEGIN' + '[A-Z ]*' + 'PRIVATE KEY-----', 'i') },
  { name: 'Generic credential assignment', re: new RegExp(
    '(pass' + 'word|passwd|pwd|api[_-]?key|apikey|client[_-]?secret|access[_-]?token|auth[_-]?token|session[_-]?cookie)' +
    '\\s*[=:]\\s*' +
    '[\'\"]?[A-Za-z0-9+/\\-_\\.=]{8,}', 'i') },
  { name: 'Credential file path assignment', re: new RegExp(
    '(pass' + 'word|passwd|pwd|secret|token)' +
    '\\s*[=:]\\s*' +
    '[\'\"]?[A-Za-z]:[\\\\/]', 'i') },
  { name: 'LinkedIn session cookie', re: new RegExp('li_' + 'at\\s*[=:]\\s*[A-Za-z0-9]{20,}', 'i') },
  { name: 'Bearer credential', re: new RegExp('Bearer' + '\\s+[A-Za-z0-9\\-._~+/]{25,}', 'i') },
  { name: 'CI secrets reference', re: new RegExp('\\$\\{\\{' + '\\s*secrets\\.[A-Za-z_]') },
  { name: 'JSON Web Token', re: new RegExp('ey' + 'J[A-Za-z0-9_-]{5,}\\.ey' + 'J[A-Za-z0-9_-]{5,}\\.[A-Za-z0-9_-]{10,}') },
  { name: 'npm token', re: new RegExp('npm_' + '[0-9A-Za-z]{36}') },
  { name: 'Google API key', re: new RegExp('AI' + 'za[0-9A-Za-z_\\-]{35}') },
  { name: 'Stripe secret key', re: new RegExp('sk_' + '(live|test)_[0-9A-Za-z]{16,}', 'i') }
];

/* ------------------------------------------------------------- checks */

function checkJsSyntax(files) {
  const jsFiles = files.filter((f) => f.endsWith('.js'));
  for (const f of jsFiles) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (r.status === 0) pass(`JS syntax OK: ${path.relative(SYNC_ROOT, f)}`);
    else fail(`JS syntax error in ${path.relative(SYNC_ROOT, f)}: ${(r.stderr || '').trim().split('\n')[0]}`);
  }
  assertOk(jsFiles.length > 0, `found JS files to check (got ${jsFiles.length})`);
}

function checkEncodingAndControls(files) {
  const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
  for (const f of files) {
    const rel = path.relative(SYNC_ROOT, f);
    const bytes = fs.readFileSync(f);
    // BOM checks
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      fail(`UTF-8 BOM found in ${rel} (files must be UTF-8 without BOM)`);
      continue;
    }
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) {
      fail(`UTF-16 BOM found in ${rel} (files must be UTF-8)`);
      continue;
    }
    let text;
    try {
      text = strictUtf8.decode(bytes);
    } catch (err) {
      fail(`invalid UTF-8 in ${rel}: ${err.message}`);
      continue;
    }
    pass(`UTF-8 valid: ${rel}`);
    const bad = [];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
      if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
        bad.push(`U+${code.toString(16).toUpperCase().padStart(4, '0')}@${i}`);
      }
    }
    if (bad.length === 0) pass(`control chars clean: ${rel}`);
    else fail(`control characters in ${rel}: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' ...' : ''}`);
  }
}

function checkSecrets(files) {
  for (const f of files) {
    const rel = path.relative(SYNC_ROOT, f);
    const text = fs.readFileSync(f, 'utf8');
    const hits = [];
    for (const p of SECRET_PATTERNS) {
      const m = text.match(p.re);
      // Report the pattern name and the file only — never any part of the
      // matched token (no prefixes, no hashes of it, no excerpts).
      if (m) hits.push(p.name);
    }
    if (hits.length === 0) pass(`no secret patterns: ${rel}`);
    else fail(`secret pattern(s) in ${rel}: ${hits.join('; ')} (pattern name only; matched value suppressed)`);
  }
}

function loadJsonChecked(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function checkJsonIntegrity() {
  const profile = loadJsonChecked(path.join(SYNC_ROOT, 'profile.json'), 'profile.json');
  const changes = loadJsonChecked(path.join(SYNC_ROOT, 'changes.json'), 'changes.json');
  const metrics = loadJsonChecked(path.join(SYNC_ROOT, 'metrics.json'), 'metrics.json');
  const pkg = loadJsonChecked(path.join(SCRIPTS_DIR, 'package.json'), 'scripts/package.json');
  loadJsonChecked(path.join(SYNC_ROOT, 'archive', 'profile-2026-10-02.json'), 'archive/profile-2026-10-02.json');
  loadJsonChecked(path.join(SYNC_ROOT, 'archive', 'changes-2026-10-02.json'), 'archive/changes-2026-10-02.json');
  if (!profile || !changes || !pkg) return;

  // Live-baseline constants must be preserved in profile.json.
  assertEq(profile.headline, LIVE_BASELINE.headline, 'profile.json headline matches 2026-10-06 live baseline');
  assertEq(profile.location, LIVE_BASELINE.location, 'profile.json location matches 2026-10-06 live baseline');
  assertEq(profile.languages, [], 'profile.json languages reflects live empty section');
  assertOk(profile.about_exact_text === null, 'profile.json does not fabricate exact About text');

  // Reconciliation policy: statuses locked to the 2026-10-06 evidence.
  const list = Array.isArray(changes.changes) ? changes.changes : [];
  assertEq(list.length, 7, 'changes.json contains all 7 reconciled proposals');
  const allowed = ['pending', 'obsolete', 'needs_review', 'applied'];
  let statusOk = true;
  for (const c of list) {
    if (!allowed.includes(c.status)) {
      fail(`change ${c.id} has invalid status '${c.status}'`);
      statusOk = false;
    }
    if (c.status === 'applied') {
      const rec = c.reconciliation || {};
      if (!(typeof rec.evidence === 'string' && rec.evidence.length > 0)) {
        fail(`change ${c.id} marked applied without reconciliation.evidence (policy violation)`);
        statusOk = false;
      }
    }
    const expected = EXPECTED_CHANGE_STATUSES[c.id];
    if (expected && c.status !== expected) {
      fail(`change ${c.id} status '${c.status}' != expected '${expected}' per 2026-10-06 evidence`);
      statusOk = false;
    }
  }
  if (statusOk) pass('all 7 change statuses match the 2026-10-06 reconciliation and policy');

  // Cross-file consistency: changes.json evidence must equal profile.json.
  const ev = changes.baseline_evidence || {};
  assertEq(ev.headline, profile.headline, 'changes.json baseline_evidence.headline matches profile.json');
  assertEq(ev.location, profile.location, 'changes.json baseline_evidence.location matches profile.json');

  // Reconciliation audit trail present.
  assertOk(typeof changes.last_reconciled === 'string' && changes.last_reconciled.length > 0, 'changes.json records last_reconciled date');
  assertOk(Array.isArray(changes.sync_history) && changes.sync_history.some((h) => h.status === 'reconciled'), 'changes.json sync_history includes reconciliation entry');

  // Metrics: the 2026-10-06 read confirmed 15 views / 10 search appearances.
  if (metrics) {
    assertEq(metrics.baseline && metrics.baseline.profile_views_per_week, 15, 'metrics baseline profile views = 15 (confirmed 2026-10-06)');
    assertEq(metrics.baseline && metrics.baseline.search_appearances_per_week, 10, 'metrics baseline search appearances = 10 (confirmed 2026-10-06)');
  }

  // package.json must wire the test suite to this file.
  assertEq(pkg.scripts && pkg.scripts.test, 'node validate.js', 'package.json "test" script runs validate.js');
  assertEq(pkg.scripts && pkg.scripts.validate, 'node validate.js', 'package.json "validate" script runs validate.js');

  // Package metadata hygiene: no unused runtime deps; lockfile consistent.
  const depNames = pkg.dependencies ? Object.keys(pkg.dependencies) : [];
  assertEq(depNames.length, 0, 'package.json declares no unused runtime dependencies (playwright removed)');
  const lock = loadJsonChecked(path.join(SCRIPTS_DIR, 'package-lock.json'), 'scripts/package-lock.json');
  if (lock) {
    assertEq(lock.name, pkg.name, 'package-lock.json name matches package.json');
    assertEq(lock.version, pkg.version, 'package-lock.json version matches package.json');
    const lockRoot = (lock.packages && lock.packages['']) || {};
    const lockDeps = lockRoot.dependencies ? Object.keys(lockRoot.dependencies) : [];
    assertEq(lockDeps.length, 0, 'package-lock.json root declares no dependencies');
    assertOk(!(lock.packages && lock.packages['node_modules/playwright']), 'package-lock.json has no playwright entry');
  }
}

function checkDocsMentionReconciliation() {
  const dash = fs.readFileSync(path.join(SYNC_ROOT, 'dashboard.md'), 'utf8');
  const log = fs.readFileSync(path.join(SYNC_ROOT, 'sync-log.md'), 'utf8');
  assertOk(dash.includes('2026-10-06'), 'dashboard.md references the 2026-10-06 reconciliation');
  assertOk(dash.includes('obsolete') && dash.includes('needs_review'), 'dashboard.md shows reconciled statuses');
  assertOk(log.includes('2026-10-06'), 'sync-log.md contains a 2026-10-06 entry');
  assertOk(log.includes('Reconciliación') || log.includes('Reconciled'), 'sync-log.md documents the reconciliation');
}

function runEdit(args, label, expectStatus, expectRegex) {
  const r = spawnSync(process.execPath, [EDIT_SCRIPT, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (expectStatus !== null && r.status !== expectStatus) {
    fail(`${label}: expected exit ${expectStatus}, got ${r.status} | output: ${output.trim().slice(0, 200)}`);
    return null;
  }
  if (expectRegex && !expectRegex.test(output)) {
    fail(`${label}: output did not match ${expectRegex} | output: ${output.trim().slice(0, 200)}`);
    return null;
  }
  pass(label);
  return r;
}

function checkEditProfileBehavior() {
  // 1. Default invocation = dry-run, no writes. Baseline guards currently fail
  //    for 6 of 7 proposals, so the dry-run must report itself BLOCKED (exit 1),
  //    never "DRY-RUN OK".
  const r1 = runEdit([], 'edit-profile defaults to dry-run (blocked exit 1, no network/write)', 1, /mode: dry-run \(default\)/);
  if (r1) {
    assertOk(/No network calls were made/.test(r1.stdout), 'dry-run output confirms no network calls');
    assertOk(/Write path: DISABLED/.test(r1.stdout), 'dry-run output states write path disabled');
    assertOk(/DRY-RUN BLOCKED \(\d+ baseline guard failure/.test(r1.stdout), 'failed baseline guards report DRY-RUN BLOCKED');
    assertOk(!/DRY-RUN OK/.test(r1.stdout), 'blocked dry-run never prints DRY-RUN OK');
  }

  // 2. --apply fails closed even with a valid single field.
  runEdit(['--apply', '--field', 'headline'], '--apply is refused (write path disabled, exit 3)', 3, /DISABLED/);

  // 3. Multiple fields are refused.
  runEdit(['--field', 'headline', '--field', 'about'], 'multi-field invocation refused (exit 2)', 2, /exactly one/i);

  // 4. Unknown field / unknown mode / unknown arg refused.
  runEdit(['--field', 'nope'], 'unknown field refused (exit 2)', 2, /unknown field/i);
  runEdit(['--mode', 'bogus'], 'unknown mode refused (exit 2)', 2, /unknown mode/i);
  runEdit(['--frobnicate'], 'unknown argument refused (exit 2)', 2, /unknown argument/i);

  // 5. --mode requires a value; snapshot mode emits deterministic local JSON.
  runEdit(['--mode'], '--mode without value refused (exit 2)', 2, /--mode requires a value/i);
  const r6 = runEdit(['--mode', 'snapshot'], 'snapshot mode emits local JSON (exit 0)', 0, null);
  if (r6) {
    try {
      const snap = JSON.parse(r6.stdout);
      assertEq(snap.snapshot_type, 'local_state_deterministic', 'snapshot JSON has deterministic snapshot_type');
      assertOk(typeof snap.baseline_date === 'string', 'snapshot JSON carries baseline_date');
    } catch (err) {
      fail(`snapshot mode output is not valid JSON: ${err.message}`);
    }
  }

  // 6. Verify mode passes on consistent local files.
  runEdit(['--mode', 'verify'], 'verify mode passes on consistent local state (exit 0)', 0, /VERIFY OK/);

  // 7. Single-field dry-run: stale old_value => blocked (exit 1), not "OK".
  const r7 = runEdit(['--field', 'headline'], 'single-field dry-run with stale old_value blocked (exit 1)', 1, /Field: headline/);
  if (r7) {
    assertOk(/baseline guard vs old_value: FAIL/.test(r7.stdout), 'blocked dry-run shows the failing baseline guard');
    assertOk(/DRY-RUN BLOCKED/.test(r7.stdout), 'blocked dry-run result line says DRY-RUN BLOCKED');
    assertOk(!/DRY-RUN OK/.test(r7.stdout), 'blocked dry-run never prints DRY-RUN OK');
  }

  // 8. Single-field dry-run whose guard passes => exit 0 / DRY-RUN OK.
  const r8 = runEdit(['--field', 'location'], 'single-field dry-run with matching baseline exits 0 (DRY-RUN OK)', 0, /DRY-RUN OK/);
  if (r8) {
    assertOk(/baseline guard vs old_value: PASS/.test(r8.stdout), 'passing dry-run shows the passing baseline guard');
  }
}

/* ------------------------------------------------ secret pattern coverage */

function checkSecretPatternCoverage() {
  const byName = {};
  for (const p of SECRET_PATTERNS) {
    if (!byName[p.name]) byName[p.name] = [];
    byName[p.name].push(p);
  }

  // Positive probes. Samples are concatenated at runtime so that this source
  // file never contains a contiguous credential (the tree scan must stay clean).
  const positives = [
    ['AWS access key id', 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP'],
    ['AWS secret access key', 'aws' + ' secret ' + 'A'.repeat(40)],
    ['GitHub token', 'gh' + 'p_' + 'A'.repeat(36)],
    ['GitHub token', 'gh' + 'o_' + 'B'.repeat(36)],
    ['GitHub token', 'gh' + 's_' + 'C'.repeat(36)],
    ['GitHub fine-grained token', 'github_' + 'pat_' + 'A'.repeat(22)],
    ['Slack token', 'xox' + 'b-' + 'A'.repeat(20)],
    ['Private key block', '-----' + 'BEGIN RSA PRIVATE KEY-----'],
    ['Generic credential assignment', 'pass' + 'word = "abcdefgh12345678"'],
    ['Generic credential assignment', 'PASS' + 'WORD = "abcdefgh12345678"'],
    ['Generic credential assignment', 'API' + '_KEY: "abcdefgh12345678"'],
    ['Generic credential assignment', 'client' + '_SECRET="abcdefgh12345678"'],
    ['Generic credential assignment', 'api' + 'Key=abcdefgh12345678'],
    ['LinkedIn session cookie', 'li_' + 'at=abcdefghijklmnopqrstuv'],
    ['Bearer credential', 'Bea' + 'rer ' + 'a'.repeat(30)],
    ['CI secrets reference', '${{' + ' secrets.MY_TOKEN'],
    ['JSON Web Token', 'ey' + 'JhbGciOiJIUzI1NiJ9.' + 'ey' + 'JzdWIiOiIxIn0.' + 'Ab34-_567890123456'],
    ['npm token', 'npm_' + 'A'.repeat(36)],
    ['Google API key', 'AI' + 'za' + 'A'.repeat(35)],
    ['Stripe secret key', 'sk_' + 'live_' + 'A'.repeat(24)],
    ['Stripe secret key', 'sk' + '_TEST_' + 'B'.repeat(24)],
    ['Credential file path assignment', 'pass' + 'word=C:\\Users\\example\\secret.txt']
  ];
  for (const [name, sample] of positives) {
    const pats = byName[name];
    if (!pats) {
      fail(`secret coverage: pattern '${name}' is not registered`);
      continue;
    }
    if (pats.some((p) => p.re.test(sample))) pass(`secret probe detected by '${name}' (${sample.slice(0, 3) || 'empty'}…)`);
    else fail(`secret probe NOT detected by '${name}'`);
  }

  // Negative probes: benign prose must never be flagged.
  const negatives = [
    ['prose about a password manager', 'The password manager rotates credentials on a schedule.'],
    ['prose about a token', 'Agrega el scope `workflow` al token cuando lo necesites.'],
    ['plain file path', 'C:\\Users\\example\\Documents\\notes.txt'],
    ['short fake github id', 'gh' + 'p_ short'],
    ['jwt-ish prose', 'El prefijo ey' + 'J no es un token por si mismo.'],
    ['integrity hash in a lockfile', 'sha512-' + 'AbCdEf0123456789'],
    ['npm package name', 'node_modules/npm-package-arg']
  ];
  for (const [label, sample] of negatives) {
    const hits = SECRET_PATTERNS.filter((p) => p.re.test(sample)).map((p) => p.name);
    if (hits.length === 0) pass(`benign probe not flagged: ${label}`);
    else fail(`benign probe wrongly flagged (${label}): ${hits.join('; ')}`);
  }

  // Every registered pattern must be exercised by at least one positive probe.
  const covered = new Set(positives.map((p) => p[0]));
  const uncovered = SECRET_PATTERNS.filter((p) => !covered.has(p.name)).map((p) => p.name);
  assertEq(uncovered, [], 'every secret pattern has at least one positive probe');
}

/* --------------------------------------------- fix round 3 temp-tree tests */

function outFile(r) {
  return `${r.stdout || ''}${r.stderr || ''}`;
}

function runNode(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true, timeout: 30000, cwd });
}

function makeTempTree(label) {
  const base = path.join(os.tmpdir(), 'opencode');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, `lsync-${label}-`));
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.copyFileSync(EDIT_SCRIPT, path.join(scriptsDir, 'edit-profile.js'));
  for (const f of ['profile.json', 'changes.json', 'metrics.json']) {
    fs.copyFileSync(path.join(SYNC_ROOT, f), path.join(root, f));
  }
  return {
    root,
    scriptsDir,
    edit: path.join(scriptsDir, 'edit-profile.js'),
    changesPath: path.join(root, 'changes.json'),
    profilePath: path.join(root, 'profile.json')
  };
}

function dropTree(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch (err) {
    process.stdout.write(`NOTE  temp tree not removable (${root}): ${err.message}\n`);
  }
}

function readJsonFile(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJsonFile(p, o) {
  fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8');
}

function checkRound3ChangesAudit() {
  // H1: non-array change list
  let t = makeTempTree('h1-array');
  try {
    const doc = readJsonFile(t.changesPath);
    doc.changes = {};
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, [], t.scriptsDir);
    assertOk(r.status === 1, `H1 changes:{} -> exit 1 (got ${r.status})`);
    assertOk(/is not an array/i.test(outFile(r)), 'H1 changes:{} surfaces the structural failure');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'H1 changes:{} never prints DRY-RUN OK');
  } finally { dropTree(t.root); }

  // H1: changes key deleted
  t = makeTempTree('h1-missing');
  try {
    const doc = readJsonFile(t.changesPath);
    delete doc.changes;
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, [], t.scriptsDir);
    assertOk(r.status === 1, `H1 missing changes key -> exit 1 (got ${r.status})`);
    assertOk(/no 'changes' key/.test(outFile(r)), 'H1 missing changes key is surfaced');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'H1 missing changes key never prints DRY-RUN OK');
  } finally { dropTree(t.root); }

  // H1: empty change list
  t = makeTempTree('h1-empty');
  try {
    const doc = readJsonFile(t.changesPath);
    doc.changes = [];
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, [], t.scriptsDir);
    assertOk(r.status === 1, `H1 empty changes list -> exit 1 (got ${r.status})`);
    assertOk(/proposal list is empty/i.test(outFile(r)), 'H1 empty changes list is surfaced');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'H1 empty changes list never prints DRY-RUN OK');
  } finally { dropTree(t.root); }

  // H1: unsupported change target must be scanned and surfaced
  t = makeTempTree('h1-unknown');
  try {
    const doc = readJsonFile(t.changesPath);
    doc.changes.push({
      id: 'change-999',
      field: 'certifications',
      type: 'add',
      status: 'pending',
      old_value: null,
      new_value: 'New Cert'
    });
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, [], t.scriptsDir);
    assertOk(r.status === 1, `H1 unsupported field -> exit 1 (got ${r.status})`);
    assertOk(/change-999/.test(outFile(r)), 'H1 unsupported change id is surfaced in output');
    assertOk(/certifications/.test(outFile(r)), 'H1 unsupported field name is surfaced in output');
    assertOk(/unsupported change target/.test(outFile(r)), 'H1 unsupported target reported by the changes audit');
    assertOk(/total=8 scanned=7 unsupported_field=1/.test(outFile(r)), 'H1 reports changes_scanned vs changes_total');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'H1 unsupported field never prints DRY-RUN OK');
    // verify mode must fail on the same document
    const v = runNode(t.edit, ['--mode', 'verify'], t.scriptsDir);
    assertOk(v.status === 1, `H1 unsupported field fails verify (got ${v.status})`);
    assertOk(/VERIFY FAILED/.test(outFile(v)), 'H1 verify reports VERIFY FAILED for unsupported target');
  } finally { dropTree(t.root); }

  // M4: invalid status
  t = makeTempTree('m4-status');
  try {
    const doc = readJsonFile(t.changesPath);
    doc.changes.find((c) => c.id === 'change-006').status = 'applied_typo';
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, ['--field', 'location'], t.scriptsDir);
    assertOk(r.status === 1, `M4 invalid status -> exit 1 (got ${r.status})`);
    assertOk(/INVALID\(applied_typo\)/.test(outFile(r)), 'M4 invalid status shown inline');
    assertOk(/FAIL invalid status: change-006/.test(outFile(r)), 'M4 invalid status counted by the changes audit');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'M4 invalid status never prints DRY-RUN OK');
    const v = runNode(t.edit, ['--mode', 'verify'], t.scriptsDir);
    assertOk(v.status === 1 && /invalid status 'applied_typo'/.test(outFile(v)), 'M4 invalid status fails verify');
  } finally { dropTree(t.root); }

  // M4: applied without reconciliation evidence
  t = makeTempTree('m4-evidence');
  try {
    const doc = readJsonFile(t.changesPath);
    const c = doc.changes.find((x) => x.id === 'change-006');
    c.status = 'applied';
    if (c.reconciliation) delete c.reconciliation.evidence;
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, ['--field', 'location'], t.scriptsDir);
    assertOk(r.status === 1, `M4 applied-without-evidence -> exit 1 (got ${r.status})`);
    assertOk(/change-006 is marked 'applied' without reconciliation\.evidence/.test(outFile(r)), 'M4 applied-without-evidence surfaced by dry-run');
    assertOk(!/DRY-RUN OK/.test(outFile(r)), 'M4 applied-without-evidence never prints DRY-RUN OK');
    const v = runNode(t.edit, ['--mode', 'verify'], t.scriptsDir);
    assertOk(v.status === 1 && /change-006 is marked 'applied' without reconciliation\.evidence/.test(outFile(v)), 'M4 applied-without-evidence fails verify');
    const s = runNode(t.edit, ['--mode', 'snapshot'], t.scriptsDir);
    assertOk(s.status === 1 && /policy audit/.test(outFile(s)), 'M4 applied-without-evidence suppresses snapshot (fail-closed)');
  } finally { dropTree(t.root); }
}

function checkRound3MaskingAndOut() {
  const t = makeTempTree('out');
  try {
    const profileDoc = readJsonFile(t.profilePath);

    // M2: snapshot stdout must be masked
    const r = runNode(t.edit, ['--mode', 'snapshot'], t.scriptsDir);
    assertOk(r.status === 0, `M2 snapshot runs (got ${r.status})`);
    assertOk(!outFile(r).includes(profileDoc.headline), 'M2 snapshot stdout contains no raw headline');
    assertOk(!outFile(r).includes('Elche, Valencian Community, Spain'), 'M2 snapshot stdout contains no raw location');
    assertOk(!outFile(r).includes('Talan'), 'M2 snapshot stdout contains no raw experience value');
    let snap = null;
    try {
      snap = JSON.parse(r.stdout);
    } catch (err) {
      fail(`M2 snapshot stdout is not valid JSON: ${err.message}`);
    }
    if (snap) {
      const h = snap.profile.headline;
      assertOk(h && h.__masked__ === true && typeof h.sha256 === 'string' && typeof h.len === 'number', 'M2 snapshot headline is a masked descriptor');
      assertOk(snap.profile.experience_companies && snap.profile.experience_companies.__masked__ === true, 'M2 snapshot arrays are masked descriptors');
      assertOk(/no network/i.test(snap.note || ''), 'M2 snapshot note states no network');
    }

    // H2: --out outside the sandbox
    const outside = path.join(t.root, 'escape.json');
    const rOut = runNode(t.edit, ['--mode', 'snapshot', '--out', outside], t.scriptsDir);
    assertOk(rOut.status === 2, `H2 --out outside snapshots/ -> exit 2 (got ${rOut.status})`);
    assertOk(/must resolve inside/.test(outFile(rOut)), 'H2 --out outside snapshots/ explains the sandbox');
    assertOk(!fs.existsSync(outside), 'H2 --out outside snapshots/ writes nothing');

    // H2: traversal is normalized and still refused
    const trav = path.join(t.root, 'snapshots', '..', 'escape2.json');
    const rTrav = runNode(t.edit, ['--mode', 'snapshot', '--out', trav], t.scriptsDir);
    assertOk(rTrav.status === 2, `H2 traversal --out -> exit 2 (got ${rTrav.status})`);
    assertOk(!fs.existsSync(path.join(t.root, 'escape2.json')), 'H2 traversal --out writes nothing');

    // H2: non-.json target refused
    const rTxt = runNode(t.edit, ['--mode', 'snapshot', '--out', path.join(t.root, 'snapshots', 's.txt')], t.scriptsDir);
    assertOk(rTxt.status === 2 && /must end with .json/.test(outFile(rTxt)), 'H2 non-.json --out refused');

    // H2: happy path (relative path resolved from cwd = scripts/)
    const snapPath = path.join(t.root, 'snapshots', 'snap.json');
    const rOk = runNode(t.edit, ['--mode', 'snapshot', '--out', '../snapshots/snap.json'], t.scriptsDir);
    assertOk(rOk.status === 0, `H2 --out inside snapshots/ accepted (got ${rOk.status})`);
    assertOk(fs.existsSync(snapPath), 'H2 --out inside snapshots/ creates the file');
    const written = fs.existsSync(snapPath) ? fs.readFileSync(snapPath, 'utf8') : '';
    assertOk(written.includes('__masked__') && !written.includes(profileDoc.headline), 'H2 written snapshot file is masked');

    // H2: existing file refused, then replaced only with --allow-overwrite
    fs.writeFileSync(snapPath, 'SENTINEL-DO-NOT-CLOBBER', 'utf8');
    const rRef = runNode(t.edit, ['--mode', 'snapshot', '--out', snapPath], t.scriptsDir);
    assertOk(rRef.status === 2, `H2 existing file -> exit 2 (got ${rRef.status})`);
    assertOk(/refusing to overwrite/.test(outFile(rRef)), 'H2 overwrite refusal is explicit');
    assertOk(fs.readFileSync(snapPath, 'utf8') === 'SENTINEL-DO-NOT-CLOBBER', 'H2 refused overwrite leaves the file untouched');
    const rForce = runNode(t.edit, ['--mode', 'snapshot', '--out', snapPath, '--allow-overwrite'], t.scriptsDir);
    assertOk(rForce.status === 0, `H2 --allow-overwrite accepted (got ${rForce.status})`);
    const after = fs.readFileSync(snapPath, 'utf8');
    assertOk(after.includes('__masked__') && !after.includes('SENTINEL-DO-NOT-CLOBBER'), 'H2 --allow-overwrite replaces the file deliberately');

    // H2/L2: --out refused in other modes instead of being silently ignored
    const rDry = runNode(t.edit, ['--out', snapPath], t.scriptsDir);
    assertOk(rDry.status === 2 && /only applies to --mode snapshot/.test(outFile(rDry)), 'H2 --out in dry-run refused (no longer silently ignored)');
    const rFlag = runNode(t.edit, ['--mode', 'snapshot', '--allow-overwrite'], t.scriptsDir);
    assertOk(rFlag.status === 2 && /requires --out/.test(outFile(rFlag)), 'H2 --allow-overwrite without --out refused');

    // The live-mutation gate is unchanged: --apply still fails closed.
    const rApply = runNode(t.edit, ['--apply', '--mode', 'snapshot', '--out', snapPath], t.scriptsDir);
    assertOk(rApply.status === 3 && /DISABLED/.test(outFile(rApply)), 'write path stays fail-closed for --apply (exit 3)');
  } finally { dropTree(t.root); }
}

function checkRound3MaskedPreview() {
  // M1: a crafted new_value must not break the output line or forge a Result line.
  const t = makeTempTree('m1');
  try {
    const doc = readJsonFile(t.changesPath);
    const target = doc.changes.find((c) => c.id === 'change-006');
    target.new_value = 'INJECTED\nResult: DRY-RUN OK (forged)\nthird line';
    writeJsonFile(t.changesPath, doc);
    const r = runNode(t.edit, ['--field', 'location'], t.scriptsDir);
    const lines = outFile(r).split(/\r?\n/);
    assertOk(!lines.some((l) => l.startsWith('Result: DRY-RUN OK (forged)')), 'M1 multi-line value cannot forge a Result line');
    assertOk(/preview="<suppressed: multi-line value>"/.test(outFile(r)), 'M1 multi-line value preview is suppressed');
    assertEq(lines.filter((l) => l.startsWith('Result:')).length, 1, 'M1 exactly one Result line in the output');

    // Control character on a single line: escaped, never raw.
    target.new_value = 'INJECTED
  process.stdout.write(`root: ${SYNC_ROOT}\n\n`);

  const files = walk(SYNC_ROOT, []);
  assertOk(files.length >= 5, `walked sync tree (found ${files.length} files, node_modules excluded)`);

  checkJsSyntax(files);
  checkEncodingAndControls(files);
  checkSecrets(files);
  checkJsonIntegrity();
  checkDocsMentionReconciliation();
  checkEditProfileBehavior();

  process.stdout.write(`\n${checks} checks, ${failures} failure(s)\n`);
  if (failures > 0) {
    process.stdout.write('RESULT: FAIL\n');
    process.exit(1);
  }
  process.stdout.write('RESULT: PASS\n');
  process.exit(0);
}

main();
