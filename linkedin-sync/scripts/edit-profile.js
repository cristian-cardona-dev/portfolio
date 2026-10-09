#!/usr/bin/env node
'use strict';
/*
 * edit-profile.js — LinkedIn profile editor (hardened; fix round 3, 2026-10-06)
 *
 * Policy:
 * - Defaults to DRY-RUN. No browser is launched, no network call is made, and
 *   nothing is written unless a mode explicitly produces local output.
 * - The browser write path is DISABLED on purpose (WRITE_PATH_ENABLED=false).
 *   The previous implementation clicked ambiguous selectors across multiple
 *   fields; LinkedIn's edit UI changes without notice, so automated mutation
 *   cannot be made robust without unsafe assumptions. A safe dry-run validator
 *   replaces it. Apply profile changes manually and record evidence in
 *   changes.json instead.
 * - Exactly ONE --field per invocation. Multi-field writes are rejected.
 * - --apply is required for any attempt to mutate the LIVE LinkedIn profile;
 *   with the write path disabled it always fails closed with an explanation.
 *   Local file output is deliberately NOT a live-profile mutation:
 *   `--mode snapshot --out <path>` only writes a local snapshot file and
 *   needs no --apply. Never treat a local script value as proof a LinkedIn
 *   change was applied.
 * - Dry-run is fail-closed in its reporting too: if ANY baseline guard fails
 *   OR the changes document fails its policy audit (unsupported change target,
 *   missing/non-array/empty proposal list, invalid status, 'applied' without
 *   reconciliation evidence) the run ends with `DRY-RUN BLOCKED` and exit 1.
 *   `DRY-RUN OK` / exit 0 is only printed when every guard AND every policy
 *   check passed — an unsupported proposal is surfaced, never silently ignored.
 * - Local snapshot output is sandboxed: --out must resolve inside
 *   <sync-root>/snapshots/ and must be a *.json file that does not already
 *   exist (unless --allow-overwrite is given). Anywhere else => exit 2.
 * - Snapshot and dry-run/verify output are MASKED: values are reported as
 *   kind/length/sha256 (+ a sanitized single-line preview in dry-run/verify).
 *   Raw multi-line profile content is never emitted, so no value can forge a
 *   `Result: …` log line.
 * - This file must NEVER contain credentials (tokens, cookies, passwords).
 *
 * Usage:
 *   node edit-profile.js                          # dry-run (default), all fields
 *   node edit-profile.js --field headline         # dry-run for one field
 *   node edit-profile.js --mode snapshot [--out snapshots/x.json]
 *   node edit-profile.js --mode snapshot --out snapshots/x.json --allow-overwrite
 *   node edit-profile.js --mode verify [--snapshot-file f]
 *   node edit-profile.js --apply --field headline # refused: write path disabled
 *
 * Exit codes: 0 ok · 1 policy/guard/verify failure · 2 usage error ·
 *             3 --apply refused (write path disabled) · 4 unreadable/invalid input
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SYNC_ROOT = path.resolve(__dirname, '..');
const PROFILE_PATH = path.join(SYNC_ROOT, 'profile.json');
const CHANGES_PATH = path.join(SYNC_ROOT, 'changes.json');
const METRICS_PATH = path.join(SYNC_ROOT, 'metrics.json');

// Dedicated local sandbox for snapshot output. --out may ONLY ever write here.
const SNAPSHOT_DIR = path.join(SYNC_ROOT, 'snapshots');

// Deliberate kill switch. Do not flip without a human-reviewed, tested browser
// implementation that fails closed on ambiguous selectors and unexpected pages.
// Nothing in this file reads it to enable a write: --apply is always refused.
const WRITE_PATH_ENABLED = false;

const FIELDS = ['headline', 'about', 'location', 'experience', 'skills', 'projects', 'languages'];
const MODES = ['dry-run', 'snapshot', 'verify'];
const ALLOWED_STATUSES = ['pending', 'obsolete', 'needs_review', 'applied'];

// change.field values this tool understands (aliases of FIELDS plus targets).
const CHANGE_TARGETS = {
  headline: 'headline',
  about: 'about',
  location: 'location',
  experience: 'experience[0].description',
  skills: 'skills',
  projects: 'projects',
  languages: 'languages[0].level'
};
const KNOWN_CHANGE_FIELDS = [...new Set([...FIELDS, ...Object.values(CHANGE_TARGETS)])];

// field -> key used in profile.verification / changes.json baseline_evidence /
// snapshot.profile (e.g. verify key for 'experience' is 'experience_companies').
const FIELD_KEYS = {
  headline: 'headline',
  about: 'about',
  location: 'location',
  experience: 'experience_companies',
  skills: 'skills',
  projects: 'projects',
  languages: 'languages'
};

// field -> key that holds the value inside profile.json
const PROFILE_KEYS = {
  headline: 'headline',
  about: 'about_summary',
  location: 'location',
  experience: 'experience_companies',
  skills: 'skills',
  projects: 'projects',
  languages: 'languages'
};

// changes.json baseline_evidence -> profile.json, with the comparison mode.
// 'contains' is used for `about` because the evidence string carries an extra
// "(exact text not captured)" note suffix that the profile summary does not;
// containment still fails if either side drifts.
const EVIDENCE_CHECKS = [
  { evidence: 'headline', profile: 'headline', mode: 'exact' },
  { evidence: 'about', profile: 'about_summary', mode: 'contains' },
  { evidence: 'location', profile: 'location', mode: 'exact' },
  { evidence: 'experience_companies', profile: 'experience_companies', mode: 'exact' },
  { evidence: 'languages', profile: 'languages', mode: 'exact' },
  { evidence: 'projects', profile: 'projects', mode: 'exact' }
];

const LIVE_BASELINE = {
  date: '2026-10-06',
  headline: 'Senior Full Stack .NET Engineer | C#, Azure, Angular & Cloud-Native APIs | Building Scalable Systems and AI-Enabled Products',
  location: 'Elche, Valencian Community, Spain'
};

/* ------------------------------------------------------------------ utils */

