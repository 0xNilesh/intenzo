// Acts as the throwaway App on the sandbox repository, for the T0.4 platform checks:
//   pnpm github-app:sandbox whoami <owner/repo>
//   pnpm github-app:sandbox comment <owner/repo> <issue-or-pr-number> <body>
//   pnpm github-app:sandbox check-run <owner/repo> <head-sha> [--in-progress]
// Credentials come from .env.github-app (see create-app.ts); tokens are never printed.
import { dig } from "../probe/lib/json.ts";
import { appJwt, ensureOk, github, installationToken, loadApp } from "./lib/app.ts";
import { REQUESTED_ACTIONS } from "./lib/actions.ts";

const [command, repo, ...rest] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const inProgress = process.argv.includes("--in-progress");
if (!command || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) usage();
const app = loadApp();

switch (command) {
  case "whoami": {
    const jwt = appJwt(app.id, app.privateKey);
    const me = ensureOk(await github(jwt, "/app"), "reading the App");
    const inst = ensureOk(await github(jwt, `/repos/${repo}/installation`), "installation");
    console.log({
      slug: dig(me.body, "slug"),
      bot: `${String(dig(me.body, "slug"))}[bot]`,
      installation: dig(inst.body, "id"),
      permissions: dig(inst.body, "permissions"),
      events: dig(inst.body, "events"),
    });
    break;
  }
  case "comment": {
    const [issue, ...words] = rest;
    if (!issue || words.length === 0) usage();
    const token = await installationToken(app, repo);
    const res = ensureOk(
      await github(token, `/repos/${repo}/issues/${issue}/comments`, {
        json: { body: words.join(" ") },
      }),
      "posting the comment",
    );
    console.log({
      id: dig(res.body, "id"),
      url: dig(res.body, "html_url"),
      login: dig(res.body, "user", "login"),
      type: dig(res.body, "user", "type"),
      viaApp: dig(res.body, "performed_via_github_app", "slug"),
    });
    break;
  }
  case "check-run": {
    const [sha] = rest;
    if (!sha) usage();
    const token = await installationToken(app, repo);
    const state = inProgress
      ? { status: "in_progress" }
      : { status: "completed", conclusion: "neutral" };
    const res = ensureOk(
      await github(token, `/repos/${repo}/check-runs`, {
        json: {
          name: inProgress ? "Intenzo (in progress)" : "Intenzo",
          head_sha: sha,
          external_id: "t0.4-platform-check",
          ...state,
          output: {
            title: "T0.4 platform check",
            summary: "Requested actions test (ARCHITECTURE §26.2). Press a button below.",
          },
          actions: REQUESTED_ACTIONS,
        },
      }),
      "creating the check run",
    );
    console.log({ id: dig(res.body, "id"), url: dig(res.body, "html_url"), ...state });
    break;
  }
  default:
    usage();
}

function usage(): never {
  console.error(
    "Usage: github-app:sandbox whoami|comment|check-run <owner/repo> …  (see the header of sandbox.ts)",
  );
  process.exit(2);
}
