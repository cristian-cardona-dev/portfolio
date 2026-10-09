# GitHub Username Migration Integration

- Source base: `33defb3` (portfolio/main committed HEAD)
- Branch: `ai/github-username-integration`
- Canonical: `cristian-cardona-dev` (https://github.com/cristian-cardona-dev); display brand `Cristian Cardona Dev`

## Files changed
automation/manual-guide.md, automation/templates.md, content/article-1-llm-integration.md, content/job-applications.md, content/linkedin-post-1.md, linkedin-sync/dashboard.md, profiles/github-readme.md, profiles/linkedin-optimized.md, profiles/upwork-optimized.md

Changes: GitHub URLs and stats username migrated; malformed `github://tuuser` fixed; `tuuser.dev` line removed (no domain invented); display-brand titles/bios updated. Project README clone URLs existed and were migrated to `cristian-cardona-dev` in commit `ai(portfolio): migrate project README clone URLs` (post-merge correction).

## Preserved
- All `linkedin.com/in/...` URLs (including `hunterprox`), as external LinkedIn identities
- `linkedin-sync/archive/**`, `linkedin-sync/sync-log.md`, changes.json evidence
- `hunterprox.github.io/professional-evolution-portfolio/` Pages URL (deferred)
- Historical `HunterProX` evidence lines (captured live values from 2026-10-06)

## Resolved placeholders (2026-10-09)
- `[Tu Nombre]` → `Cristian Cardona` (user-approved name)
- `tuemail@gmail.com` → `crisss198@gmail.com` (user-supplied personal email)
- `linkedin.com/in/tuuser` → `linkedin.com/in/cristian-cardona-dev` (evidenced in linkedin-sync/profile.json)
- plain `Hunter` signatures → `Cristian Cardona Dev` (user-approved unification)

## Commit
Exact hash: see `git log -1 ai/github-username-integration` (a document cannot contain its own hash); reported in task-7-report.md.

## Integrating into dirty portfolio/main
Do not overwrite uncommitted changes. The correct procedure (per final review 2026-10-09) is checkpoint-then-merge:
1. Commit or stash the current uncommitted work in `portfolio/main` first.
2. Merge this branch (`ai/github-username-integrated-final`) — NOT a cherry-pick of `ai/github-username-integration` (`b121b23`), which would drop the validator repair and the integrated local-work commits.
3. Expected conflicts: keep the branch side for `linkedin-sync/sync-log.md` (2026-10-09 appended note) and `linkedin-sync/scripts/validate.js` (repaired file); `linkedin-sync/dashboard.md` merges clean.
4. Never use `-X ours`, `checkout --`, or `reset --hard`.
5. Post-merge: run `npm test` in `linkedin-sync/scripts` (expect 173 checks / 0 failures).