function fail(code, message) {
  process.stderr.write(`ERROR: ${message}\n`);
  process.exit(code);
}

function loadJson(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    fail(4, `cannot read ${label} (${filePath}): ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(4, `${label} is not valid JSON (${filePath}): ${err.message}`);
  }
  return null;
}

function sha12(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Canonical digest of any captured value. Used for masking, for snapshot
 * content and for drift comparison, so raw values never have to be printed.
 */
function digestOf(value) {
  if (value === null) return { kind: 'null', len: 4, sha256: sha12('null') };
  if (value === undefined) return { kind: 'undefined', len: 9, sha256: sha12('undefined') };
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  const kind = Array.isArray(value) ? 'array' : typeof value;
  return { kind, len: text.length, sha256: sha12(text) };
}

/**
 * Make text safe to embed inside one output line: escape backslash/quote and
 * turn every C0/C1/DEL control character into a printable \uXXXX sequence, so
 * a crafted value cannot break the line or forge a `Result: …` line.
 */
function sanitizePreview(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\x00-\x1f\x7f]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

/** Sanitized single-line excerpt (no raw content, bounded length). */
function oneLine(value, max) {
  const text = sanitizePreview(value);
  if (max && text.length > max) return text.slice(0, max) + '...';
  return text;
}

/** Mask any value: never log full content, only length + short hash + safe preview. */
function maskValue(value) {
  if (value === null || value === undefined) return '<not captured>';
  const d = digestOf(value);
  const previewSource = typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ')
      : JSON.stringify(value);
  let preview;
  if (/[\r\n]/.test(previewSource)) {
    // Multi-line content is never echoed, not even partially.
    preview = '<suppressed: multi-line value>';
  } else {
    preview = sanitizePreview(previewSource.slice(0, 24)) + (previewSource.length > 24 ? '...' : '');
  }
  return `<${d.kind} len=${d.len} sha256=${d.sha256} preview="${preview}">`;
}

/** Masked descriptor stored in snapshot files (kind/len/sha256 only). */
function maskedValue(value) {
  const d = digestOf(value);
  return { __masked__: true, kind: d.kind, len: d.len, sha256: d.sha256 };
}

function isMaskedDescriptor(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && value.__masked__ === true;
}

/** Digest of a value taken from a snapshot file (raw legacy or masked). */
function snapshotDigest(value) {
  if (value === undefined) return undefined;
  if (isMaskedDescriptor(value)) {
    if (typeof value.sha256 !== 'string' || typeof value.len !== 'number') return null; // malformed
    return { kind: value.kind, len: value.len, sha256: value.sha256 };
  }
  return digestOf(value);
}

/** Map a field name to its value inside the live-baseline profile.json. */
function getBaselineValue(field, profile) {
  const key = PROFILE_KEYS[field];
  if (!key) return undefined;
  return profile[key];
}

function getVerification(field, profile) {
  const v = profile.verification || {};
  const key = FIELD_KEYS[field] || field;
  const meta = v[key];
  return meta && typeof meta === 'object' ? meta : { verified: false };
}

function hasEvidence(change) {
  const rec = change.reconciliation;
  return !!(rec && typeof rec.evidence === 'string' && rec.evidence.length > 0);
}

/**
 * Baseline guard: a proposal may only be applied if its old_value still matches
 * the live baseline. Stale old_value => guard FAILS (fail closed).
 */
function checkBaselineGuard(change, baselineValue) {
  const oldVal = change.old_value;
  if (oldVal === undefined || oldVal === null) return { pass: false, note: 'proposal has no old_value to guard against' };
  if (typeof oldVal === 'string' && typeof baselineValue === 'string') {
    return oldVal === baselineValue
      ? { pass: true, note: 'old_value matches live baseline' }
      : { pass: false, note: 'old_value is stale: live baseline differs (see changes.json reconciliation)' };
  }
  if (Array.isArray(oldVal) && Array.isArray(baselineValue)) {
    return oldVal.length === baselineValue.length && oldVal.every((v, i) => v === baselineValue[i])
      ? { pass: true, note: 'old_value matches live baseline' }
      : { pass: false, note: 'old_value list differs from live baseline (or baseline unknown)' };
  }
  return { pass: false, note: 'cannot compare old_value with live baseline (type mismatch or baseline not captured)' };
}

function proposalsForField(list, field) {
  const target = CHANGE_TARGETS[field];
  return list.filter((c) => c && (c.field === field || c.field === target));
}

/**
 * Fail-closed policy audit of the whole changes document, independent of the
 * selected --field. Anything not understood is reported, never ignored.
 */
function auditChanges(changesDoc) {
  const audit = {
    structural: [],
    unknown_field: [],
    invalid_status: [],
    applied_without_evidence: [],
    total: 0,
    scanned: 0,
    list: []
  };
  const has = (k) => Object.prototype.hasOwnProperty.call(changesDoc, k);
  let raw;
  if (has('changes')) raw = changesDoc.changes;
  else if (has('pending_changes')) raw = changesDoc.pending_changes;
  else raw = undefined;

  if (raw === undefined) {
    audit.structural.push("changes.json has no 'changes' key (nor legacy 'pending_changes')");
    return audit;
  }
  if (!Array.isArray(raw)) {
    audit.structural.push(`changes.json 'changes' key is not an array (got ${raw === null ? 'null' : typeof raw})`);
    return audit;
  }
  audit.total = raw.length;
  if (raw.length === 0) {
    audit.structural.push("changes.json proposal list is empty — fail-closed: there is nothing to validate");
    return audit;
  }

  raw.forEach((c, i) => {
    const id = c && typeof c === 'object' && typeof c.id === 'string' && c.id.length > 0 ? c.id : `changes[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      audit.structural.push(`${id} is not an object`);
      return;
    }
    audit.list.push(c);
    if (typeof c.field !== 'string' || !KNOWN_CHANGE_FIELDS.includes(c.field)) {
      audit.unknown_field.push(`${id} (field=${JSON.stringify(c.field)})`);
    } else {
      audit.scanned++;
    }
    if (!ALLOWED_STATUSES.includes(c.status)) {
      audit.invalid_status.push(`${id} (status=${JSON.stringify(c.status)})`);
    }
    if (c.status === 'applied' && !hasEvidence(c)) {
      audit.applied_without_evidence.push(id);
    }
  });
  return audit;
}

