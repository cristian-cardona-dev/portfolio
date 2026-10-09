# GitHub Username Migration Integration

- Source base: `33defb3` (portfolio/main committed HEAD)
- Branch: `ai/github-username-integration`
- Canonical: `cristian-cardona-dev` (https://github.com/cristian-cardona-dev); display brand `Cristian Cardona Dev`

## Files changed
automation/manual-guide.md, automation/templates.md, content/article-1-llm-integration.md, content/job-applications.md, content/linkedin-post-1.md, linkedin-sync/dashboard.md, profiles/github-readme.md, profiles/linkedin-optimized.md, profiles/upwork-optimized.md

Changes: GitHub URLs and stats username migrated; malformed `github://tuuser` fixed; `tuuser.dev` line removed (no domain invented); display-brand titles/bios updated. No project README clone URLs existed.

## Preserved
- All `linkedin.com/in/...` URLs (including `hunterprox`, `tuuser` placeholder)
- `linkedin-sync/archive/**`, `linkedin-sync/sync-log.md`, changes.json evidence
- `hunterprox.github.io/professional-evolution-portfolio/` Pages URL (deferred)
- Placeholders: `tuemail@gmail.com`, `[Tu Nombre]`, plain "Hunter" signatures

## Commit
Exact hash: see `git log -1 ai/github-username-integration` (a document cannot contain its own hash); reported in task-7-report.md.

## Integrating into dirty portfolio/main
Do not overwrite uncommitted changes. Commit or stash your work first, then `git cherry-pick ai/github-username-integration` (or merge). On conflicts, resolve by hand keeping your uncommitted edits and only applying the username/brand substitutions. Never use `checkout --`/`reset --hard`.
