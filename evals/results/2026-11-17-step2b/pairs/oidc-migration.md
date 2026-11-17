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

_Run `01a1e6da-4f48-7feb-b5f4-82a7ad677d91`, 12 rounds, completed/budget_rounds, $0.0193, confidence 0.40; the final write-up, asked for about 900 words, 626 written._

Recommendation: migrate in place across the quarter, keeping the monolith as the credential and session authority until the identity provider has been proven in a test tenant to accept and verify the existing bcrypt hashes. Nothing irreversible happens before that check passes, and the point of no return is held back until it does.

Weeks 1-2: instrument the existing login and session paths, and stand up a test tenant of the identity provider. Run a dry-run importing a sample of around 200 bcrypt hashes through the provider's import API, then log in with known passwords through its native verification path. Record whether it verifies the hashes natively or only converts them, and whether it keeps the original cost factor. Each step is reversible by deleting the test tenant records; effort is about 3 engineer-days.

Weeks 3-5: add a verify-then-provision path for active users. At login the monolith verifies the bcrypt hash locally, and on success sends only user_id and email to the provider. A rejected provision is logged and the login proceeds on the local session, so the step is reversible by turning the flag off within minutes. No raw password or hash is pushed at login, so no user is forced to reset.

Weeks 6-8: enable the OIDC relying-party flow behind a feature flag for a small cohort of staff accounts. The monolith stays the session authority. Users who have been provisioned get a migration flag set client-side only after provisioning succeeds. Shadow-mode login correlation is tracked against the local path; the flag is disabled to roll back.

Weeks 9-10: bulk-import dormant users' bcrypt hashes in batches only if the test tenant showed native verification. If it only converts hashes, dormant users stay on the local fallback until their next login, when the active-user path provisions them. Each batch can be deleted from the provider within an hour.

Weeks 11-12: the point of no return. Assumption: it is reached only after shadow-mode correlation exceeds 99.9 percent and the dormant-user import has been verified on the full population. At that point the monolith stops verifying credentials for new sessions and redirects all authentication to the provider, keeping archived bcrypt hashes read-only for about 30 days so the change can be reversed within the hour by re-enabling the local path.

Sessions during coexistence: the monolith keeps issuing its own session cookies throughout, so a user authenticated in either system is recognised by the monolith without re-prompting. Session lifetime is unchanged until the cutover. Assumption: the provider's subject identifier is mapped to the internal user_id before first IdP login, so the two sessions refer to the same account; if mapping fails, the user stays on the local path. Single sign-out across both systems is not part of the quarter and is deferred.

Users who never log in during the quarter are handled by the bulk import in weeks 9-10. Assumption: the provider can verify imported bcrypt hashes natively; if it cannot, these users remain on the local fallback, which keeps them able to log in, and they are migrated on their next login. No user is permanently locked out, but the monolith's bcrypt path cannot be removed until every dormant account is resolved.

Cleanup after the point of no return: remove the password and hash columns, retire the legacy session store, delete the local verification code, and remove the feature flags. Each removal is done after the 30-day read-only window closes and is reviewed before merging.

Open items the plan depends on: confirming the provider's bcrypt import and verification behaviour in the test tenant, defining recovery when silent provisioning fails, and deciding whether the monolith's bcrypt path may remain for dormant users beyond the quarter. Until the first is confirmed, the point of no return is not scheduled.

## Baseline answer

_claude-sonnet-5-5, asked for about 900 words, used 2175 of 2702 output tokens allowed under a $0.0300 cap, cost $0.0238, cached from an earlier pass. Board handles are shown here; the judge saw the answers with them removed._

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

Swarm 45.2%, baseline 90.5%, winner baseline.

