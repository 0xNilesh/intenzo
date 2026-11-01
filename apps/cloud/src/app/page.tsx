// The landing page (ROADMAP T7.3): what Intenzo is, how it works, and what IntentBench measured,
// in one static page at the Cloud's root. Each run's report is at /r/[runId] (§26).

const REPO = "https://github.com/0xNilesh/intenzo";

const steps: [string, string][] = [
  [
    "Reads the intent",
    "The ticket's text and the PM's narrated screen recording become acceptance criteria (Voice Transcribe, Spark 1.3).",
  ],
  [
    "Finds each trigger",
    "Wonder explores the PR's preview from an accessibility outline; the path is cached for later runs.",
  ],
  [
    "Records it twice",
    "On the PR's preview and on its base, each time as a brand-new user, with exact readings, a judge video and an annotated still.",
  ],
  [
    "Judges with two models",
    "Spark Open and Spark 1.3 see the same video. A pass or fail stands only when both agree and cite the readings; anything unclear is inconclusive.",
  ],
  [
    "Reports on the PR",
    "A verdict per criterion, a GIF of each failure (SAM 3.1 outlines a chart's slice), unrequested changes, and a button that hands a failure to a coding agent.",
  ],
];

// bench/results/judge-heldout.json via bench/analysis (README, IntentBench).
const arms: [string, string, string, string, string][] = [
  ["A", "the ticket and the diff only", "100%", "33% of failing criteria", "$0.017"],
  ["B", "the recording's readings", "87%", "0%", "$0.017"],
  ["C", "readings + 8 stills", "96%", "0%", "$0.035"],
  ["D", "readings + the video, two judges (Intenzo)", "98%", "0%", "$0.040"],
];

const cell = {
  borderBottom: "1px solid #ddd",
  padding: "0.4rem 0.6rem",
  textAlign: "left" as const,
};

export default function Home() {
  return (
    <main style={{ maxWidth: 820, lineHeight: 1.5 }}>
      <h1 style={{ fontSize: "2.4rem", marginBottom: 0 }}>Intenzo</h1>
      <p style={{ fontSize: "1.3rem", marginTop: "0.4rem" }}>
        <strong>
          Proof your PR did what the ticket asked, on video, before a human opens the diff.
        </strong>
      </p>
      <p>
        Coding agents open pull requests that are usually <em>almost</em> right: they compile, their
        tests pass, and the total still only updates after a reload. Intenzo runs each pull
        request&apos;s preview in a real browser, records every acceptance criterion from its
        ticket, has Meta&apos;s video models judge the recording, and posts the verdicts and the
        evidence on the pull request.
      </p>

      <h2>How it works</h2>
      <ol>
        {steps.map(([title, text]) => (
          <li key={title} style={{ marginBottom: "0.5rem" }}>
            <strong>{title}.</strong> {text}
          </li>
        ))}
      </ol>

      <h2>What watching the app buys</h2>
      <p>
        IntentBench: 12 demo-shop branches implement 4 tickets correctly, almost right, with a side
        effect, or broken, and every criterion has a proven label. Held out, 8 cases, 2 repeats:
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.95rem" }}>
        <thead>
          <tr>
            {["Arm", "Sees", "Right (judgeable)", "Wrong passes", "Cost / PR"].map((h) => (
              <th key={h} style={cell}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {arms.map((row) => (
            <tr key={row[0]}>
              {row.map((v, i) => (
                <td key={i} style={cell}>
                  {v}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Reading the diff spots planted defects, but it passed a build whose cart throws on every
        load in 4 of 6 judgements; every arm that ran the app stayed inconclusive there. No arm
        failed a criterion that holds. Small n: one demo app, seeded by hand.
      </p>

      <h2>Meta models</h2>
      <p>
        Voice Transcribe and Spark 1.3 read the ticket; Wonder finds the triggers; Spark Open (open
        weights, on Baseten) and Spark 1.3 judge; SAM 3.1 outlines visual evidence; Muse Code writes
        the fix.
      </p>

      <h2>Read more</h2>
      <ul>
        <li>
          <a href={REPO}>The code, the architecture and every measured decision</a>
        </li>
        <li>
          <a href={`${REPO}/blob/main/docs/hooks.md`}>The session hook your app adds</a>
        </li>
        <li>
          <a href="https://github.com/sumithprabhu/demo-shop">
            demo-shop, the app it verifies in the demo
          </a>
        </li>
      </ul>

      <p style={{ color: "#666", fontSize: "0.9rem", marginTop: "2.5rem" }}>
        Built for the Meta Global AI Developer Hackathon by Nilesh Gupta and Sumith Prabhu. Apache
        License 2.0.
      </p>
    </main>
  );
}
