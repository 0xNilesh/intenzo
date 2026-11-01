#!/usr/bin/env bash
# Warm Intenzo for a demo take (ROADMAP T7.2, ARCHITECTURE §27): Modal keeps a worker container
# running, and a demo PR's path cache is seeded, so the PR's next run replays cached paths on a warm
# worker. Baseten's Model APIs need no warming: they showed no cold start (T0.2b).
#
#   scripts/demo/prewarm.sh <pr>     min_containers=1 on the worker, then wait for the PR's run: its
#                                    first explores each criterion once and saves the paths (§19 3a)
#   scripts/demo/prewarm.sh off      min_containers=0
#   scripts/demo/prewarm.sh status   the worker's autoscaler, and the open demo PRs
#
# A warm container is billed while it's up, busy or idle: run_job asks for 4 cores and 8 GiB at
# Modal's non-preemptible rate (3× list), about $0.76 an hour (modal.com/pricing, 2026-11-01). Turn
# it off after the take; the next `modal deploy` also resets it. Needs the Modal CLI, signed in to
# the workspace that runs intenzo-worker, and gh, signed in with access to demo-shop.
set -euo pipefail

REPO=sumithprabhu/demo-shop
APP=intenzo-worker
FUNCTION=run_job
usage="usage: scripts/demo/prewarm.sh <pr> | off | status"

# The Python that has the modal package: MODAL_PYTHON, else the one beside the Modal CLI (pipx puts
# it in the same venv), else python3.
modal_python() {
  local candidate
  for candidate in "${MODAL_PYTHON:-}" \
    "$(dirname "$(readlink -f "$(command -v modal || echo "$HOME/.local/bin/modal")")")/python" \
    python3; do
    if [ -n "$candidate" ] && "$candidate" -c 'import modal' 2>/dev/null; then
      echo "$candidate"
      return
    fi
  done
  echo "no Python with the modal package: install the Modal CLI, or set MODAL_PYTHON" >&2
  exit 1
}

# Sets the worker's min_containers ("" leaves it as it is), and prints its autoscaler.
autoscale() {
  "$(modal_python)" - "$APP" "$FUNCTION" "$1" <<'PY'
import sys

import modal

app, name, wanted = sys.argv[1:]
# modal.com/docs/reference/modal.Function, Function.autoscaler (modal 1.6; update_autoscaler() is
# deprecated since 2026-10-16): update() overrides the deployed function's autoscaler until the
# next deploy, which resets it to the decorator's (no min_containers, so 0).
fn = modal.Function.from_name(app, name)
now = fn.autoscaler.update(min_containers=int(wanted)) if wanted else fn.autoscaler.settings()
# An unset minimum (None) is 0.
print(f"{app}/{name}: min_containers={now.min_containers or 0}, scaledown_window={now.scaledown_window} s")
PY
}

open_demo_prs() {
  gh pr list -R "$REPO" --state open --limit 100 --json number,headRefName,url \
    --jq '.[] | select(.headRefName | startswith("demo/")) | "  #\(.number) \(.headRefName) \(.url)"'
}

# Waits for the latest Intenzo check run on the PR's head commit to complete: for a fresh demo PR,
# its first run, which explores each criterion and saves the path it finds.
seed() {
  local pr=$1 sha latest deadline
  sha=$(gh api "repos/$REPO/pulls/$pr" --jq .head.sha)
  deadline=$(($(date +%s) + 900))
  echo "waiting for #$pr's Intenzo run on ${sha:0:7}…"
  while :; do
    latest=$(gh api "repos/$REPO/commits/$sha/check-runs?check_name=Intenzo&filter=all" \
      --jq '.check_runs | max_by(.started_at) | "\(.status)|\(.conclusion)|\(.output.title)"')
    case "$latest" in
      completed*) break ;;
    esac
    if [ "$(date +%s)" -gt "$deadline" ]; then
      echo "no finished run on #$pr after 15 min (latest: $latest)" >&2
      exit 1
    fi
    sleep 15
  done
  IFS='|' read -r _ conclusion title <<<"$latest"
  echo "seeded: $title ($conclusion)"
  echo "Its next run replays the cached paths. Start the take by closing and reopening it:"
  echo "  gh pr close $pr -R $REPO && gh pr reopen $pr -R $REPO"
  echo "Afterwards: scripts/demo/prewarm.sh off"
}

case "${1:-}" in
  off)
    autoscale 0
    ;;
  status)
    autoscale ""
    echo "open demo PRs:"
    open_demo_prs
    ;;
  '' | -*)
    echo "$usage" >&2
    exit 2
    ;;
  *)
    pr=$1
    autoscale 1
    echo "A warm worker costs about \$0.76 an hour until scripts/demo/prewarm.sh off."
    seed "$pr"
    ;;
esac