### Order 1: A = swarm, B = baseline; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 2 — Gives week-banded steps (test-tenant dry run, verify-then-provision, flagged OIDC for staff, bulk import, cutover) each with a rollback note, but the state after each step is thin and the pre-cutover steps do not clearly end with OIDC serving real users, and ordering is only partly justified. | 3 — Six ordered steps with weeks, a stated end-state for each, and a rollback mechanism per step (flag flip, deploy revert), and the order is justified (seam first, session acceptance before routing users, canary before ramp), ending with OIDC at 100% then cleanup. |
| credentials | 3 | 1 — Describes verify-locally-then-provision at login with no password pushed and a conditional bulk import for dormant users, but 'sending only user_id and email' does not actually migrate the credential, so users would still depend on the monolith's hashes; the dormant case is hedged on an unconfirmed assumption. | 3 — Uses the provider's migration hook calling a monolith bcrypt check at first login so the provider stores its own hash, secures the endpoint as a password oracle, handles dormant users via bulk import or retained fallback, and retires hashes only after a backup and gate, though the optional 'forgot password' fallback for returners is slightly soft. |
| dual-run | 2 | 1 — States the monolith stays session authority and issues its own cookies throughout, with subject-to-user_id mapping and unchanged lifetime, but defers single sign-out and says nothing about API clients, admin accounts or expiry mid-switch. | 2 — Gives a clear rule: legacy sessions live out their expiry and are honoured by dual acceptance, next auth goes through OIDC, logout clears both, lifetimes are aligned, and revocation is tested, but it does not cover API clients or admin accounts. |
| constraints | 2 | 1 — Fits a 12-week calendar and gives one effort figure (about 3 engineer-days) for weeks 1-2, but offers no other estimates and names no step as likely to slip. | 2 — Fits three part-time engineers across weeks with no downtime via flags and canary, and names weeks 5-11 as the schedule risk to protect, but gives no per-step effort estimates. |
| cutover | 2 | 2 — Defines the point of no return with a numeric criterion (99.9% shadow correlation, verified dormant import) and a 30-day read-only retention and cleanup list, but contradicts itself by calling it the point of no return while keeping a one-hour reversal, and omits post-cutover monitoring. | 3 — Identifies hash deletion and legacy code removal as the true point of no return, with a gate (over 98% active migrated, baseline errors, tested restore), a 30-60 day hold, an encrypted backup with retention end, and a full cleanup list including rotating the endpoint credentials. |
| correctness | 2 | 1 — Mostly plausible and appropriately hedged on whether the provider verifies bcrypt natively, but the provisioning model is incoherent (provider accounts with no credentials), the 'point of no return' is reversible, and the architecture leaves the monolith as auth authority, undermining the goal of moving authentication to the provider. | 3 — Sound and precise on custom-database hook mechanics, stable ID mapping, the password-change divergence between the provider and legacy hash, and the open bcrypt-support question, and correctly notes rollback works because migrated credentials live at the provider. |

> B is a coherent lazy-migration plan with per-step state, a justified canary ramp, a real irreversible point and a thorough cleanup, whereas A's provisioning scheme does not actually move credentials and its point of no return remains reversible.

### Order 2: A = baseline, B = swarm; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 2 — Gives week-ranged steps (dry-run, verify-then-provision, flag-gated staff cohort, dormant import, cutover) with some reversal notes, but the state after each step is thin and the cutover step is vague on how it is staged. | 3 — Six numbered steps with week ranges (seam+flag, hook in staging, dual session acceptance, 1% canary, ramp 10/50/100, soak gate), each with 'true at end' and a rollback (flag-off, deploy revert), and the ordering is justified (dual acceptance before routing anyone through OIDC). |
| credentials | 3 | 1 — Provisions only user_id and email at login, with no password or hash sent. This means the user never gets a credential in the IdP unless the bulk hash import works, and it never explains how active users end up verifiable at the provider; the dormant plan is conditional on native bcrypt verification and leaves a permanent local fallback. | 3 — Lazy migration via the provider's hook verifying bcrypt against a monolith endpoint, with a dormant-user plan (bulk bcrypt import or notice plus 'forgot password' opt-in), plus the password-oracle risk, rate limiting, divergence on password change, and hash deletion after backup with retention end date. |
| dual-run | 2 | 1 — The monolith keeps issuing its own sessions and maps the subject ID to the internal user_id, which is a clear rule, but it explicitly defers single sign-out and does not address API clients, admins, or expiry mid-switch. | 2 — States a clear rule (legacy sessions honoured to expiry, new auth goes via OIDC, both resolve to the same internal user ID), logout clears both, lifetimes aligned, revocation tested; API clients and admin accounts are not explicitly covered. |
| constraints | 2 | 1 — Gives a rough effort for the first step (3 engineer-days) but not for the others, and names no step as most likely to slip or buffered. | 2 — Fits a 12-week plan with holds, names weeks 5-11 as the schedule risk and says to protect the canary window, but gives no per-step effort estimates in engineer-days. |
| cutover | 2 | 2 — Defines a cutover criterion (99.9% shadow correlation, verified dormant import), a 30-day read-only hash window and a cleanup list, but the claim that reversal is possible 'within the hour' after the point of no return contradicts it being a point of no return, and post-cutover monitoring is absent. | 3 — Names the deletion of hashes and legacy login code as the point of no return, with a gate (98% of active users migrated, error rates at baseline, tested restore), a staged path (hide UI, keep code 30-60 days, encrypted backup), and a cleanup list; the week-long post-cutover monitoring is only loosely covered via the soak and holding period. |
| correctness | 2 | 1 — The credential flow is incoherent: provisioning users without credentials at login while claiming no one needs a reset, a client-side-only 'migration flag', and a shadow-mode correlation metric that is never defined, so the steps don't clearly fit together. | 3 — The hook-based lazy migration, stable ID mapping, bcrypt re-hash on first login, password-oracle caution and the flagged bcrypt-support unknown are all accurate and precise about limits; the one soft spot is that the 'forgot password' flow after dormancy is slightly in tension with its own no-reset framing. |

> Answer A gives a coherent, justified, reversible sequence with a real lazy-migration mechanism and well-defined cutover; Answer B leaves the credential path unclear and contradicts itself on reversibility after the point of no return.