function policyFailureCount(audit) {
  return audit.structural.length + audit.unknown_field.length + audit.invalid_status.length + audit.applied_without_evidence.length;
}

function auditLines(audit) {
  const lines = [];
  lines.push(
    `  total=${audit.total} scanned=${audit.scanned} unsupported_field=${audit.unknown_field.length}` +
    ` invalid_status=${audit.invalid_status.length} applied_without_evidence=${audit.applied_without_evidence.length}`
  );
  for (const s of audit.structural) lines.push(`  FAIL structural: ${s}`);
  for (const s of audit.unknown_field) {
    lines.push(`  FAIL unsupported change target: ${s} — this tool only understands: ${KNOWN_CHANGE_FIELDS.join(', ')}`);
  }
  for (const s of audit.invalid_status) {
    lines.push(`  FAIL invalid status: ${s} (allowed: ${ALLOWED_STATUSES.join(', ')})`);
  }
  for (const s of audit.applied_without_evidence) {
    lines.push(`  FAIL ${s} is marked 'applied' without reconciliation.evidence (policy: never applied from local scripts alone)`);
  }
  return lines;
}

/** Verification metadata that contradicts the captured value (fail closed). */
function verificationContradictions(profile) {
  const problems = [];
  const ver = profile.verification;
  if (!ver || typeof ver !== 'object') return ['profile.json has no verification map'];
  for (const key of Object.keys(ver)) {
    const meta = ver[key];
    if (!meta || typeof meta !== 'object') continue; // e.g. the explanatory 'note' string
    const profileKey = key === 'about' ? 'about_summary' : key;
    if (!Object.prototype.hasOwnProperty.call(profile, profileKey)) {
      problems.push(`verification.${key} has no matching value in profile.json (metadata without a value)`);
      continue;
    }
    const value = profile[profileKey];
    const captured = value !== null && value !== undefined;
    if (meta.verified !== true && meta.verified !== false) {
      problems.push(`verification.${key}.verified must be true|false (got ${JSON.stringify(meta.verified)})`);
      continue;
    }
    if (meta.verified === true && !captured) {
      problems.push(`verification.${key}.verified=true but the profile value is ${value === null ? 'null' : 'missing'} (metadata contradicts value)`);
    }
    if (meta.verified === false && captured) {
      problems.push(`verification.${key}.verified=false but the profile holds a value (unverified fields must be null + note, never a local guess)`);
    }
    if (key === 'about') {
      const exact = profile.about_exact_text;
      if (meta.exact_text_captured === false && exact !== null && exact !== undefined) {
        problems.push('verification.about.exact_text_captured=false but profile.about_exact_text holds text (fabrication risk)');
      }
      if (meta.exact_text_captured === true && (exact === null || exact === undefined)) {
        problems.push('verification.about.exact_text_captured=true but profile.about_exact_text is empty');
      }
    }
  }
  return problems;
}

