# fork-sync.sh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the git sync + cherry-pick logic from `a-welan-release.yml` into a standalone `fork-sync.sh` script at the repository root, then update the CI YAML to call it.

**Architecture:** A single self-contained bash script reads four required env vars, configures the upstream remote, fetches and resets the local branch to the upstream tag, collects non-merge patch commits via first-parent boundary walk + `--no-merges`, and cherry-picks them in order. The CI YAML drops the five replaced steps and calls the script with a single `run:` line.

**Tech Stack:** bash (strict mode), git, existing GitHub Actions workflow

## Global Constraints

- Script must be POSIX-compatible bash (`#!/usr/bin/env bash`, `set -euo pipefail`)
- All four env vars (`UPSTREAM_URL`, `BRANCH_NAME`, `PATCH_AUTHOR`, `RELEASE_TAG`) are required — missing any one exits 3
- Exit codes: 0 success, 1 no patches, 2 cherry-pick conflict, 3 config/setup error
- Conflict output goes to stderr; `::error::` annotation emitted only when `GITHUB_ACTIONS=true`
- No positional arguments — interface is entirely env vars
- Script must be executable (`chmod +x`)

---

### Task 1: Create `fork-sync.sh`

**Files:**
- Create: `fork-sync.sh`

**Interfaces:**
- Consumes: env vars `UPSTREAM_URL`, `BRANCH_NAME`, `PATCH_AUTHOR`, `RELEASE_TAG`; existing git repo with `origin` remote already configured
- Produces: local branch `$BRANCH_NAME` checked out and pointing to cherry-picked HEAD on success; exits non-zero with diagnostic output on failure

- [ ] **Step 1: Create the script file with shebang and exit-code documentation**

```bash
cat > fork-sync.sh << 'EOF'
#!/usr/bin/env bash
set -euo pipefail

# fork-sync.sh — Sync a fork branch with an upstream tag and apply patch commits.
#
# Required environment variables:
#   UPSTREAM_URL   upstream git remote URL
#   BRANCH_NAME    local branch to create/reset
#   PATCH_AUTHOR   author name substring to match (contiguous tip commits)
#   RELEASE_TAG    upstream tag to base the branch on (e.g. v1.17.15)
#
# Exit codes:
#   0  success — $BRANCH_NAME is ready with patches applied
#   1  no patch commits found at tip of origin/$BRANCH_NAME
#   2  cherry-pick conflict — details printed to stderr
#   3  configuration or setup error
EOF
```

- [ ] **Step 2: Add the `err` helper and env-var validation block**

Append to `fork-sync.sh`:

```bash
err() { echo "ERROR: $*" >&2; }

# ── 1. Validate required env vars ───────────────────────────────────────────
required_vars=(UPSTREAM_URL BRANCH_NAME PATCH_AUTHOR RELEASE_TAG)
missing=()
for v in "${required_vars[@]}"; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required environment variables: ${missing[*]}"
  exit 3
fi
```

- [ ] **Step 3: Add upstream remote configuration, fetch, and tag verification**

Append to `fork-sync.sh`:

```bash
# ── 2. Configure upstream remote ────────────────────────────────────────────
if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$UPSTREAM_URL"
else
  git remote add upstream "$UPSTREAM_URL"
fi

# ── 3. Fetch patch branch and upstream tag ───────────────────────────────────
git fetch origin "$BRANCH_NAME:refs/remotes/origin/$BRANCH_NAME" --tags
git fetch upstream "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"

if ! git rev-parse --verify "refs/tags/$RELEASE_TAG^{commit}" >/dev/null 2>&1; then
  err "Tag $RELEASE_TAG not found after fetch"
  exit 3
fi

# ── 4. Reset local branch to upstream tag ────────────────────────────────────
git checkout -B "$BRANCH_NAME" "$RELEASE_TAG"
```

- [ ] **Step 4: Add the first-parent boundary walk and patch-commit collection**

Append to `fork-sync.sh`:

