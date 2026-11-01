#!/usr/bin/env bash
# A fresh demo PR on demo-shop (ROADMAP T7.2, ARCHITECTURE §32): a new demo/* branch at the head of
# the almost-right (or correct) discount code, and a PR that closes #5. Open demo PRs from earlier
# takes are closed first, never merged, so no take starts from another's fix.
#
#   scripts/demo/reset.sh [almost-right|correct] [--keep] [--dry-run]
#
#   --keep     leave earlier demo PRs open
#   --dry-run  say what it would do, and change nothing
#
# Nothing here costs money, but the PR's first run does (about $0.2, §27): it explores each
# criterion once and caches the paths. `scripts/demo/prewarm.sh <pr>` waits for that run. Needs gh,
# signed in with write access to demo-shop.
set -euo pipefail

REPO=sumithprabhu/demo-shop
TICKET=5
usage="usage: scripts/demo/reset.sh [almost-right|correct] [--keep] [--dry-run]"

kind=almost-right
keep=false
dry=false
for arg in "$@"; do
  case "$arg" in
    almost-right | correct) kind=$arg ;;
    --keep) keep=true ;;
    --dry-run) dry=true ;;
    *)
      echo "$usage" >&2
      exit 2
      ;;
  esac
done

# Runs a command, or only shows it with --dry-run.
act() {
  if $dry; then
    echo "would run: $*" >&2
  else
    "$@"
  fi
}

source_branch="pr/discount-$kind"
sha=$(gh api "repos/$REPO/commits/$source_branch" --jq .sha)
branch="demo/$kind-$(date -u +%Y%m%d-%H%M%S)"
echo "$source_branch is at ${sha:0:7}"

if ! $keep; then
  open=$(gh pr list -R "$REPO" --state open --limit 100 --json number,headRefName \
    --jq '.[] | select(.headRefName | startswith("demo/")) | .number')
  for pr in $open; do
    echo "closing the earlier demo PR #$pr"
    act gh pr close "$pr" -R "$REPO" \
      --comment "Closed by Intenzo's scripts/demo/reset.sh: a fresh demo PR replaces it."
  done
fi

echo "new branch $branch at ${sha:0:7}"
act gh api -X POST "repos/$REPO/git/refs" -f "ref=refs/heads/$branch" -f "sha=$sha" --silent

body="Closes #$TICKET

A demo copy of the $kind discount code (\`$source_branch\` at ${sha:0:7}), opened by Intenzo's \`scripts/demo/reset.sh\`. Closed afterwards, never merged."
# Not a draft: a draft PR starts no run (§17).
url=$(act gh pr create -R "$REPO" --base main --head "$branch" \
  --title "Add discount codes to the cart" --body "$body")
if $dry; then
  exit 0
fi
pr=${url##*/}
echo
echo "Opened $url"
echo "Its first run explores each criterion once and caches the paths. Next:"
echo "  scripts/demo/prewarm.sh $pr"