/* -------------------------------------------------------------- arg parse */

function parseArgs(argv) {
  const opts = { mode: null, fields: [], apply: false, snapshotFile: null, out: null, allowOverwrite: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--mode': {
        const v = argv[++i];
        if (!v) fail(2, '--mode requires a value (dry-run | snapshot | verify)');
        if (!MODES.includes(v)) fail(2, `unknown mode '${v}' (allowed: ${MODES.join(' | ')})`);
        opts.mode = v;
        break;
      }
      case '--field': {
        const v = argv[++i];
        if (!v) fail(2, '--field requires a value');
        if (!FIELDS.includes(v)) fail(2, `unknown field '${v}' (allowed: ${FIELDS.join(' | ')})`);
        opts.fields.push(v);
        break;
      }
      case '--apply':
        opts.apply = true;
        break;
      case '--snapshot-file': {
        const v = argv[++i];
        if (!v) fail(2, '--snapshot-file requires a path');
        opts.snapshotFile = v;
        break;
      }
      case '--out': {
        const v = argv[++i];
        if (!v) fail(2, '--out requires a path');
        opts.out = v;
        break;
      }
      case '--allow-overwrite':
        opts.allowOverwrite = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      default:
        fail(2, `unknown argument '${arg}' (see --help)`);
    }
  }
  return opts;
}

