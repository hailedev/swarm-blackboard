# Release cadence for a store-reviewed mobile app

Chosen as the swarm's widest win. Problem `mobile-release-cadence`.

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

_Run `01a1c3d5-4ef6-7bc9-b88d-d13aa32b45a8`, 12 rounds, completed/budget_rounds, $0.0000, confidence 0.75._

The team should adopt a **Bi-Weekly Release Cadence** to replace the unpredictable 'when ready' schedule. This rhythm balances feature accumulation with the reality of the 1–3 day App Store review window, ensuring that development does not stall while waiting for approval (H5, E28, E21). By shipping every two weeks, the team avoids the large, risky diffs that characterize monthly releases and reduces the pressure on the six-person engineering staff to perform 'heroic' efforts during each release cycle.

To make hotfixes rarer and faster, the team must implement a **Pre-Release Validation** workflow rather than relying on post-release fixes. Since every release—including hotfixes—must pass App Store review (E26), we cannot bypass the queue for public users. Instead, we decouple validation from public availability by using iOS TestFlight and Google Play Internal Testing tracks to validate builds before they are submitted for production (H10, H16). This reduces the risk of hotfixes being needed in the first place by catching critical bugs during the internal review phase, which is often faster than the public queue (E27, E19). If a hotfix is still required, it follows the same rigorous internal validation path to ensure stability before re-entering the 1–3 day public review bottleneck.

For high-risk changes, the team should enforce a **Feature Flag Policy** where any code touching UI, network, or state management is shipped behind a disabled flag (H14). This leverages the existing peer-review process as a QA gate, preventing risky untested code from reaching end-users even if it slips through internal testing. This approach minimizes the maintenance overhead of complex flagging while providing a kill-switch for unexpected bugs, directly addressing the constraint of having no dedicated QA team (E29).

To determine if this process works in three months, track two key metrics: **Hotfix Frequency** (target <5% of releases) and **Review Turnaround Time** (target <24 hours for internal validation). A drop in hotfixes indicates that the pre-release validation is catching bugs early. A stable turnaround time indicates that the workflow has become routine rather than stressful. Additionally, monitor the **Review Rejection Rate**; a reduction here signals that the internal testing gates are effectively preventing metadata and compliance issues from reaching public view (E30).

Although critiques noted that TestFlight does not bypass iOS App Store review for public availability (C17), the strategy relies on using internal tracks to *validate* rather than *deploy*. Since the bi-weekly cadence provides a buffer against rejection (H5) and the feature flag policy provides a safety net (H14), this process remains sustainable even if hotfix reviews take 1–3 days, provided the validation phase is rigorous. The primary success factor is reducing the *need* for hotfixes through early detection, rather than accelerating the public distribution channel.

## Baseline answer

_qwen3.6:35b-mlx, asked for about 2600 words, used 318 of 4096 output tokens allowed under a $0.0000 cap, cost $0.0000. Board handles are shown here; the judge saw the answers with them removed._

Recommendation: The team should adopt a continuous delivery model with a two-week release cadence for full releases, supported by a feature-flag gating mechanism where all non-trivial changes ship immediately behind flags. This approach fundamentally shifts the team from 'shipping when ready' to 'shipping daily,' thereby decoupling code integration from user visibility. By flagging most features and bugs, the team can deploy to production environments instantly for internal validation without triggering app store reviews for every iteration. The actual App Store release becomes a scheduled event every two weeks, where only tested, un-flagged code is submitted. This reduces stress by normalizing deployment and mitigates hotfix risks by ensuring that 90% of changes are invisible to users until they are deemed safe.

The primary reason for adopting a two-week cadence is to balance stability with momentum while respecting the App Store review bottleneck. A weekly cadence may be too aggressive given the one-to-three-day review window and the risk of rejection, which could cause deployment collisions if multiple branches are in flight. However, waiting three to five weeks creates a 'batching' effect where too many changes accumulate, increasing the probability of integration conflicts and making regression testing exponentially harder. Two weeks is a standard agile sprint length that allows for sufficient development time while keeping the feedback loop short enough to catch major issues before they reach users. This cadence ensures that if a release fails, the next one is only two weeks away, preventing long periods of stagnation or buggy exposure.

## Judgements

Swarm 91.7%, baseline 44.0%, winner swarm.

