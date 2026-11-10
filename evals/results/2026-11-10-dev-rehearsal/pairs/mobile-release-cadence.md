# Release cadence for a store-reviewed mobile app

Chosen as the baseline's widest win. Problem `mobile-release-cadence`.

## Problem

A six-person team builds a consumer mobile app for iOS and Android. Each release must pass app-store review, which takes one to three days and occasionally rejects the build for reasons unrelated to the change. Today the team ships "when things are ready", roughly every three to five weeks, and about one release in four is followed by a hotfix that takes two days to reach users because of the review queue. The founders want releases to feel routine rather than stressful, and they want users to stop seeing bugs that a staged rollout would have caught.

Design the team's release process: how often it releases and why, how a hotfix reaches users faster or is needed less often, when a change goes behind a feature flag, and how the team will know in three months whether the new process works.

### Constraints

- Six engineers, one of them also the de-facto release manager; no dedicated QA.
- Every release goes through app-store review, which takes one to three days and sometimes rejects the build.
- A hotfix takes about two days to reach users, so a bad release hurts for at least that long.
- The team cannot hire or add a platform team this year.

### Success criteria

- A release cadence the team can keep without heroics, with the reasoning for its length.
- A hotfix path that is faster than today's two days or makes hotfixes rarer, and says which.
- A clear rule for when a change ships behind a feature flag and when it does not.
- Something measurable the team can look at in three months to know whether it worked.

## Swarm answer

_Run `01a1c3a3-3329-7707-9468-42786eae2c39`, 8 rounds, completed/completed, $0.0000, confidence 0.85._

To meet the founders' goals of reducing stress and bug exposure, adopt a Bi-Weekly Release Cadence (H16) combined with a strict 'Code-Complete or Flag' policy (H18). Shipping every two weeks balances the review latency risks of weekly releases with the batch-size risks of monthly ones, keeping changes small enough for a six-person team without dedicated QA to manage manually. By restricting store submissions to stable code and moving all non-trivial UI/logic changes behind server-side feature flags (H8), the team ensures that no risky or incomplete functionality reaches users, effectively eliminating the need for store-based hotfixes for functional bugs.

Hotfixes should be treated as exceptional events reserved only for critical security vulnerabilities or crashes that cannot be mitigated via flags. For these rare cases, leverage the App Store and Google Play 'Priority Review' processes (H17) which can expedite approvals to under 24 hours, avoiding the standard two-day queue. To further reduce store submission failures unrelated to code, implement a 'Release Health Checklist' (H15) focused on automated metadata and SDK compliance checks, ensuring that rejections are driven by code quality rather than administrative errors.

Success in three months will be measured by tracking 'Release Success Rate' (percentage of submissions accepted on the first pass) and 'Hotfix Trigger Frequency'. A successful process is indicated by a high first-pass acceptance rate (indicating the checklist works) and a near-zero hotfix frequency for functional bugs (indicating feature flagging is effective). If hotfixes remain frequent, the flagging discipline needs reinforcement; if submissions are frequently rejected for non-code reasons, the compliance checklist needs tightening.

## Baseline answer

_qwen3.6:35b-mlx, 4096 output tokens allowed under a $0.0000 cap, cost $0.0000._

Adopt a weekly release cadence with mandatory staged rollouts, shifting the burden from 'heroic' monthly shipping to routine, manageable weekly cycles. This frequency balances the team's ability to maintain code quality against the friction of app store reviews; shipping every week allows for small, digestible changes that are easier to review and debug than large monthly bundles, while avoiding the burnout risk of daily deployments given the 1-3 day review delay. The 'release manager' engineer facilitates a lightweight Friday planning check to ensure any code ready by Wednesday is bundled, ensuring the process remains predictable and stress-free.

Implement a mandatory staged rollout for all updates where any non-trivial change (UI, logic, or API interaction) ships behind a feature flag or percentage-based release. Since the team has no dedicated QA, automated unit tests and a 'feature flag toggle' are the primary safety nets. A change goes behind a feature flag if it introduces new logic paths, modifies existing user-facing behavior, or touches critical infrastructure; if it is purely cosmetic (e.g., color change) or backend-only with no UI impact, it may ship fully. This ensures that even if a bug slips through Apple's review, only 10-20% of users are affected initially, allowing the team to kill the release via feature flag or push a hotfix update while minimizing user-visible impact.

Reduce hotfix latency by decoupling hotfixes from the main app bundle when possible. For UI/content bugs, use backend configuration changes or remote config flags to disable features instantly without an App Store review, effectively making the 'hotfix' time zero for those cases. For code-level hotfixes that require a new build, maintain a streamlined, pre-approved CI/CD pipeline specifically for 'emergency' builds with priority support from the release manager and designated Apple Developer contacts who can expedite reviews if needed. While full app store review still takes 24-48 hours, this process is faster than the current ad-hoc approach because it is triggered immediately and prioritized, and the use of staged rollouts makes actual code hotfixes rarer by catching issues early in the smaller release window.