const HELP = `edit-profile.js — hardened LinkedIn profile tool (local only)

Modes (default: dry-run):
  --mode dry-run     Validate proposals against the local live baseline. No network.
  --mode snapshot    Emit a deterministic JSON snapshot of local state (stdout, or to a
                     file in the dedicated local snapshot directory via --out).
                     All profile values are MASKED (kind + length + sha256); the
                     snapshot never contains raw profile content. Local output only,
                     does not touch the live profile and does not need --apply.
  --mode verify      Consistency check of local files (changes audit, baseline evidence,
                     verification metadata), or compare a captured snapshot with the
                     baseline via --snapshot-file <path>.

Guards:
  --field <name>     Exactly one of: ${FIELDS.join(', ')}
  --out <path>       --mode snapshot only. Must resolve inside
                     ${path.join('<sync-root>', 'snapshots')} and end with .json.
                     Existing files are refused unless --allow-overwrite is given.
                     Used with any other mode, or pointing anywhere else, => exit 2.
  --allow-overwrite   permit replacing an existing file inside the snapshot directory.
  --apply            Required for any attempt to mutate the LIVE LinkedIn profile.
                     The browser write path is DISABLED in this build; --apply always
                     fails closed (exit 3).

Notes:
  - No credentials are accepted, stored, or logged by this tool.
  - Values are masked in ALL output modes (length + short hash + sanitized preview).
    Control characters are escaped and multi-line values are never echoed, so no
    value can forge a "Result: ..." line.
  - changes.json is audited fail-closed: an unsupported change target, a missing/
    empty/non-array proposal list, an invalid status or 'applied' without evidence
    => surfaced and nonzero exit. "DRY-RUN OK"/"VERIFY OK" is never printed then.
  - Dry-run exits 1 with "DRY-RUN BLOCKED" when a baseline guard or a policy check
    fails; exit 0 / "DRY-RUN OK" only when every guard passes.
  - To change the live profile, edit manually and record evidence in changes.json.
`;

/* --------------------------------------------------------------- modes */

function modeDryRun(opts, profile, changesDoc) {
  const lines = [];
  let guardFailures = 0;
  lines.push('=== edit-profile — mode: dry-run (default) ===');
  lines.push(`Baseline source: profile.json (${oneLine(profile.source || 'unknown')}) [read date: ${oneLine(profile.last_updated || 'unknown')}]`);
  lines.push(`Live baseline reference: ${LIVE_BASELINE.date}`);

  const audit = auditChanges(changesDoc);
  const policyFailures = policyFailureCount(audit);

  const fields = opts.fields.length > 0 ? opts.fields : FIELDS;
  for (const field of fields) {
    const baseline = getBaselineValue(field, profile);
    const ver = getVerification(field, profile);
    lines.push('');
    lines.push(`Field: ${field}`);
    lines.push(`  verified: ${ver.verified === true}${ver.exact_text_captured === false ? ' (summary only, exact text not captured)' : ''}${ver.note ? ` — ${oneLine(ver.note)}` : ''}`);
    lines.push(`  baseline value: ${maskValue(baseline)}`);
    const proposals = proposalsForField(audit.list, field);
    if (proposals.length === 0) {
      lines.push('  proposals: none recorded for this field');
    } else {
      lines.push(`  proposals (${proposals.length}):`);
      for (const c of proposals) {
        const status = ALLOWED_STATUSES.includes(c.status) ? c.status : `INVALID(${oneLine(String(c.status))})`;
        const guard = checkBaselineGuard(c, baseline);
        if (!guard.pass) guardFailures++;
        lines.push(`    - ${oneLine(c.id)} type=${oneLine(c.type)} status=${status} priority=${oneLine(c.priority || 'n/a')}`);
        lines.push(`      proposed new_value: ${maskValue(c.new_value)}`);
        lines.push(`      baseline guard vs old_value: ${guard.pass ? 'PASS' : 'FAIL'} (${oneLine(guard.note)})`);
        if (!ALLOWED_STATUSES.includes(c.status)) {
          lines.push('      policy: FAIL — invalid status (counted in the changes audit below)');
        }
        if (c.status === 'applied' && !hasEvidence(c)) {
          lines.push('      policy: FAIL — applied without reconciliation.evidence (counted in the changes audit below)');
        }
        const rec = c.reconciliation || {};
        if (rec.reason) lines.push(`      reconciliation: applied=${rec.applied === true} — ${oneLine(rec.reason, 160)}`);
      }
    }
  }

  lines.push('');
  lines.push('Changes audit (every proposal, regardless of --field):');
  lines.push(...auditLines(audit));

  lines.push('');
  lines.push(`Write path: DISABLED (WRITE_PATH_ENABLED=${WRITE_PATH_ENABLED}). No LinkedIn mutation is possible from this tool.`);
  lines.push('--apply was not given. Nothing was written. No network calls were made.');

  const totalFailures = guardFailures + policyFailures;
  if (totalFailures === 0) {
    lines.push(`Result: DRY-RUN OK (0 baseline guard failures, ${audit.scanned}/${audit.total} changes scanned)`);
    return { text: lines.join('\n') + '\n', exitCode: 0 };
  }
  lines.push(`Result: DRY-RUN BLOCKED (${guardFailures} baseline guard failure${guardFailures === 1 ? '' : 's'}, ${policyFailures} policy failure${policyFailures === 1 ? '' : 's'})`);
  lines.push('Do NOT read this dry-run as "safe to apply": at least one proposal no longer matches the live baseline, or the changes document failed its policy audit. Exit code 1.');
  return { text: lines.join('\n') + '\n', exitCode: 1 };
}

