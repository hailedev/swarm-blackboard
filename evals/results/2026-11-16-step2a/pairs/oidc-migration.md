# Moving a monolith from home-grown sessions to OIDC without downtime

Chosen as the baseline's widest win. Problem `oidc-migration`.

## Problem

A product company runs a monolith with its own login: usernames, bcrypt password hashes and server-side sessions, about 40,000 active users. It has bought a hosted identity provider that speaks OIDC and can migrate credentials through a hook at login time. Three engineers have one quarter, alongside their product work, to move authentication to the provider. There may be no planned downtime, no forced password reset, and no step that cannot be undone within an hour if it goes wrong.

Plan the migration: the ordered steps across the quarter and what is true after each, how existing users move over (including users who do not log in during the quarter), how sessions behave while both systems are live, and where the point of no return is and what gets cleaned up after it.

### Constraints

- One quarter, three engineers part-time alongside product work.
- About 40,000 active users with passwords stored as bcrypt hashes in the monolith's database; users must not be forced to reset passwords.
- The company has chosen a hosted identity provider that supports OIDC and can import or migrate credentials through a hook.
- No planned downtime and no "big bang" switch: a failed step must be reversible within an hour.

### Success criteria

- An ordered plan of steps across the quarter, each reversible, with what is true at the end of each.
- How existing users move without a forced password reset, and what happens to users who do not log in during the migration.
- How sessions behave during the transition when both systems are live.
- The point of no return, how it is reached safely, and what is cleaned up afterwards.

## Swarm answer

_Run `01a1e1d5-2cf4-7640-9637-e544eb49fc97`, 12 rounds, completed/budget_rounds, $0.0171, confidence 0.55; the final write-up, asked for about 900 words, 565 written._

Recommendation: migrate authentication to the hosted OIDC provider across the quarter in reversible phases, with no planned downtime and no forced password resets. Each user's password is verified against the existing bcrypt hash at first login through the provider's migration hook; on success the credential is stored in the provider and the user is marked migrated. The legacy login path stays available as the rollback until a single gated cutover to IdP-only login, and legacy code, hashes and session stores are removed only after that cutover.

Week 1 to 3: confirm the provider accepts the legacy bcrypt format ($2a$, $2b$ or $2y$ with its cost factor) and handles the 72-byte truncation identically to the monolith, using a test set of known passwords. Assumption: the provider's hook can verify against an external bcrypt hash without storing a derived credential the monolith cannot reproduce; this is the first gate and if it fails the plan falls back to a verification service hosted beside the monolith.

Week 4 to 6: shadow phase. Route a small cohort through the provider while the monolith remains the sole source of truth; compare outcomes and latency, and confirm that a failed hook call leaves the user on the legacy path. Rollback is switching the cohort back to local login, well under an hour.

Week 7 to 10: general availability with dual-run sessions. The monolith accepts both its own server-side session cookies and provider-issued OIDC tokens, and exchanges a valid legacy session for an OIDC session on first access. Logout is propagated by back-channel invalidation of local sessions. Rollback per phase is re-enabling the legacy route, with the time bound stated and tested before the phase starts.

Dormant users who do not log in during the quarter keep their hashes in place and are migrated on first login after cutover through the same hook. Assumption: the provider's hook does not allow unauthenticated bulk import, so dormant accounts are not migrated in advance; leaving them on the legacy path indefinitely is rejected because it keeps the weakest component live. A time-boxed decision is needed on whether a one-off export is worth the security cost of moving hashes.

Point of no return: the switch to IdP-only mode, which disables local password checks. It is gated on a high share of active users being migrated or bridged and on login error rates staying low, and it can be reverted within an hour to legacy authentication. Assumption: the 95% and 1% thresholds are provisional and must be set from the shadow-phase measurements. Writes made after cutover, such as provider-side credential changes and new sessions, are not fully reversible, so the gate must state how they are handled.

Cleanup after the point of no return is phased: remove legacy login code from active paths first, retain the bcrypt column for a retention period (90 days is a placeholder until retention and compliance rules are confirmed), then drop the column and decommission local session stores. Assumption: the retention period is set by the company's compliance owner before cleanup starts; until then the column is kept.