Measure success in three months by tracking two key metrics: (1) The 'Mean Time to Recovery' (MTTR) for production issues, targeting a reduction from 48 hours to under 24 hours (or near-instant via remote config), and (2) The rate of post-release hotfixes per release cycle, targeting a decrease from 25% to under 10%. If the team can ship weekly without burnout, maintain low hotfix rates due to staged rollouts catching bugs early, and recover faster from inevitable issues using flags/config, the process is working. Additionally, gather qualitative feedback from the team on stress levels; if releases feel 'routine' rather than 'crises,' the behavioral goal is met.

## Judgements

Swarm 73.6%, baseline 94.4%, winner baseline.

### Order 1: A = baseline, B = swarm; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 3 — Proposes a bi-weekly cadence justified by balancing review latency risks against batch-size risks for the small team size. | 3 — Proposes a weekly cadence justified by balancing code quality and burnout risks against the 1-3 day review window, acknowledging the trade-off of daily deployment friction. |
| hotfix | 3 | 1 — Relies primarily on 'Priority Review' which is an external policy rather than a process design, and fails to provide a concrete mechanism for speed other than hoping for faster approval, ignoring the constraint that review still takes time. | 3 — Describes a dual mechanism: reducing frequency via staged rollouts/feature flags and reducing latency via remote config/backend changes for non-code bugs, explicitly noting what doesn't cover code-level issues. |
| flags | 2 | 2 — States a rule ('Code-Complete or Flag') with examples (UI/logic vs server-side) but lacks explicit detail on flag retirement/discipline compared to A. | 3 — Provides a clear rule (new logic/UI vs cosmetic/backend) with examples and implies retirement through the 'kill' mechanism of staged rollouts/remote config. |
| constraints | 2 | 1 — Mostly respects constraints but introduces 'Priority Review' which is often not available or guaranteed for all builds, representing a slip in assuming external tooling/availability. | 2 — Respects the team size and lack of QA by relying on automated tests and flags, but assumes external 'Apple Developer contacts' for expedited review which is not a guarantee or internal resource. |
| measurement | 2 | 2 — Names metrics (success rate, hotfix frequency) and targets, but fails to specify what specific action will be taken if metrics are missed beyond general reinforcement. | 3 — Defines specific metrics (MTTR < 24 hours, hotfix rate < 10%) with targets and includes qualitative feedback on stress as a success criterion. |

> Answer A is better because it provides a more robust and realistic mechanism for handling hotfixes (staged rollouts + remote config) that actually addresses speed and frequency constraints effectively, whereas B relies heavily on external 'Priority Review' which is less reliable. A also has slightly stronger measurement criteria including the founder's goal of stress reduction.

### Order 2: A = swarm, B = baseline; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 3 — It proposes a specific bi-weekly cadence and justifies it by balancing review latency risks against batch-size risks for a small team. | 3 — It proposes a weekly cadence and justifies it by balancing code quality/maintenance against the friction of review delays for a small team. |
| hotfix | 3 | 2 — It suggests using Priority Review for faster hotfixes but does not explain how to make them rarer other than through flagging, which is covered elsewhere, lacking the 'what it does not cover' nuance of a score 3. | 3 — It details concrete mechanisms like remote config to make hotfixes instant/rarer and streamlined pipelines for faster reviews, while acknowledging the 24-48 hour limit for code changes. |
| flags | 2 | 2 — It states a rule (Code-Complete or Flag) and gives examples of what goes behind flags, but lacks specific details on how flags are retired. | 3 — It provides a clear rule with examples (UI/logic vs cosmetic), explains the mechanism (staged rollout), and implies retirement through 'kill' or replacement, though retirement discipline is slightly less explicit than A's 'Code-Complete' but covered by the staged nature. |
| constraints | 2 | 3 — It respects the constraints by using existing store mechanisms (Priority Review) and automated checks instead of hiring people. | 2 — It mostly respects constraints but relies on Apple Developer contacts for expedited review, which is an external dependency that might be unreliable or unavailable. |
| measurement | 2 | 3 — It names specific metrics (First-pass acceptance rate, Hotfix frequency) with targets and explicitly states actions to take if they are missed. | 3 — It names metrics (MTTR, Hotfix rate) with targets and includes qualitative feedback to address the 'stress' goal. |

> Answer B is better overall because it provides a more comprehensive solution to the hotfix problem by combining immediate remote config fixes (making them non-store-dependent) with streamlined pipelines, whereas Answer A relies heavily on store Priority Review which may not always work for all bugs. B's cadence justification is also slightly more robust regarding the 'stress' aspect.
