# intenzo-t04-sandbox

Throwaway repository for the T0.4 platform checks of [Intenzo](https://github.com/0xNilesh/intenzo)
(ROADMAP T0.4, DECISIONS 2026-10-30). Safe to delete.

- `index.html` gives Vercel something to deploy, so GitHub sends `deployment_status` events.
- `.github/workflows/comment-trigger.yml` shows whether a comment posted with the Intenzo App's
  installation token starts an `issue_comment` workflow, and whether the muse-fixer guard
  (ARCHITECTURE §26.4) matches the App's bot login.
