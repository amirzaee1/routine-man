#!/usr/bin/env bash
# Push pending changes in small commits: GitHub times out (HTTP 408) on one big upload over a slow link.
# usage: bash push_batches.sh "commit message"   (media files first in batches, index.html last)
set -u
cd "$(dirname "$0")"
MSG=${1:-"به‌روزرسانی سایت"}
N=${BATCH:-12}
git config http.postBuffer 524288000
push() { for t in 1 2 3 4; do GIT_TERMINAL_PROMPT=0 git push -q origin main && return 0; echo "push retry $t"; sleep 15; done; return 1; }
mapfile -t files < <(git status --porcelain --untracked-files=all | sed 's/^...//' | grep '^media/')
total=${#files[@]}; i=0; part=1
while [ $i -lt $total ]; do
  git add -- "${files[@]:i:N}"
  git commit -q -m "$MSG (رسانه، بخش $part)" && push || { echo "FAILED at batch $part"; exit 1; }
  echo "batch $part ok ($((i + N > total ? total : i + N))/$total)"
  i=$((i + N)); part=$((part + 1))
done
git add -A
git diff --cached --quiet || { git commit -q -m "$MSG

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" && push || { echo "FAILED final"; exit 1; }; }
echo "ALL PUSHED $(git rev-parse --short HEAD)"
