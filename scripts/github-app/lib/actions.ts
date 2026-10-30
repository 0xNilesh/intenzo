/**
 * The §26.2 requested actions, all three at once for the T0.4 check (a real run offers at most two:
 * Approve + Re-run on pass, Send to agent + Re-run on fail). GitHub's check-runs API allows at most
 * 3 actions, with label ≤ 20, description ≤ 40 and identifier ≤ 20 characters.
 */
export const REQUESTED_ACTIONS = [
  {
    label: "Approve (PM)",
    description: "Record product approval for this PR",
    identifier: "approve",
  },
  { label: "Send to agent", description: "Ask the fixer agent to fix this", identifier: "fix" },
  { label: "Re-run", description: "Verify this PR again", identifier: "rerun" },
];