```bash
# ── 5. Find patch boundary (first-parent walk) ────────────────────────────────
# Walk origin/$BRANCH_NAME's first-parent chain until we hit a commit not
# authored by $PATCH_AUTHOR. Merge commits authored by $PATCH_AUTHOR are
# included in the walk but excluded from cherry-pick by --no-merges below.
base_ref="origin/$BRANCH_NAME"
while true; do
  author="$(git log -1 --format='%an' "$base_ref")"
  if [[ "$author" != *"$PATCH_AUTHOR"* ]]; then
    break
  fi
  if ! git rev-parse "${base_ref}^" >/dev/null 2>&1; then
    break
  fi
  base_ref="${base_ref}^"
done

if [[ "$(git rev-parse "$base_ref")" == "$(git rev-parse "origin/$BRANCH_NAME")" ]]; then
  err "No commits authored by $PATCH_AUTHOR found at the tip of origin/$BRANCH_NAME"
  exit 1
fi

# ── 6. Collect non-merge patch commits (oldest first) ────────────────────────
# --no-merges skips merge bookkeeping commits so every collected SHA is a
# plain commit and can be cherry-picked without -m.
mapfile -t patch_commits < <(
  git log --no-merges --reverse --format='%H' "${base_ref}..origin/$BRANCH_NAME"
)

if [[ ${#patch_commits[@]} -eq 0 ]]; then
  err "No non-merge commits found in range ${base_ref}..origin/$BRANCH_NAME"
  exit 1
fi

echo "Cherry-picking ${#patch_commits[@]} commit(s) onto $RELEASE_TAG (author: $PATCH_AUTHOR)"
```

- [ ] **Step 5: Add the cherry-pick loop with conflict reporting**

Append to `fork-sync.sh`:

```bash
# ── 7. Cherry-pick each commit ────────────────────────────────────────────────
for sha in "${patch_commits[@]}"; do
  subject="$(git log -1 --format='%s' "$sha")"
  echo "  cherry-pick $sha $subject"

  if ! git cherry-pick "$sha"; then
    echo "" >&2
    if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
      echo "::error::$BRANCH_NAME/$RELEASE_TAG cherry-pick conflict on $sha ($subject)" >&2
    fi
    err "cherry-pick conflict on $sha: $subject"
    echo "" >&2

    echo "Conflicted files:" >&2
    git diff --name-only --diff-filter=U >&2 || true
    echo "" >&2

    echo "Git status:" >&2
    git status --short >&2
    echo "" >&2

    echo "Combined diff:" >&2
    git diff --cc >&2 || true
    echo "" >&2

    echo "Conflicted file contents:" >&2
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      echo "── $file ──" >&2
      if [[ -f "$file" ]] && grep -Iq . "$file"; then
        cat "$file" >&2
      else
        echo "(binary or missing)" >&2
      fi
    done < <(git diff --name-only --diff-filter=U || true)

    git cherry-pick --abort || true
    exit 2
  fi
done

echo "Done. $BRANCH_NAME is ready at $(git rev-parse HEAD)"
```

- [ ] **Step 6: Make the script executable and verify syntax**

```bash
chmod +x fork-sync.sh
bash -n fork-sync.sh
echo "Syntax OK"
```

Expected output: `Syntax OK`

- [ ] **Step 7: Smoke-test env var validation locally**

```bash
# Should exit 3 and print which vars are missing
bash fork-sync.sh 2>&1 || echo "exit $?"
```

Expected output contains:
```
ERROR: Missing required environment variables: UPSTREAM_URL BRANCH_NAME PATCH_AUTHOR RELEASE_TAG
exit 3
```

- [ ] **Step 8: Commit**

```bash
git add fork-sync.sh
git commit -m "feat(ci): add fork-sync.sh to encapsulate git sync and cherry-pick logic"
```

---

### Task 2: Update CI YAML to call `fork-sync.sh`

**Files:**
- Modify: `.github/workflows/a-welan-release.yml`

