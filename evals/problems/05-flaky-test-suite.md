---
id: flaky-test-suite
title: A six-week plan for a flaky, slow test suite
domain: engineering-management
constraints:
  - "About 400 tests across unit, integration and browser levels; roughly 8 % of CI runs fail on tests that pass when re-run."
  - "CI takes 45 minutes end to end; engineers re-run the whole pipeline when it fails."
  - "Eight engineers; the team can spend at most two engineer-weeks on this across six weeks, alongside feature work."
  - "Deleting tests is allowed only when a replacement covers the same behaviour or the behaviour no longer exists."
successCriteria:
  - "Measurable targets for flakiness and CI time at six weeks, with a baseline measurement plan for week one."
  - "A diagnosis approach that finds which tests are flaky and why, before fixing anything."
  - "A prioritised set of interventions with the engineer-time each costs."
  - "A rule that keeps the suite from decaying again after the six weeks."
rubric:
  - id: targets
    weight: 2
    criterion: Sets numeric targets for flake rate and CI time and says how the baseline is measured.
    scale: "0 = no targets; 1 = targets with no baseline; 2 = targets and a baseline method (per-test pass rates over N runs); 3 = plus an honest note on what two engineer-weeks can and cannot reach."
  - id: diagnosis
    weight: 3
    criterion: Describes how to identify the flaky tests and classify their causes before fixing.
    scale: "0 = jumps to fixes; 1 = 'find the flaky tests'; 2 = a method (re-run history, quarantine with tagging, cause categories such as timing, shared state, order dependence, external services); 3 = plus how the data is collected automatically."
  - id: interventions
    weight: 3
    criterion: Proposes prioritised interventions with effort estimates that fit two engineer-weeks.
    scale: "0 = a wish list; 1 = interventions with no priorities or effort; 2 = prioritised with effort, fitting the budget; 3 = prioritised by expected payoff per effort, with the ones deliberately left out."
  - id: ci-time
    weight: 2
    criterion: Addresses the 45-minute pipeline specifically (parallelism, retries scoped to a job, caching, test selection), not only flakiness.
    scale: "0 = CI time ignored; 1 = one generic suggestion; 2 = two or more specific levers with expected effect; 3 = levers with expected effect and the risk each introduces."
  - id: prevention
    weight: 2
    criterion: Gives a rule or mechanism that stops new flakiness from accumulating.
    scale: "0 = none; 1 = 'be careful'; 2 = a mechanism (quarantine policy with an owner and a deadline, flake budget, CI check on new tests); 3 = mechanism plus who enforces it and what happens when it is breached."
---
An eight-person team maintains a web product with about 400 automated tests: unit, integration and browser tests. CI takes 45 minutes, and roughly 8 % of runs fail on tests that pass when re-run, so engineers habitually re-run the whole pipeline and have stopped trusting a red build. The team can spend at most two engineer-weeks on this over the next six weeks while still shipping features. Tests may be deleted only if something else covers the behaviour or the behaviour is gone.

Write the six-week plan: what to measure in week one and what the targets are at week six, how to find out which tests are flaky and why before fixing anything, which interventions to make in what order and what each costs, how to bring CI time down, and what rule keeps the suite healthy afterwards.