### Order 1: A = baseline, B = swarm; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 3 — It proposes a bi-weekly cadence and justifies it against the review window and team size, explicitly stating the trade-off of avoiding large risky diffs. | 2 — It proposes a specific two-week cadence justified by balancing the review window and avoiding integration conflicts, but fails to explicitly state the trade-off regarding reduced feedback frequency compared to a weekly schedule. |
| hotfix | 3 | 3 — It provides a concrete mechanism (pre-release validation via TestFlight/Internal Tracks) that makes hotfixes rarer by catching bugs early, and acknowledges the limits regarding speed vs. internal validation. | 1 — It suggests making hotfixes rarer through continuous delivery but provides no concrete mechanism for faster resolution or specific technical implementation details beyond 'shifting to production environments' which is vague for mobile apps with store reviews. |
| flags | 2 | 2 — It states a rule with examples (UI, network, state management) but lacks a clear discipline for retiring flags once they are no longer needed. | 2 — It states a rule (non-trivial changes ship behind flags) but lacks specific examples of what constitutes non-trivial and provides no discipline for flag retirement. |
| constraints | 2 | 3 — It fully respects the constraints of six engineers, no QA, and store review times by leveraging existing peer-review processes and internal testing tracks. | 1 — It respects the team size but suggests deploying to 'production environments instantly' which implies backend-only capabilities or misrepresents mobile app store constraints, as iOS/Android apps cannot be updated instantly without store review. |
| measurement | 2 | 3 — It names specific metrics (Hotfix Frequency, Review Turnaround Time) with clear targets (<5%, <24 hours) and explains what success or failure looks like. | 0 — It fails to provide any measurable metrics or success criteria for the three-month evaluation. |
| correctness | 2 | 3 — It correctly identifies that mobile app store reviews cannot be bypassed for public users and proposes a realistic strategy of reducing hotfix *frequency* rather than justifying an impossible speed increase for the final store submission. | 1 — It makes questionable claims about mobile app store processes by implying changes can be deployed to production environments instantly without triggering reviews, which contradicts the stated constraints. |

> Answer B is better overall because it provides concrete, feasible mechanisms that respect the strict constraints of app store reviews and lack of QA, whereas Answer A proposes a process that ignores the technical reality of mobile app distribution and fails to define success metrics.

### Order 2: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 3 — Proposes a bi-weekly cadence and justifies it by balancing feature accumulation with the 1-3 day review window and avoiding heroic efforts. | 3 — Proposes a two-week cadence with a detailed justification regarding stability, momentum, and review bottlenecks. |
| hotfix | 3 | 2 — Provides a concrete mechanism (pre-release validation via TestFlight/Internal tracks) to make hotfixes rarer, acknowledging the store constraint. | 1 — Mentions flags to reduce hotfixes but lacks a concrete mechanism for faster fixes or retirement, failing to address the 'faster' aspect effectively for a store-bound app. |
| flags | 2 | 3 — States a clear rule (UI/network/state changes behind flags), gives examples, and explains how it acts as a QA gate/kill switch. | 2 — States a rule (non-trivial changes behind flags) and gives a general reason, but lacks specific examples of what constitutes 'non-trivial' or retirement discipline. |
| constraints | 2 | 2 — Respects the no-QA/no-hire constraints by leveraging existing engineers for peer review and internal validation tracks, though lacks explicit 'retirement' discipline for flags. | 1 — Contains a material error claiming flagged code can be deployed to production without triggering app store reviews for every iteration, which contradicts the iOS/Android constraint. |
| measurement | 2 | 3 — Names specific metrics (hotfix frequency, review turnaround) with targets (<5%, <24h) and explains what success/failure looks like. | 1 — Describes general benefits (reduced stress, mitigated risk) but fails to name specific measurable metrics or targets for three months. |
| correctness | 2 | 3 — Soundly addresses the store review constraint by distinguishing between validation (internal tracks) and distribution (public release), acknowledging limits. | 0 — Contains material errors by claiming that internal deployments for flagged code bypass app store reviews entirely in a way that allows immediate user visibility, which is technically inaccurate for mobile apps. |

> Answer A is significantly better because it respects the technical constraints of mobile app stores and provides actionable, measurable solutions. Answer B fails on correctness by proposing a CI/CD model that doesn't work for store-bound apps and fails on measurement.