**Interfaces:**
- Consumes: `fork-sync.sh` from Task 1 (executable at repo root); `RELEASE_TAG` env var set by "Resolve upstream tag" step
- Produces: CI YAML with 5 inline steps replaced by 1 script call; new `UPSTREAM_URL` env var at top level

- [ ] **Step 1: Add `UPSTREAM_URL` to the top-level `env` block**

In `.github/workflows/a-welan-release.yml`, find the `env:` section:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
  GH_TOKEN: ${{ secrets.WELAN_PAT }}
  WELAN_PATCH_AUTHOR: weizhoublue
  BRANCH_NAME: welan
```

Change to:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
  GH_TOKEN: ${{ secrets.WELAN_PAT }}
  PATCH_AUTHOR: weizhoublue
  BRANCH_NAME: welan
  UPSTREAM_URL: https://github.com/anomalyco/opencode.git
```

Note: rename `WELAN_PATCH_AUTHOR` → `PATCH_AUTHOR` to match the script's expected variable name.

- [ ] **Step 2: Update any remaining references to `WELAN_PATCH_AUTHOR` in the YAML**

Search for `WELAN_PATCH_AUTHOR` in the file:

```bash
grep -n "WELAN_PATCH_AUTHOR" .github/workflows/a-welan-release.yml
```

The release notes line (near the bottom) references it:
```yaml
--notes "Fork release: upstream ${RELEASE_TAG} plus tip commits authored by ${WELAN_PATCH_AUTHOR} at ${target}."
```

Change to:
```yaml
--notes "Fork release: upstream ${RELEASE_TAG} plus tip commits authored by ${PATCH_AUTHOR} at ${target}."
```

- [ ] **Step 3: Remove the five replaced steps**

Delete these steps entirely from the YAML:
1. `- name: Configure upstream remote` (the block with `git remote get-url upstream` / `git remote set-url` / `git remote add`)
2. `- name: Fetch branches and tags` (the block with `git fetch origin "$BRANCH_NAME:..."`)
3. `- name: Prepare branch from upstream tag` (the block with `git checkout -B "$BRANCH_NAME" "$RELEASE_TAG"`)
4. `- name: Cherry-pick author patches` (the large block with `id: patches`, `continue-on-error: true`, the boundary walk, mapfile, and cherry-pick loop)
5. `- name: Print cherry-pick conflict details` (the block with `if: steps.patches.outcome == 'failure'`)

- [ ] **Step 4: Insert the single replacement step after "Resolve upstream tag"**

After the `- name: Resolve upstream tag` step block (which ends with writing to `$GITHUB_ENV`), insert:

```yaml
      - name: Sync fork branch with upstream tag
        run: ./fork-sync.sh
```

- [ ] **Step 5: Verify the final step order is correct**

After editing, confirm the steps read in this order (names only):

```
Checkout repository
Configure git identity
Resolve upstream tag
Sync fork branch with upstream tag
Setup Node
Setup Bun
Check zen limit error contract
Run run command limit and retry contract tests
Run run command module tests
Run env key priority tests
Build CLI binaries
Stage release binaries
Push rebased branch
Push release archive branch
Replace GitHub release
```

Run:
```bash
grep "^      - name:" .github/workflows/a-welan-release.yml
```

- [ ] **Step 6: Validate YAML syntax**

```bash
python3 -c "import yaml, sys; yaml.safe_load(open('.github/workflows/a-welan-release.yml'))" && echo "YAML OK"
```

Expected: `YAML OK`

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/a-welan-release.yml
git commit -m "refactor(ci): call fork-sync.sh, remove inline git sync steps"
```

- [ ] **Step 8: Push and trigger CI to verify end-to-end**

```bash
git push origin welan
gh workflow run a-welan-release.yml \
  --repo weizhoublue/opencode \
  --ref welan \
  --field version=v1.17.15
```

Watch the run. The "Sync fork branch with upstream tag" step should pass. If cherry-pick conflict occurs, stderr from `fork-sync.sh` will appear directly in the CI log with the structured conflict report.
