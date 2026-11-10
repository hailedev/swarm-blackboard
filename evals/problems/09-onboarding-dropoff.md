---
id: onboarding-dropoff
title: Why 40 % of sign-ups never finish setup, and what to test first
domain: product-analysis
constraints:
  - "A B2B SaaS for small teams; setup has five steps (account, workspace name, invite teammates, connect a data source, first dashboard)."
  - "About 1,200 sign-ups a month; 40 % never complete setup; the team has funnel analytics per step but no session recordings or user interviews yet."
  - "Two engineers and one designer can spend four weeks; each experiment needs at least two weeks to reach a readable sample at current traffic."
  - "Nothing may be removed from the product; steps may be reordered, deferred or made optional."
successCriteria:
  - "Plausible causes of the drop-off ranked by likelihood, with the evidence that would confirm or rule out each."
  - "A two-week diagnostic plan using the data and research the team can gather quickly."
  - "Two experiments for the following two weeks with hypotheses, variants, primary metric and the sample needed."
  - "How to decide what to ship at the end of the four weeks."
rubric:
  - id: causes
    weight: 3
    criterion: Lists plausible causes mapped to specific setup steps, ranked, each with the evidence that would confirm or rule it out.
    scale: "0 = generic causes; 1 = causes tied to steps but unranked; 2 = ranked with confirming evidence; 3 = ranked with confirming and disconfirming evidence, drawing on the funnel data described."
  - id: diagnosis
    weight: 2
    criterion: Proposes a two-week diagnostic (per-step drop-off, time-in-step, five-to-eight user interviews, session recordings) that fits the team.
    scale: "0 = jumps to solutions; 1 = 'talk to users'; 2 = a concrete two-week plan with outputs; 3 = plan with the decision it feeds."
  - id: experiments
    weight: 3
    criterion: Specifies two experiments with hypothesis, variant, primary metric and a sample-size reasoning consistent with 1,200 sign-ups a month.
    scale: "0 = no experiments; 1 = ideas without metrics; 2 = hypothesis, variant and metric for each; 3 = plus a sample or power argument consistent with the traffic and the two-week minimum."
  - id: constraints
    weight: 2
    criterion: Removes nothing; reorders, defers or makes steps optional instead; respects two engineers and a designer for four weeks.
    scale: "0 = removes a step or ignores effort; 1 = respects the rules with no effort estimate; 2 = respects the rules with rough effort; 3 = plus what is explicitly out of scope."
  - id: decision
    weight: 1
    criterion: States how the team decides what to ship at week four, including what to do with an inconclusive result.
    scale: "0 = none; 1 = 'ship the winner'; 2 = a decision rule with thresholds; 3 = plus the inconclusive case."
---
A B2B SaaS product for small teams has a five-step setup: create an account, name the workspace, invite teammates, connect a data source, build a first dashboard. About 1,200 teams sign up each month and 40 % never finish setup. The team has per-step funnel numbers but no session recordings or interviews. Two engineers and a designer have four weeks; with current traffic an experiment needs at least two weeks to read. Nothing may be removed from setup, but steps may be reordered, deferred or made optional.

Analyse the drop-off: the most likely causes by step, ranked, with the evidence that would confirm or rule each out; a two-week diagnostic plan; two experiments for the following two weeks with hypotheses, variants, primary metrics and the sample each needs; and how the team decides what to ship at the end of the four weeks, including when results are inconclusive.
