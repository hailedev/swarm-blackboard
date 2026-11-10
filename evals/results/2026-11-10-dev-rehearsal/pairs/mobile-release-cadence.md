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

_Run `01a1c397-7eaf-794c-ab9c-04b0ebdf9e9a`, 12 rounds, completed/budget_rounds, $0.0000, confidence 0.85._

To make releases feel routine and reduce the stress associated with hotfixes, the team should adopt a **Bi-Weekly Release Cadence** combined with a rigorous **Staged Rollout** protocol. The two-week rhythm is sustainable for a six-person team without dedicated QA, providing enough time for peer review and internal testing while keeping the window of exposure small. This cadence addresses the founders' desire to stop 'heroics' by establishing a predictable pattern that fits within the constraints of the App Store review queue.

The core mechanism for reducing visible bugs is the **Staged Rollout**. New features and UI changes must be released to only 10-20% of users initially, allowing the team to monitor crash-free rates (target >99.5%) before full distribution. This leverages iOS/Android analytics to catch regressions early, turning potential hotfix situations into manageable scheduled fixes. Evidence E24 and E28 confirm that staged rollouts automatically pause distribution upon detecting high crash rates, effectively shielding the majority of users from visible bugs.

For the **Feature Flag Rule**, we must distinguish between backend-configurable features and UI/data changes. Any change affecting user-facing UI or data persistence MUST be behind a feature flag until it has survived a two-week stability period on internal tracks (e.g., TestFlight). However, as noted in E19 and H19, these flags are not instant 'kill switches' for deployed UI bugs; they mitigate risk during the staging phase. Critical security patches that bypass flags require immediate shadow releases via internal tracks where available, though iOS constraints mean even these need review.

Success will be measured over three months using three objective metrics: **Crash-Free User Rate** (target >99.5%), **Staged Rollout Halt Rate** (frequency of bugs caught during staging), and **Hotfix Frequency** (aiming for a 50% reduction). These metrics replace subjective stress scores with verifiable data on user impact. By focusing on 'fatal' bugs that cause the majority of user impact (per E29), we ensure that the team is optimizing for stability rather than just bug counts.

Key open questions remain regarding the specific implementation of the Pre-release Checklist to reduce superficial App Store rejections (H18) and whether the 'Release Candidate freeze' timeline (H17) is sufficient given the 1-3 day review variability. These process details should be refined in the next iteration once the primary cadence and staging protocols are operational.

## Baseline answer

_qwen3.6:35b-mlx, 4096 output tokens allowed under a $0.0000 cap, cost $0.0000._

# Release Process Design: The 

## Judgements

Swarm 73.6%, baseline 0.0%, winner swarm.

### Order 1: A = baseline, B = swarm; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 2 — Proposes a bi-weekly cadence justified by the six-person team size and peer review needs, but lacks a detailed trade-off analysis against store review variability. | 0 — The answer is empty and provides no release cadence or justification. |
| hotfix | 3 | 3 — Explains that staged rollouts make hotfixes rarer by catching bugs early, noting this mitigates risk during staging rather than speeding up the deployment of a post-release fix. | 0 — The answer is empty and does not address the hotfix process. |
| flags | 2 | 2 — States a rule for backend/UI changes but fails to explain how flags are retired after promotion to stable releases. | 0 — The answer is empty and does not mention feature flags. |
| constraints | 2 | 2 — Respects the six-engineer/no-QA constraint by relying on peer review and automated analytics, though it references external evidence codes oddly. | 0 — The answer is empty and fails to respect constraints or provide a design. |
| measurement | 2 | 3 — Names specific metrics (Crash-Free Rate, Halt Rate) with targets and implies tracking hotfix frequency to measure success over three months. | 0 — The answer is empty and provides no measurable success criteria. |

> Answer A is completely empty. Answer B provides a complete design that addresses all criteria according to the rubric, despite some minor imperfections in flag retirement and constraint adherence details.

### Order 2: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| cadence | 3 | 2 — The answer proposes a specific bi-weekly cadence but justifies it primarily by the team's size and the need for predictability, rather than explicitly connecting the duration to the app store review times as required. | 0 — The answer is truncated and provides no content regarding release cadence or any other criterion. |
| hotfix | 3 | 2 — It offers a concrete mechanism (staged rollout) with a specific effect (auto-pause on high crash rates), but fails to mention what it does not cover (e.g., backend logic changes). | 0 — The answer is truncated and provides no content regarding hotfix mechanisms. |
| flags | 2 | 1 — It states a rule for using flags (for UI/data changes) but lacks specific examples and completely omits a retirement discipline for the flags. | 0 — The answer is truncated and provides no content regarding feature flag rules. |
| constraints | 2 | 3 — The answer explicitly respects the six-engineer/no-QA constraints by relying on peer review and internal testing tracks available to the existing team. | 0 — The answer is truncated and provides no content demonstrating respect for constraints. |
| measurement | 2 | 2 — It names measurable metrics with clear targets (e.g., >99.5% crash-free rate) but does not specify actions to take if these targets are missed within the three-month window. | 0 — The answer is truncated and provides no content regarding measurement strategies. |

> Answer A is significantly better as it provides a complete, structured response addressing all rubric criteria, whereas Answer B is empty/truncated.
