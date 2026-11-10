---
id: mobile-release-cadence
title: Release cadence for a store-reviewed mobile app
domain: engineering-process
constraints:
  - "Six engineers, one of them also the de-facto release manager; no dedicated QA."
  - "Every release goes through app-store review, which takes one to three days and sometimes rejects the build."
  - "A hotfix takes about two days to reach users, so a bad release hurts for at least that long."
  - "The team cannot hire or add a platform team this year."
successCriteria:
  - "A release cadence the team can keep without heroics, with the reasoning for its length."
  - "A hotfix path that is faster than today's two days or makes hotfixes rarer, and says which."
  - "A clear rule for when a change ships behind a feature flag and when it does not."
  - "Something measurable the team can look at in three months to know whether it worked."
rubric:
  - id: cadence
    weight: 3
    criterion: Proposes a specific release cadence and justifies it against store review time and team size.
    scale: "0 = no cadence or an unjustified one; 1 = a cadence with a vague reason; 2 = a cadence argued from review time or team size; 3 = a cadence argued from both, with the trade-off stated."
  - id: hotfix
    weight: 3
    criterion: Gives a hotfix path that is faster or needed less often, and explains the mechanism.
    scale: "0 = hotfixes not addressed; 1 = 'use feature flags' with no mechanism; 2 = a concrete mechanism (staged rollout, server-side kill switch, expedited review) with its effect; 3 = a mechanism plus what it does not cover."
  - id: flags
    weight: 2
    criterion: States a rule for what ships behind a feature flag and how flags are retired.
    scale: "0 = flags not mentioned; 1 = 'flag risky things'; 2 = a rule with examples; 3 = a rule, examples, and a retirement discipline."
  - id: constraints
    weight: 2
    criterion: Respects six engineers, no QA, no new hires; does not assume tooling or people the team lacks.
    scale: "0 = relies on a QA team or new hires; 1 = mostly respects them with one slip; 2 = respects them; 3 = respects them and turns a constraint into part of the design."
  - id: measurement
    weight: 2
    criterion: Names what to measure in three months and what result would count as success or failure.
    scale: "0 = nothing measurable; 1 = a metric with no target; 2 = metrics with targets; 3 = metrics with targets and what to do if they are missed."
  - id: correctness
    weight: 2
    criterion: Claims about app-store review, staged rollouts and feature flags hold up, and the parts fit together.
    scale: "0 = material errors; 1 = one questionable claim; 2 = sound; 3 = sound and precise about limits and about what it does and does not guarantee."
---
A six-person team builds a consumer mobile app for iOS and Android. Each release must pass app-store review, which takes one to three days and occasionally rejects the build for reasons unrelated to the change. Today the team ships "when things are ready", roughly every three to five weeks, and about one release in four is followed by a hotfix that takes two days to reach users because of the review queue. The founders want releases to feel routine rather than stressful, and they want users to stop seeing bugs that a staged rollout would have caught.

Design the team's release process: how often it releases and why, how a hotfix reaches users faster or is needed less often, when a change goes behind a feature flag, and how the team will know in three months whether the new process works.
