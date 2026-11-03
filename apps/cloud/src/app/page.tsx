// The landing page (ROADMAP T7.3, rebranded "Proof of intent"): what Intenzo is, the proof it posts
// on a real PR, how it works, and what IntentBench measured, in one static page at the Cloud's
// root. Each run's report is at /r/[runId] (§26).
import { Geist, Geist_Mono } from "next/font/google";

import styles from "./landing.module.css";
import { ProofVideo } from "./proof-video";

const sans = Geist({ subsets: ["latin"], variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" });

const REPO = "https://github.com/0xNilesh/intenzo";
const DEMO_PR = "https://github.com/sumithprabhu/demo-shop/pull/17";
const HOOK_DOC = `${REPO}/blob/main/docs/hooks.md`;
const DEMO_SHOP = "https://github.com/sumithprabhu/demo-shop";

// demo-shop #17, the almost-right code: the comment Intenzo posted (criteria shortened).
const verdicts: { id: string; text: string; met: boolean }[] = [
  {
    id: "C1",
    text: "Applying SAVE10 drops the total from $50.00 to $45.00 without a refresh",
    met: false,
  },
  { id: "C2", text: "The discount shows as its own line, SAVE10 −$5.00", met: true },
  { id: "C3", text: "An expired code, OLD5, shows “This code has expired”", met: true },
  { id: "C4", text: "The savings chart shows the discount slice", met: true },
];

// The order total's readings in that recording (P1 ground truth).
const readings: { at: string; value: string; stale: boolean }[] = [
  { at: "+0 s", value: "$50.00", stale: true },
  { at: "+1 s", value: "$50.00", stale: true },
  { at: "+3 s", value: "$50.00", stale: true },
  { at: "after reload", value: "$45.00", stale: false },
];

const checks: { name: string; proves: string; catches: string; yes: boolean }[] = [
  { name: "Type-check", proves: "The types line up.", catches: "No", yes: false },
  {
    name: "Unit tests",
    proves: "Each function returns what its own test expects.",
    catches: "No",
    yes: false,
  },
  {
    name: "Code review",
    proves: "The diff reads well to a person with ten other PRs waiting.",
    catches: "Only if someone spots a missing memo dependency",
    yes: false,
  },
  {
    name: "Intenzo",
    proves: "The feature does what the ticket asked, on the live preview.",
    catches: "Yes: $50.00 at +1 s, on video",
    yes: true,
  },
];

const steps: { title: string; body: string; models: string }[] = [
  {
    title: "Read the intent",
    body: "The ticket's text, its checklist and the PM's narrated screen recording become acceptance criteria: what to do, what to watch, what must be true.",
    models: "Voice Transcribe, Spark 1.3",
  },
  {
    title: "Find the trigger",
    body: "The navigator explores the PR's preview from its accessibility tree, the way a user would. The path it finds is saved and replayed on later runs.",
    models: "Wonder",
  },
  {
    title: "Record it twice",
    body: "On the PR's preview and on its base, each time as a brand-new user, with exact readings at +0, +1 and +3 s, and after a reload.",
    models: "Playwright and Chromium",
  },
  {
    title: "Judge with two models",
    body: "Both see the same video and readings. A verdict stands only when both agree and cite the readings; anything else is reported as unclear.",
    models: "Spark Open, Spark 1.3",
  },
  {
    title: "Report, fix, approve",
    body: "Verdicts and proof land on the PR. One button hands a miss to a coding agent; the PM approves when every intent is met.",
    models: "SAM 3.1, Muse Code",
  },
];

// bench/results/judge-heldout.json via bench/analysis (README, IntentBench).
const arms: { arm: string; sees: string; right: number; wrongPasses: string; intenzo?: boolean }[] =
  [
    { arm: "A", sees: "The ticket and the diff", right: 100, wrongPasses: "4 of 12" },
    { arm: "B", sees: "The recording's readings", right: 87, wrongPasses: "0" },
    { arm: "C", sees: "Readings and 8 stills", right: 96, wrongPasses: "0" },
    {
      arm: "D",
      sees: "Readings and the video, two judges",
      right: 98,
      wrongPasses: "0",
      intenzo: true,
    },
  ];

const models: { name: string; role: string }[] = [
  { name: "Voice Transcribe", role: "Hears the PM's narration in the ticket's recording." },
  { name: "Spark 1.3", role: "Turns the ticket into criteria, and judges the recording." },
  { name: "Wonder", role: "Navigates the preview to each criterion's trigger." },
  { name: "Spark Open", role: "The second judge: open weights, served on Baseten." },
  { name: "SAM 3.1", role: "Outlines visual proof, like a chart's discount slice." },
  { name: "Muse Code", role: "Writes the fix when you send a miss to the agent." },
];

const faqs: { q: string; a: string }[] = [
  {
    q: "Does it replace code review?",
    a: "No. Review reads the code; Intenzo checks the behaviour the ticket asked for. Reviewers start from a PR whose intent is already proven or disproven, with the recording to look at.",
  },
  {
    q: "What kind of apps does it check?",
    a: "Web apps with a preview deployment per pull request, such as Vercel previews. It checks what a user can see and do in the browser; a criterion about an API or a background job is reported as not verifiable.",
  },
  {
    q: "Where does the intent come from?",
    a: "From the tickets a PR links in its description. A ticket can be plain text, a checklist of acceptance criteria, or a narrated screen recording. Criteria the PR adds itself are shown as unverified, and only the tickets count toward approval.",
  },
  {
    q: "What happens when the judges disagree?",
    a: "The criterion is reported as unclear, never guessed. A miss is recorded once more before it's reported, so a flaky moment doesn't fail a PR.",
  },
  {
    q: "What does a check cost?",
    a: "About $0.07–0.21 and one to three minutes per PR in our runs, at list prices. Replaying a saved path is cheaper than finding it the first time.",
  },
  {
    q: "Does it need access to production?",
    a: "No, and it refuses it. It only drives previews, signs in each run as a throwaway user through a small session hook your app adds, and never clicks what your config forbids.",
  },
];

function Mark({ size = 28 }: { size?: number }) {
  return (
    <svg className={styles.mark} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle
        cx="16"
        cy="16"
        r="8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        opacity="0.35"
      />
      <circle cx="16" cy="16" r="4.5" fill="var(--intent)" />
    </svg>
  );
}

export default function Landing() {
  return (
    <div className={`${styles.page} ${sans.variable} ${mono.variable}`}>
      <a className={styles.skip} href="#main">
        Skip to content
      </a>
      <header className={styles.nav}>
        <a className={styles.brand} href="/">
          <Mark />
          <span>intenzo</span>
        </a>
        <nav aria-label="Main" className={styles.navLinks}>
          <a href="#how">How it works</a>
          <a href="#benchmark">Benchmark</a>
          <a href={REPO}>Docs</a>
        </nav>
        <a className={styles.navCta} href={DEMO_PR}>
          See a real PR
        </a>
      </header>

      <main id="main">
        <section className={styles.hero} aria-labelledby="hero-title">
          <p className={styles.pill}>
            <span className={styles.pillDot} aria-hidden="true" />
            Intent checks for AI-written pull requests
          </p>
          <h1 id="hero-title" className={styles.headline}>
            Proof of intent
            <span className={styles.rec} aria-hidden="true" />
          </h1>
          <p className={styles.subhead}>for every pull request.</p>
          <p className={styles.lede}>
            Intenzo opens each pull request&apos;s preview in a real browser, does exactly what its
            ticket asked, and posts the recording and a verdict on the PR, judged by two Meta models
            before anyone reads the diff.
          </p>
          <div className={styles.ctas}>
            <a className={styles.primary} href={DEMO_PR}>
              See a real PR
            </a>
            <a className={styles.secondary} href={REPO}>
              Read the code
            </a>
          </div>

          <figure
            className={styles.proof}
            aria-label="What Intenzo posted on demo-shop pull request 17"
          >
            <div className={styles.recording}>
              <div className={styles.chrome}>
                <span className={styles.dots} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.url}>
                  demo-shop-git-pr-discount-almost-right.vercel.app/cart
                </span>
                <span className={styles.recBadge}>
                  <span className={styles.recDot} aria-hidden="true" />
                  Recording
                </span>
              </div>
              <ProofVideo
                src="/proof/stale-total.mp4"
                poster="/proof/stale-total.jpg"
                label="Intenzo's recording: SAVE10 is applied and the discount line appears, but the total stays at $50.00"
              />
              <div className={styles.readings}>
                <p className={styles.readingsLabel}>Order total after Apply</p>
                <ol className={styles.readingsRow}>
                  {readings.map((r) => (
                    <li key={r.at} className={r.stale ? styles.stale : styles.fresh}>
                      <span className={styles.readingAt}>{r.at}</span>
                      <span className={styles.readingValue}>{r.value}</span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            <div className={styles.comment}>
              <div className={styles.commentHead}>
                <Mark size={22} />
                <div>
                  <p className={styles.commentWho}>intenzo-ai</p>
                  <p className={styles.commentTitle}>Intent check · #5 Discount codes</p>
                </div>
                <span className={styles.score}>3 of 4 met</span>
              </div>
              <ul className={styles.verdicts}>
                {verdicts.map((v) => (
                  <li key={v.id} className={v.met ? styles.met : styles.missed}>
                    <span className={styles.verdictChip}>{v.met ? "Met" : "Missed"}</span>
                    <span className={styles.verdictText}>
                      <b>{v.id}</b> {v.text}
                    </span>
                  </li>
                ))}
              </ul>
              <p className={styles.commentNote}>
                Total read $50.00 at +0, +1 and +3 s; $45.00 only after a reload. Both judges agree,
                confirmed on a second recording.
              </p>
              <div className={styles.commentActions}>
                <span className={styles.fakeButton}>Send to agent</span>
                <span className={styles.fakeLink}>Watch the proof</span>
              </div>
            </div>
          </figure>
        </section>

        <section className={styles.section} aria-labelledby="ci-title">
          <h2 id="ci-title" className={styles.h2}>
            Green CI isn&apos;t intent.
          </h2>
          <p className={styles.sectionLede}>
            Coding agents open PRs that are almost right: they compile, their tests pass, the diff
            reads well, and the total still only updates after a reload. Every check you run today
            agrees it&apos;s fine.
          </p>
          <div className={styles.tableWrap}>
            <table className={styles.compare}>
              <thead>
                <tr>
                  <th scope="col">Check</th>
                  <th scope="col">What it proves</th>
                  <th scope="col">Catches the stale $50.00 total?</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.name} className={c.yes ? styles.ours : undefined}>
                    <th scope="row">{c.name}</th>
                    <td>{c.proves}</td>
                    <td className={c.yes ? styles.yes : styles.no}>{c.catches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section id="how" className={styles.section} aria-labelledby="how-title">
          <h2 id="how-title" className={styles.h2}>
            How a PR gets its proof.
          </h2>
          <ol className={styles.steps}>
            {steps.map((s, i) => (
              <li key={s.title} className={styles.step}>
                <span className={styles.stepNo}>{i + 1}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
                <p className={styles.stepModels}>{s.models}</p>
              </li>
            ))}
          </ol>
        </section>

        <section id="benchmark" className={styles.section} aria-labelledby="bench-title">
          <h2 id="bench-title" className={styles.h2}>
            Does watching the app matter? We measured it.
          </h2>
          <p className={styles.sectionLede}>
            IntentBench: 12 branches of a demo shop implement 4 tickets correctly, almost right,
            with a side effect, or broken, and every criterion has a label a script proves. Each
            criterion was judged from four levels of evidence. Held-out split, 8 cases, 2 repeats.
          </p>
          <div className={styles.bench}>
            <div className={styles.benchHead} aria-hidden="true">
              <span>Evidence</span>
              <span>Right, on criteria that could be recorded</span>
              <span>Wrong passes</span>
            </div>
            {arms.map((a) => (
              <div
                key={a.arm}
                className={`${styles.benchRow} ${a.intenzo ? styles.benchOurs : ""}`}
              >
                <span className={styles.benchSees}>{a.sees}</span>
                <span className={styles.benchBar}>
                  <span className={styles.benchFill} style={{ width: `${a.right}%` }} />
                  <span className={styles.benchValue}>{a.right}%</span>
                </span>
                <span className={a.wrongPasses === "0" ? styles.benchZero : styles.benchBad}>
                  {a.wrongPasses}
                </span>
              </div>
            ))}
          </div>
          <p className={styles.callout}>
            Reading the diff spotted the planted bugs, and passed a build that crashes on every load
            4 times out of 6. Every level of evidence that ran the app reported it, and none failed
            a criterion that holds.
          </p>
          <p className={styles.footnote}>
            Small n: 8 held-out cases on one demo app, seeded by hand. The numbers show the shape of
            the trade-off, not a general accuracy.
          </p>
        </section>

        <section className={styles.dark} aria-labelledby="intent-title">
          <div className={styles.darkInner}>
            <h2 id="intent-title" className={styles.h2}>
              Intent lives in the ticket.
            </h2>
            <p className={styles.sectionLede}>
              The PM writes what should happen, as text, a checklist or a narrated recording. The PR
              says which tickets it delivers. Intenzo checks each one and keeps their verdicts
              apart.
            </p>
            <div className={styles.panes}>
              <div className={styles.pane}>
                <p className={styles.paneTitle}>Issue #5 · Discount codes</p>
                <pre>{`Customers can apply discount codes on the cart.

## Acceptance criteria
- [ ] SAVE10 drops the total 10% right away,
      without a refresh
- [ ] OLD5 shows "This code has expired"
- [ ] The savings chart shows the discount slice`}</pre>
              </div>
              <div className={styles.pane}>
                <p className={styles.paneTitle}>Pull request description</p>
                <pre>{`## Intent
Closes #5
Closes #7

## Test hints
- start: /cart
- data: valid discount code: SAVE10`}</pre>
              </div>
              <div className={styles.pane}>
                <p className={styles.paneTitle}>.intenzo.yml</p>
                <pre>{`version: 1
isolation:
  session_hook: /api/test/session
guardrails:
  deny_text: ["delete account"]
policy:
  approvers: ["pm-alice"]`}</pre>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section} aria-labelledby="models-title">
          <h2 id="models-title" className={styles.h2}>
            Six Meta models, one verdict.
          </h2>
          <ul className={styles.models}>
            {models.map((m) => (
              <li key={m.name}>
                <h3>{m.name}</h3>
                <p>{m.role}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.section} aria-labelledby="faq-title">
          <h2 id="faq-title" className={styles.h2}>
            Questions
          </h2>
          <div className={styles.faq}>
            {faqs.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className={styles.closing} aria-labelledby="closing-title">
          <h2 id="closing-title" className={styles.closingTitle}>
            Proof of intent, on your next PR
            <span className={styles.rec} aria-hidden="true" />
          </h2>
          <p className={styles.lede}>
            Link a ticket, open a pull request, and get the recording and a verdict per criterion
            before review starts.
          </p>
          <div className={styles.ctas}>
            <a className={styles.primary} href={DEMO_PR}>
              See a real PR
            </a>
            <a className={styles.secondary} href={HOOK_DOC}>
              Set up the session hook
            </a>
          </div>
        </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.brand}>
          <Mark size={22} />
          <span>intenzo</span>
        </div>
        <p>
          Built for the Meta Global AI Developer Hackathon by Nilesh Gupta and Sumith Prabhu. Apache
          License 2.0.
        </p>
        <nav aria-label="Footer" className={styles.footerLinks}>
          <a href={REPO}>Code</a>
          <a href={HOOK_DOC}>Session hook</a>
          <a href={DEMO_SHOP}>demo-shop</a>
        </nav>
      </footer>
    </div>
  );
}