/**
 * Resolve and validate --out. Only files inside the dedicated snapshot
 * directory, only *.json, never outside sync root (traversal included).
 */
function resolveSnapshotOut(value) {
  const resolved = path.resolve(process.cwd(), value);
  const norm = (p) => (path.sep === '\\' ? p.replace(/\//g, '\\') : p).toLowerCase();
  const dir = norm(SNAPSHOT_DIR);
  const target = norm(resolved);
  const inside = target === dir || target.startsWith(dir + path.sep);
  if (!inside) {
    fail(2, `--out must resolve inside the dedicated snapshot directory ${SNAPSHOT_DIR} (got ${resolved}). Snapshot output is sandboxed on purpose.`);
  }
  if (target === dir) {
    fail(2, `--out must be a file path inside ${SNAPSHOT_DIR}, not the directory itself`);
  }
  if (!target.endsWith('.json')) {
    fail(2, '--out file must end with .json (snapshot output only)');
  }
  return resolved;
}

function modeSnapshot(opts, profile, changesDoc) {
  const audit = auditChanges(changesDoc);
  const policyFailures = policyFailureCount(audit);

  // Fail closed: never write/emit a snapshot of a document that fails policy.
  if (policyFailures > 0) {
    fail(1, [
      'changes.json failed the policy audit — snapshot suppressed (fail-closed).',
      ...auditLines(audit)
    ].join('\n'));
  }

  const snapshot = {
    snapshot_type: 'local_state_deterministic',
    note: 'Generated from local files only. No network. No LinkedIn read or write. Values are MASKED (kind/len/sha256): this file never contains raw profile content.',
    masking: 'profile.* entries are {__masked__: true, kind, len, sha256} descriptors, not values.',
    baseline_date: profile.last_updated || LIVE_BASELINE.date,
    profile_url: profile.profile_url,
    profile: {
      headline: maskedValue(profile.headline),
      about_summary: maskedValue(profile.about_summary),
      about_exact_text: maskedValue(profile.about_exact_text === undefined ? null : profile.about_exact_text),
      location: maskedValue(profile.location),
      experience_companies: maskedValue(profile.experience_companies),
      skills: maskedValue(profile.skills),
      projects: maskedValue(profile.projects),
      certifications: maskedValue(profile.certifications),
      languages: maskedValue(profile.languages)
    },
    changes_summary: summarizeChanges(changesDoc, audit)
  };
  const text = JSON.stringify(snapshot, null, 2) + '\n';

  if (opts.out) {
    const target = resolveSnapshotOut(opts.out);
    let stat = null;
    try {
      stat = fs.statSync(target);
    } catch (err) {
      stat = null; // does not exist yet
    }
    if (stat && stat.isDirectory()) {
      fail(2, `--out target is a directory, not a file: ${target}`);
    }
    if (stat && !opts.allowOverwrite) {
      fail(2, `refusing to overwrite an existing file: ${target} (use --allow-overwrite to replace a snapshot deliberately; the file was left untouched)`);
    }
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    fs.writeFileSync(target, text, 'utf8');
    return {
      text: `local snapshot written to ${target} (masked values only; local file output, live profile untouched, no --apply required${opts.allowOverwrite ? '; existing file replaced because --allow-overwrite was given' : ''})\n`,
      exitCode: 0
    };
  }
  return { text, exitCode: 0 };
}

function summarizeChanges(changesDoc, audit) {
  const list = audit && Array.isArray(audit.list) ? audit.list : (Array.isArray(changesDoc.changes) ? changesDoc.changes : []);
  const byStatus = {};
  for (const c of list) {
    const s = c.status || 'missing';
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  return {
    total: audit ? audit.total : list.length,
    by_status: byStatus,
    applied_without_evidence: list
      .filter((c) => c.status === 'applied' && !hasEvidence(c))
      .map((c) => c.id),
    audit: audit ? {
      scanned: audit.scanned,
      unsupported_field: audit.unknown_field.length,
      invalid_status: audit.invalid_status.length,
      applied_without_evidence: audit.applied_without_evidence.length
    } : undefined
  };
}

function modeVerify(opts, profile, changesDoc) {
  const lines = [];
  lines.push('=== edit-profile — mode: verify ===');
  let failures = 0;

  // 1. Fail-closed audit of changes.json (same rules as dry-run).
  const audit = auditChanges(changesDoc);
  const policyFailures = policyFailureCount(audit);
  failures += policyFailures;
  lines.push('Changes audit:');
  lines.push(...auditLines(audit));
  if (policyFailures === 0) {
    lines.push(`OK: ${audit.total} change records scanned, ${audit.scanned}/${audit.total} targets understood, statuses valid, applied records carry evidence`);
  } else {
    lines.push(`FAIL: changes.json policy audit reported ${policyFailures} problem${policyFailures === 1 ? '' : 's'}`);
  }

  // 2. Cross-file consistency: every captured field in baseline_evidence vs profile.json.
  const ev = changesDoc.baseline_evidence;
  if (!ev || typeof ev !== 'object') {
    lines.push('FAIL: changes.json has no baseline_evidence object');
    failures++;
  } else {
    for (const check of EVIDENCE_CHECKS) {
      const evVal = ev[check.evidence];
      const profVal = profile[check.profile];
      if (evVal === undefined) {
        lines.push(`FAIL: baseline_evidence.${check.evidence} is missing (captured field not cross-checked)`);
        failures++;
        continue;
      }
      const same = check.mode === 'contains'
        ? (typeof evVal === 'string' && typeof profVal === 'string' && evVal.includes(profVal))
        : JSON.stringify(evVal) === JSON.stringify(profVal);
      if (same) {
        lines.push(`OK: changes.json baseline_evidence.${check.evidence} matches profile.json.${check.profile}`);
      } else {
        lines.push(`FAIL: changes.json baseline_evidence.${check.evidence} does not match profile.json.${check.profile}: ${maskValue(evVal)} vs ${maskValue(profVal)}`);
        failures++;
      }
    }
    // metrics_7d evidence vs metrics.json
    const evMetrics = ev.metrics_7d;
    const metrics = loadJson(METRICS_PATH, 'metrics.json');
    if (evMetrics === undefined) {
      lines.push('FAIL: baseline_evidence.metrics_7d is missing');
      failures++;
    } else if (!metrics || !metrics.baseline) {
      lines.push('FAIL: metrics.json has no baseline block to cross-check baseline_evidence.metrics_7d');
      failures++;
    } else {
      const viewsOk = evMetrics.profile_views === metrics.baseline.profile_views_per_week;
      const searchOk = evMetrics.search_appearances === metrics.baseline.search_appearances_per_week;
      if (viewsOk && searchOk) {
        lines.push('OK: changes.json baseline_evidence.metrics_7d matches metrics.json baseline');
      } else {
        lines.push('FAIL: changes.json baseline_evidence.metrics_7d does not match metrics.json baseline (profile views / search appearances)');
        failures++;
      }
    }
  }

  // 3. Local constants (warn only: they are a recorded reference, not a file fact).
  if (profile.headline !== LIVE_BASELINE.headline) {
    lines.push('WARN: profile.json headline differs from the recorded 2026-10-06 live baseline constant');
  }
  if (profile.location !== LIVE_BASELINE.location) {
    lines.push('WARN: profile.json location differs from the recorded 2026-10-06 live baseline constant');
  }

  // 4. Verification metadata must not contradict the captured values.
  const contradictions = verificationContradictions(profile);
  for (const p of contradictions) {
    lines.push(`FAIL: verification metadata contradiction — ${p}`);
    failures++;
  }
  if (contradictions.length === 0) {
    lines.push('OK: verification metadata is consistent with the captured values');
  }

  // 5. Optional: compare an externally captured snapshot (e.g., manual live read).
  if (opts.snapshotFile) {
    const snap = loadJson(path.resolve(opts.snapshotFile), 'snapshot file');
    lines.push(`Snapshot file: ${opts.snapshotFile}`);
    const snapProfile = snap.profile || snap;
    const fields = opts.fields.length > 0 ? opts.fields : FIELDS;
    for (const field of fields) {
      const baseVal = getBaselineValue(field, profile);
      const snapVal = getBaselineValue(field, snapProfile);
      const ver = getVerification(field, profile);
      if (snapVal === undefined) {
        if (ver.verified === true) {
          lines.push(`  ${field}: MISSING FROM SNAPSHOT — cannot verify a verified field (fail-closed)`);
          failures++;
        } else {
          lines.push(`  ${field}: NOT IN SNAPSHOT (unverified field, not compared)`);
        }
        continue;
      }
      const baseDigest = digestOf(baseVal);
      const snapDigest = snapshotDigest(snapVal);
      if (snapDigest === null) {
        lines.push(`  ${field}: snapshot entry is a malformed masked descriptor (fail-closed)`);
        failures++;
        continue;
      }
      const same = baseDigest.kind === snapDigest.kind && baseDigest.len === snapDigest.len && baseDigest.sha256 === snapDigest.sha256;
      if (same) {
        lines.push(`  ${field}: MATCH (${maskValue(baseVal)})`);
      } else if (ver.verified === true) {
        lines.push(`  ${field}: DRIFT — live baseline (verified ${oneLine(profile.last_updated)}) differs from snapshot: ${maskValue(baseVal)} vs ${maskValue(snapVal)}`);
        failures++;
      } else {
        lines.push(`  ${field}: differs, but baseline field is unverified — needs_review, not counted as failure: ${maskValue(baseVal)} vs ${maskValue(snapVal)}`);
      }
    }
  } else {
    lines.push('No --snapshot-file given: local consistency check only (no network performed).');
  }

  lines.push(failures === 0 ? 'Result: VERIFY OK' : `Result: VERIFY FAILED (${failures} problem${failures === 1 ? '' : 's'})`);
  return { text: lines.join('\n') + '\n', exitCode: failures === 0 ? 0 : 1 };
}

/* --------------------------------------------------------------- main */

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (!opts.mode) opts.mode = 'dry-run';
  if (opts.mode === 'dry-run' && opts.snapshotFile) fail(2, '--snapshot-file only applies to --mode verify');
  if (opts.mode === 'snapshot' && opts.fields.length > 0) fail(2, 'snapshot mode covers full state; omit --field');
  if (opts.mode === 'snapshot' && opts.snapshotFile) fail(2, '--snapshot-file only applies to --mode verify');

  // --out is local snapshot output only: refuse it anywhere else (it used to be
  // silently ignored, which made users believe output had been produced).
  if (opts.out && opts.mode !== 'snapshot') {
    fail(2, `--out only applies to --mode snapshot (mode '${opts.mode}' ignores it; refusing instead of silently dropping the flag)`);
  }
  if (opts.allowOverwrite && !opts.out) {
    fail(2, '--allow-overwrite requires --out (and only applies to --mode snapshot)');
  }

  // Exactly one field per invocation when a field is requested.
  if (opts.fields.length > 1) {
    fail(2, `exactly one --field per invocation (got ${opts.fields.length}: ${opts.fields.join(', ')}). Multi-field writes are refused by policy.`);
  }

  // Mutation gate: --apply required for any live-profile mutation, and the
  // write path is disabled -> fail closed. (--out snapshot files are local
  // output, handled below, and are not a live-profile mutation.)
  if (opts.apply) {
    const fieldDesc = opts.fields.length === 1 ? opts.fields[0] : '<none>';
    const reason = WRITE_PATH_ENABLED
      ? 'WRITE_PATH_ENABLED is true, but no human-reviewed browser implementation ships in this build — still failing closed.'
      : 'the browser write path is DISABLED in this hardened build.';
    process.stderr.write([
      `REFUSED: --apply was requested but ${reason}`,
      `  field requested: ${fieldDesc}`,
      '  reason: LinkedIn edit UI selectors are unstable; automated mutation cannot be made',
      '  robust without unsafe assumptions. No browser was launched and no request was sent.',
      '  next step: apply the change manually in LinkedIn, then update changes.json with',
      '  status + reconciliation.evidence referencing the live value. Use --mode verify',
      '  afterwards to confirm local consistency.'
    ].join('\n') + '\n');
    process.exit(3);
  }

  const profile = loadJson(PROFILE_PATH, 'profile.json');
  const changesDoc = loadJson(CHANGES_PATH, 'changes.json');

  let result;
  if (opts.mode === 'snapshot') result = modeSnapshot(opts, profile, changesDoc);
  else if (opts.mode === 'verify') result = modeVerify(opts, profile, changesDoc);
  else result = modeDryRun(opts, profile, changesDoc);

  process.stdout.write(result.text);
  process.exit(result.exitCode);
}

main();