Risks left open: the legacy database remains a live dependency of every login during transition, so its availability must be monitored and its failure mode defined before general availability. The verification bridge's hosting and whether it creates a second credential store are not yet settled and should be resolved in weeks 1 to 3.

## Baseline answer

_claude-sonnet-5-5, asked for about 900 words, used 2175 of 2702 output tokens allowed under a $0.0300 cap, cost $0.0238. Board handles are shown here; the judge saw the answers with them removed._

**Recommendation:** Run a lazy, login-time migration behind a feature flag, with the monolith's own login kept as the fallback until the last step. Every step except the final cleanup is a flag flip or a deploy rollback, so each is undoable inside an hour. Passwords move one user at a time via the provider's migration hook; nobody is reset. Users who never log in during the quarter are handled by a deliberate, optional bulk step (below) and are not migrated silently. The only irreversible act is deleting the old hashes, and that happens after the quarter's main work, on evidence.

**Step 1 (weeks 1-2): Provider setup and a seam in the monolith.** Configure the provider tenant, a custom-database migration hook, and a staging environment. In the monolith, put authentication behind one interface ("authenticate and establish session") with two implementations: legacy and OIDC. Add a flag, controllable per user cohort. *True at end:* production behaviour is unchanged; the flag is off; rollback is a deploy revert. Also decide the stable identifier now: map each provider account to the monolith's internal user ID (store it as an external-ID column), never to username, since usernames can change or collide.

**Step 2 (weeks 3-4): Build the migration hook and verify in staging.** The hook receives username and password from the provider at first login, calls a monolith endpoint that checks the bcrypt hash, and on success returns the profile so the provider stores the credential in its own hash. On failure it returns a plain 'wrong credentials' so nothing leaks. Rate-limit and authenticate that endpoint (it is a password oracle), log without recording passwords, and test lockout and unknown-user behaviour. Confirm the provider can verify bcrypt-format hashes or, if not, that it re-hashes on first successful login; this is the main technical unknown, so resolve it here. *True at end:* hook works in staging against a copy of production-shaped data; production untouched.

**Step 3 (weeks 5-6): Dual session acceptance, still off for users.** Teach the monolith to accept either its legacy session cookie or an OIDC-derived session, resolving both to the same internal user ID. Do this before sending anyone through OIDC. *True at end:* a user with either kind of session is treated identically; the OIDC path is exercised only by engineers' test accounts. Rollback is disabling the OIDC acceptance code path via flag.

**Step 4 (weeks 7-8): Internal, then 1% canary.** Turn the flag on for employees, then about 1% of users (hash of user ID, so cohorts are stable). Those users log in through the provider; the hook migrates them on success. Watch login success rate, hook latency, support tickets and password-failure rate against the legacy baseline. *True at end:* a small cohort is migrated; everyone else is on legacy. Rollback is flag-off: migrated users can still log in through the provider (their credentials now live there), and the flag simply stops routing new users to it. Crucially, keep the legacy hash untouched, so a user routed back to legacy still logs in with the same password. Note the one divergence: a password changed at the provider after migration would not reach the legacy hash, so during this phase either disable password change at the provider or have the provider's change event write the new bcrypt hash back to the monolith. Decide which in Step 2.

**Step 5 (weeks 9-11): Ramp to 10%, 50%, 100%.** Hold each stage for several days of normal traffic, including a weekend, and move up only if metrics match baseline. *True at end:* all logins go through the provider; legacy login remains deployed and reachable by flag. Active users migrate naturally as they log in; the monolith records a 'migrated' marker per user.

**Sessions while both systems are live.** Existing legacy sessions are never invalidated by the cutover; they live out their normal expiry and are honoured by the dual-acceptance code. When a legacy-session user next authenticates (expiry or re-login), they go through OIDC and receive an OIDC-backed session. Logout must clear both: it destroys the server-side session and, for OIDC users, calls the provider's logout endpoint, so a user cannot be logged out of one system and silently remain in the other. Session lifetimes should be aligned so neither system holds a user far longer than the other. Because sessions are server-side, revocation (for example after a compromise) works on both paths, and you should test that explicitly in Step 3.

