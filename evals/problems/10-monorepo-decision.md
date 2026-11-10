---
id: monorepo-decision
title: Monorepo or not for 30 engineers and 12 repositories
domain: organisation-and-tooling
constraints:
  - "30 engineers in five teams; 12 repositories in TypeScript and Go, with three shared libraries published as internal packages."
  - "The main pain today is shared-library changes that take days to propagate and break consumers late."
  - "CI minutes are already a budget line that finance watches; a migration may not stop feature work for more than a sprint in total."
  - "Teams own their deploy schedules and want to keep them."
successCriteria:
  - "A recommendation (monorepo, stay multi-repo with fixes, or a middle path) with the deciding reasons."
  - "How the recommendation fixes the shared-library propagation problem specifically."
  - "A migration or change plan that costs at most one sprint of stopped feature work in total, with what happens to deploy ownership."
  - "The risks and costs of the recommendation stated honestly, including CI cost."
rubric:
  - id: recommendation
    weight: 3
    criterion: Makes a clear recommendation and names the two or three reasons that decided it for this company.
    scale: "0 = 'it depends'; 1 = a recommendation with generic reasons; 2 = a recommendation with reasons tied to the stated situation; 3 = plus the condition under which the other option would win."
  - id: propagation
    weight: 3
    criterion: Shows how shared-library changes reach consumers faster and break them earlier under the recommendation.
    scale: "0 = the stated pain is not addressed; 1 = 'a monorepo fixes it' with no mechanism; 2 = a mechanism (atomic changes with affected-consumer CI, or versioning plus automated bumps and canary consumers); 3 = plus what still breaks and how it is caught."
  - id: migration
    weight: 2
    criterion: Plans the change within one sprint of stopped feature work, in increments, keeping team-owned deploys.
    scale: "0 = no plan or a stop-everything migration; 1 = a plan with no effort or ownership story; 2 = incremental plan within the budget with deploy ownership addressed; 3 = plus the order of repositories and the first one that proves the approach."
  - id: ci-cost
    weight: 2
    criterion: Addresses CI minutes concretely (affected-only builds, caching, remote execution) and estimates the direction of cost.
    scale: "0 = CI cost ignored; 1 = 'use caching'; 2 = specific techniques with the expected effect on minutes; 3 = plus the tooling investment they require and its risk."
  - id: honesty
    weight: 2
    criterion: States the costs and risks of its own recommendation, not only of the alternative.
    scale: "0 = one-sided; 1 = token risks; 2 = real risks of the chosen path; 3 = risks with mitigations and the one the author worries about most."
  - id: correctness
    weight: 2
    criterion: Claims about monorepo tooling, CI and package versioning hold up, and the parts fit together.
    scale: "0 = material errors; 1 = one questionable claim; 2 = sound; 3 = sound and precise about limits and about what it does and does not guarantee."
---
A software company with 30 engineers in five teams maintains 12 repositories in TypeScript and Go, including three shared libraries published as internal packages. Changes to a shared library take days to reach every consumer and tend to break them late, after the library version has been bumped. Finance watches the CI-minutes bill. A migration may not stop feature work for more than one sprint in total, and teams want to keep owning their own deploy schedules.

Recommend whether the company should move to a monorepo, stay multi-repo and fix the propagation problem another way, or take a middle path. Explain how your recommendation fixes the shared-library problem specifically, plan the change within the one-sprint limit while keeping team-owned deploys, address CI cost concretely, and state the risks and costs of your own recommendation.
