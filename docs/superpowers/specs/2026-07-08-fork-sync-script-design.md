# Design: fork-sync.sh — Fork Branch Sync Script

**Date:** 2026-07-08  
**Status:** Approved

## Overview

Extract the git sync + cherry-pick logic from `a-welan-release.yml` into a standalone shell script `fork-sync.sh` at the repository root. The CI YAML calls the script after resolving the upstream tag, then proceeds with tests, build, push, and release.

## Motivation

The current CI YAML embeds all git sync logic inline across four steps. This makes the logic hard to test locally and forces debugging through CI re-runs. A dedicated script can be run locally with the same env vars, validated independently, and kept separate from CI plumbing.

## Interface

**File:** `fork-sync.sh` (repository root, executable)

**Invocation:** read entirely from environment variables — no positional arguments.

| Variable | Required | Description | Example |
|---|---|---|---|
| `UPSTREAM_URL` | yes | Upstream repository URL | `https://github.com/anomalyco/opencode.git` |
| `BRANCH_NAME` | yes | Local branch to create/reset | `welan` |
| `PATCH_AUTHOR` | yes | Author name substring to match | `weizhoublue` |
| `RELEASE_TAG` | yes | Upstream tag to base the branch on | `v1.17.15` |

All four variables are required. Missing any one causes immediate exit with code 3.

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — local `$BRANCH_NAME` is checked out with patches applied |
| `1` | No patch commits found at the tip of `origin/$BRANCH_NAME` by `$PATCH_AUTHOR` |
| `2` | Cherry-pick conflict — conflict details printed to stderr before exit |
| `3` | Configuration error — missing env var, upstream tag not found, or other setup failure |

## Logic Flow

```
1. Validate env vars (UPSTREAM_URL, BRANCH_NAME, PATCH_AUTHOR, RELEASE_TAG)
   → any missing: print which var is missing, exit 3

2. Configure upstream remote
   → if remote "upstream" exists: git remote set-url upstream $UPSTREAM_URL
   → else: git remote add upstream $UPSTREAM_URL

3. Fetch patch branch from origin
   → git fetch origin "$BRANCH_NAME:refs/remotes/origin/$BRANCH_NAME" --tags

4. Fetch upstream tag
   → git fetch upstream "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
   → verify tag resolves to a commit; exit 3 if not

5. Reset local branch to upstream tag
   → git checkout -B "$BRANCH_NAME" "$RELEASE_TAG"

6. Find patch boundary (first-parent walk)
   → walk origin/$BRANCH_NAME's first-parent chain
   → stop at first commit NOT authored by $PATCH_AUTHOR
   → if origin/$BRANCH_NAME tip itself is not by $PATCH_AUTHOR: exit 1

7. Collect patch commits (no merge commits)
   → git log --no-merges --reverse --format='%H' "$boundary..origin/$BRANCH_NAME"
   → if empty: exit 1

8. Cherry-pick each commit in order
   → on success: exit 0
   → on failure: print conflict report (see below), git cherry-pick --abort, exit 2
```

## Merge Commit Handling

The boundary walk follows first-parent only, so a merge commit authored by `$PATCH_AUTHOR` (e.g. a merged GitHub PR) is correctly included in the author range and used only to determine the boundary. Actual commits to cherry-pick are collected with `--no-merges`, which surfaces the real patch commits from any merged branches rather than the merge bookkeeping commit. This means no commit ever requires `cherry-pick -m`.

## Conflict Reporting

On cherry-pick failure the script prints to stderr:

- The failing commit SHA and subject
- Conflicted file list (`git diff --name-only --diff-filter=U`)
- `git status --short`
- `git diff --cc` (combined diff)
- Full contents of each conflicted file
- If `GITHUB_ACTIONS=true`: a `::error::` annotation line for GitHub Actions UI

After printing, the script runs `git cherry-pick --abort` to leave the repo clean, then exits 2.

## CI YAML Changes

### New top-level env var

```yaml
env:
  UPSTREAM_URL: https://github.com/anomalyco/opencode.git
  BRANCH_NAME: welan
  PATCH_AUTHOR: weizhoublue
  # RELEASE_TAG set dynamically by "Resolve upstream tag" step
```

### Steps replaced (4 → 1)

**Removed steps:**
- Configure upstream remote
- Fetch branches and tags
- Prepare branch from upstream tag
- Cherry-pick author patches
- Print cherry-pick conflict details

**Replacement:**
```yaml
- name: Sync fork branch with upstream tag
  run: ./fork-sync.sh
```

The script exits non-zero on any failure, which causes the CI step to fail. No separate conflict-detail step is needed — the script handles its own output.

### Retained steps (unchanged)

Checkout repository → Configure git identity → Resolve upstream tag → **[script call]** → Setup Node → Setup Bun → Run tests → Build CLI binaries → Stage release binaries → Push rebased branch → Push release archive branch → Replace GitHub release.

## Local Usage

```bash
UPSTREAM_URL=https://github.com/anomalyco/opencode.git \
BRANCH_NAME=welan \
PATCH_AUTHOR=weizhoublue \
RELEASE_TAG=v1.17.15 \
./fork-sync.sh
```

## Out of Scope

- Auto-resolving the latest upstream tag (stays in CI YAML's "Resolve upstream tag" step)
- Pushing the branch to origin (stays in CI YAML)
- Creating GitHub releases (stays in CI YAML)
- Running tests or building binaries (stays in CI YAML)
