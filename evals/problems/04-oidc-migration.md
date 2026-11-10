---
id: oidc-migration
title: Moving a monolith from home-grown sessions to OIDC without downtime
domain: planning
constraints:
  - "One quarter, three engineers part-time alongside product work."
  - "About 40,000 active users with passwords stored as bcrypt hashes in the monolith's database; users must not be forced to reset passwords."
  - "The company has chosen a hosted identity provider that supports OIDC and can import or migrate credentials through a hook."
  - "No planned downtime and no \"big bang\" switch: a failed step must be reversible within an hour."
successCriteria:
  - "An ordered plan of steps across the quarter, each reversible, with what is true at the end of each."
  - "How existing users move without a forced password reset, and what happens to users who do not log in during the migration."
  - "How sessions behave during the transition when both systems are live."
  - "The point of no return, how it is reached safely, and what is cleaned up afterwards."
rubric:
  - id: sequencing
    weight: 3
    criterion: Gives an ordered sequence of steps, each with a reversal path, that ends with OIDC in control.
    scale: "0 = no sequence; 1 = steps with no reversal story; 2 = steps each reversible; 3 = steps each reversible, with the state after each and the order justified."
  - id: credentials
    weight: 3
    criterion: Explains how bcrypt users migrate without a forced reset, and handles users who never log in during the window.
    scale: "0 = not addressed or forces a reset; 1 = 'import the hashes' with no detail; 2 = a lazy migration at login (verify against the old hash, create in the IdP) with the dormant-user case; 3 = plus how the old hashes are retired and the security implications of the window."
  - id: dual-run
    weight: 2
    criterion: Describes how sessions, logout and token validation behave while both systems are live.
    scale: "0 = not addressed; 1 = 'run both'; 2 = a clear rule for which system a session belongs to and how logout works; 3 = plus the edge cases (session expiry mid-switch, API clients, admin accounts)."
  - id: constraints
    weight: 2
    criterion: Fits three part-time engineers in one quarter, no downtime, one-hour reversibility.
    scale: "0 = ignores the constraints; 1 = plausibly fits with no estimate; 2 = fits with rough effort per step; 3 = fits, with the step most likely to slip named and buffered."
  - id: cutover
    weight: 2
    criterion: Identifies the point of no return and what is decommissioned after it.
    scale: "0 = not addressed; 1 = 'turn off the old system'; 2 = a defined cutover with a criterion for reaching it; 3 = cutover criterion, monitoring for a week after, and the cleanup list."
---
A product company runs a monolith with its own login: usernames, bcrypt password hashes and server-side sessions, about 40,000 active users. It has bought a hosted identity provider that speaks OIDC and can migrate credentials through a hook at login time. Three engineers have one quarter, alongside their product work, to move authentication to the provider. There may be no planned downtime, no forced password reset, and no step that cannot be undone within an hour if it goes wrong.

Plan the migration: the ordered steps across the quarter and what is true after each, how existing users move over (including users who do not log in during the quarter), how sessions behave while both systems are live, and where the point of no return is and what gets cleaned up after it.
