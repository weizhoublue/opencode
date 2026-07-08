#!/usr/bin/env bash
set -euo pipefail

# fork-sync.sh — 将 fork 分支同步到上游 tag，并将 patch 提交 cherry-pick 上去。
#
# 必需环境变量：
#   UPSTREAM_URL   上游仓库 git 地址
#   BRANCH_NAME    要创建或重置的本地分支名
#   PATCH_AUTHOR   patch 作者名称子串（用于匹配分支顶部的连续提交）
#   UPSTREAM_RELEASE_TAG    基准上游 tag（例如 v1.17.15）
#
# 退出码：
#   0  成功 — $BRANCH_NAME 已包含全部 patch
#   1  在 origin/$BRANCH_NAME 顶部未找到 patch 提交
#   2  cherry-pick 冲突 — 详情已输出到 stderr
#   3  配置或环境错误

err() { echo "ERROR: $*" >&2; }
log() { echo "[fork-sync] $*"; }

# ── 1. 校验必需环境变量 ──────────────────────────────────────────────────────
required_vars=(UPSTREAM_URL BRANCH_NAME PATCH_AUTHOR UPSTREAM_RELEASE_TAG)
missing=()
for v in "${required_vars[@]}"; do
  [[ -n "${!v:-}" ]] || missing+=("$v")
done
if [[ ${#missing[@]} -gt 0 ]]; then
  err "Missing required environment variables: ${missing[*]}"
  exit 3
fi

log "配置参数："
log "  UPSTREAM_URL = $UPSTREAM_URL"
log "  BRANCH_NAME  = $BRANCH_NAME"
log "  PATCH_AUTHOR = $PATCH_AUTHOR"
log "  UPSTREAM_RELEASE_TAG  = $UPSTREAM_RELEASE_TAG"

# ── 2. 确认工作区干净 ──────────────────────────────────────────────────────
if [[ -n "$(git status --porcelain)" ]]; then
  err "Working tree has uncommitted changes; commit or stash them before running this script"
  exit 3
fi

# ── 3. 配置 upstream remote（幂等） ─────────────────────────────────────────
if git remote get-url upstream >/dev/null 2>&1; then
  log "upstream remote 已存在，更新 URL → $UPSTREAM_URL"
  git remote set-url upstream "$UPSTREAM_URL"
else
  log "添加 upstream remote → $UPSTREAM_URL"
  git remote add upstream "$UPSTREAM_URL"
fi

# ── 4. 拉取 patch 分支与上游 tag ────────────────────────────────────────────
log "拉取 origin/${BRANCH_NAME} ..."
git fetch origin "$BRANCH_NAME:refs/remotes/origin/$BRANCH_NAME" --no-tags
log "拉取上游 tag $UPSTREAM_RELEASE_TAG ..."
git fetch upstream "+refs/tags/$UPSTREAM_RELEASE_TAG:refs/tags/$UPSTREAM_RELEASE_TAG"

if ! git rev-parse --verify "refs/tags/$UPSTREAM_RELEASE_TAG^{commit}" >/dev/null 2>&1; then
  err "Tag $UPSTREAM_RELEASE_TAG not found after fetch"
  exit 3
fi

tag_sha="$(git rev-parse "refs/tags/$UPSTREAM_RELEASE_TAG^{commit}")"
log "tag $UPSTREAM_RELEASE_TAG → $tag_sha"

# ── 5. 将本地分支重置到上游 tag ─────────────────────────────────────────────
log "将 ${BRANCH_NAME} 重置到 $UPSTREAM_RELEASE_TAG ..."
git checkout -B "$BRANCH_NAME" "$UPSTREAM_RELEASE_TAG"
log "当前 HEAD: $(git rev-parse HEAD)"

# ── 6. 找到 patch 边界（首父链走查） ────────────────────────────────────────
# 沿 origin/$BRANCH_NAME 的首父链向上，直到遇到非 $PATCH_AUTHOR 的提交为止。
# $PATCH_AUTHOR 自己制造的 merge commit 会被走查经过，但在第 7 步的
# --no-merges 中会被跳过，不会直接 cherry-pick。
log "沿首父链查找 patch 边界（作者匹配：${PATCH_AUTHOR}）..."
base_ref="origin/$BRANCH_NAME"
depth=0
while true; do
  author="$(git log -1 --format='%an <%ae>' "$base_ref")"
  sha_short="$(git rev-parse --short "$base_ref")"
  if [[ "$author" != *"$PATCH_AUTHOR"* ]]; then
    log "  边界停止 @ ${sha_short}（作者：${author}，走查深度：${depth}）"
    break
  fi
  log "  跳过 patch 提交 @ ${sha_short}（作者：${author}）"
  if ! git rev-parse "${base_ref}^" >/dev/null 2>&1; then
    break
  fi
  base_ref="${base_ref}^"
  (( depth++ )) || true
done

base_sha="$(git rev-parse "$base_ref")"
tip_sha="$(git rev-parse "origin/$BRANCH_NAME")"
log "patch 范围：${base_sha} .. ${tip_sha}"

if [[ "$base_sha" == "$tip_sha" ]]; then
  err "No commits authored by ${PATCH_AUTHOR} found at the tip of origin/${BRANCH_NAME}"
  exit 1
fi

# ── 7. 收集非 merge 的 patch 提交（从旧到新） ───────────────────────────────
# --no-merges 跳过 merge 提交，避免 cherry-pick 时需要 -m 选项。
# --topo-order 保证父提交先于子提交，防止时间戳乱序导致 cherry-pick 失败。
log "收集待 cherry-pick 的提交..."
mapfile -t patch_commits < <(
  git log --no-merges --topo-order --reverse --format='%H' "${base_ref}..origin/$BRANCH_NAME" |
    while IFS= read -r sha; do
      author="$(git log -1 --format='%an <%ae>' "$sha")"
      [[ "$author" == *"$PATCH_AUTHOR"* ]] && echo "$sha"
    done
)

if [[ ${#patch_commits[@]} -eq 0 ]]; then
  err "No non-merge commits found in range ${base_ref}..origin/${BRANCH_NAME}"
  exit 1
fi

log "共找到 ${#patch_commits[@]} 个 patch 提交："
for sha in "${patch_commits[@]}"; do
  log "  $(git log -1 --format='%h %s' "$sha")"
done

log "开始 cherry-pick ${#patch_commits[@]} 个提交到 ${UPSTREAM_RELEASE_TAG} ..."

# ── 8. 逐个 cherry-pick ─────────────────────────────────────────────────────
idx=0
for sha in "${patch_commits[@]}"; do
  (( idx++ )) || true
  subject="$(git log -1 --format='%s' "$sha")"
  log "[${idx}/${#patch_commits[@]}] cherry-pick $(git rev-parse --short "$sha") ${subject}"

  if ! git cherry-pick "$sha"; then
    echo "" >&2
    # 在 GitHub Actions 环境中输出可被 UI 识别的 ::error:: 注解
    if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
      echo "::error::${BRANCH_NAME}/${UPSTREAM_RELEASE_TAG} cherry-pick conflict on ${sha} (${subject})" >&2
    fi
    err "cherry-pick conflict on ${sha}: ${subject}"
    echo "" >&2

    # 输出冲突诊断信息，便于排查
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

    # 中止 cherry-pick，保持工作区干净
    git cherry-pick --abort || true
    exit 2
  fi
  log "  ✓ 成功应用 $(git rev-parse --short HEAD)"
done

log "全部完成。${BRANCH_NAME} 已就绪，HEAD = $(git rev-parse HEAD)"