**Users who do not log in during the quarter.** Lazy migration leaves them on the legacy hash, still working through the fallback. Do not wait for them indefinitely. In weeks 11-12, look at the unmigrated count. For dormant accounts, choose per segment: (a) bulk-import hashes into the provider if it supports bcrypt import (no password change needed, fully reversible since the legacy copy remains), or (b) leave them and send a gentle 'log in to keep your account' notice, retaining the legacy path for them until a published date. A forced reset is excluded by your constraints, so the fallback for genuinely never-returning users is that their account stays dormant and they use the normal 'forgot password' flow whenever they come back, which is an opt-in recovery, not a forced reset.

**Step 6 (week 12): Soak and decision gate.** Run at 100% for at least two weeks with legacy login still deployed. The gate to proceed: migrated share of active users (say logged in within 60 days) above 98%, error rates at baseline, no open auth incidents, and a tested restore of the legacy hash table from backup.

**Point of no return.** It is the deletion of legacy bcrypt hashes and removal of the legacy login code, because after that, rolling back to the monolith's own login is impossible. Reach it safely: first remove the legacy login path from the UI but keep the code and hashes for 30-60 days; then take a verified, encrypted offline backup of the hash table with restricted access; only then delete. The backup is itself a liability, so give it a retention end date.

**Cleanup afterwards:** drop the hash column and legacy session code, remove the flag and dual-acceptance logic, disable the migration endpoint and rotate its credentials, remove the hook from the provider, and update runbooks and incident procedures. Also document the dormant-user policy.

**Caveats and open questions:** the bcrypt support question (Step 2) could change the dormant-user plan; password-change sync needs an explicit decision; and part-time staffing makes weeks 5-11 the schedule risk, so protect the canary window from slippage rather than compressing the holds.

## Judgements

Swarm 57.1%, baseline 90.5%, winner baseline.

### Order 1: A = swarm, B = baseline; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 2 — Gives week-banded phases (confirm bcrypt compatibility, shadow cohort, GA with dual-run, gated IdP-only cutover, phased cleanup) with rollback mentioned, but the state after each phase is thin and rollbacks are generic ('re-enable the legacy route') rather than step-specific. | 3 — Six numbered steps with week ranges, each stating what is true at the end and a specific rollback (deploy revert, flag-off, disable OIDC acceptance), with explicit ordering rationale such as dual-session acceptance before sending any user through OIDC. |
| credentials | 3 | 2 — Describes lazy migration through the hook verifying against the bcrypt hash, 72-byte truncation check, and dormant users migrated on first login after cutover; but the dormant-user decision is left open and there is no concrete treatment of hash retirement beyond a 90-day placeholder retention. | 3 — Details the hook calling an authenticated, rate-limited monolith endpoint that checks bcrypt, provider re-hashing, dormant-user options (bulk import vs notice and retained legacy path), password-change divergence, and a hash deletion path with encrypted backup that itself gets a retention end date. |
| dual-run | 2 | 2 — States the monolith accepts both legacy cookies and OIDC tokens, exchanges legacy for OIDC on first access, and uses back-channel logout, which is a clear rule, but offers no edge cases such as mid-switch expiry, API clients, or admin accounts. | 2 — Gives a rule that legacy sessions live out their expiry and honour dual acceptance, new auth yields OIDC sessions, logout clears both sides, lifetimes are aligned, and revocation is tested; admin accounts and API clients are not covered. |
| constraints | 2 | 1 — Week ranges are given and 'well under an hour' is claimed, but there is no effort per step for three part-time engineers and no named step most likely to slip with a buffer. | 2 — Fits the schedule into 12 weeks with flag flips for one-hour reversal and explicitly names weeks 5-11 as the schedule risk to protect, though it lacks per-step effort estimates in person-time. |
| cutover | 2 | 2 — Names IdP-only switch as the point of no return with provisional thresholds (95%/1%) and a phased cleanup list, but internally inconsistent: calls it the point of no return yet says it is revertable within an hour, and offers no post-cutover monitoring window. | 3 — Correctly identifies hash deletion and legacy code removal as the irreversible point, with a gate (98% of 60-day actives, baseline errors, tested restore), staged removal over 30-60 days, backup, and a cleanup list; post-cutover monitoring is implied by the soak and delay rather than an explicit week. |
| correctness | 2 | 1 — Claims are mostly sound and flags assumptions honestly, but the 'point of no return' that is also revertible in an hour muddles the logic, and the plan to migrate dormant users 'after cutover' via a hook that disables local password checks conflicts with its own cutover step. | 3 — Sound and precise: maps to internal user ID not username, notes the hook is a password oracle, handles the legacy-hash divergence after provider password change, and flags the bcrypt-support unknown; slight softness in calling a 'forgot password' recovery non-forced. |

> B is more specific and internally consistent, with per-step state and rollback and a properly defined irreversible point, while A conflates its point of no return with a one-hour-reversible switch and leaves dormant users unresolved.

### Order 2: A = baseline, B = swarm; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 2 — Phases are given by week range with rollback mentioned for the shadow and GA phases, but the state after each phase is thin and the 'shadow phase' is loosely defined, with the rollback time bound only 'stated and tested' rather than specified. | 3 — Six numbered steps with week ranges, each stating what is true at the end (e.g. 'flag off; rollback is a deploy revert', 'all logins via provider; legacy reachable by flag') and an explicit reversal mechanism, with a logical order (seam, hook, dual acceptance, canary, ramp, soak). |
| credentials | 3 | 2 — Describes lazy migration via the hook and the bcrypt version and 72-byte truncation check, but the dormant-user plan is vague ('migrated on first login after cutover' while also rejecting leaving them on legacy) and the hash retirement is a placeholder 90-day retention. | 3 — Lazy migration via the hook verifying against the bcrypt hash, with a rate-limited authenticated endpoint treated as a password oracle, a dormant-user plan (bulk bcrypt import vs notice vs forgot-password), and a backup-then-delete retirement of hashes with a retention end date. |
| dual-run | 2 | 1 — Says the monolith accepts both session types and exchanges legacy sessions for OIDC, with back-channel logout, but gives no clear rule on session ownership, expiry mid-switch, API clients or admins. | 2 — States that legacy sessions live out their expiry and are honoured by dual acceptance, logout clears both systems, lifetimes are aligned, and revocation is tested; also handles password-change divergence, but does not address API clients or admin accounts. |
| constraints | 2 | 1 — Gives week ranges that plausibly fit a quarter, but no effort per step and no named slip risk; the plan is internally inconsistent on what the legacy database dependency costs. | 2 — Fits a 12-week calendar with part-time staffing and names weeks 5-11 as the schedule risk to be protected, but gives no per-step effort estimate in person-days. |
| cutover | 2 | 2 — Names IdP-only mode as the point of no return with provisional thresholds and a phased cleanup, but claims it can be reverted within an hour (contradicting 'point of no return'), and has no post-cutover monitoring period. | 3 — Defines the point of no return as hash deletion, with a quantified gate (98% of 60-day actives, baseline errors, tested restore), a staged removal and offline backup, and a cleanup list; post-cutover monitoring is only implied through the soak before the gate. |
| correctness | 2 | 2 — Precise on bcrypt prefixes and truncation, but the claim that the point of no return is revertible within an hour is contradictory, and the dormant-user logic conflicts with itself. | 3 — Claims are sound and the plan flags the bcrypt-import question as an unknown to resolve; the rollback caveat about provider-side password changes diverging from legacy hashes is precise, though 'forgot password' for dormant users slightly strains the no-reset constraint. |

> Answer A is more concrete, internally consistent and complete across sequencing, sessions, dormant users and cutover; Answer B is hedged with unresolved assumptions and contradicts itself on reversibility at the point of no return.
