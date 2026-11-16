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

_Run `01a1e2e4-429f-7ceb-8c3b-76f7da2e9961`, 4 rounds, completed/completed, $0.0000, confidence 0.85; the final write-up, asked for about 1350 words, 72 written._

The migration to the hosted Identity Provider (IdP) spans twelve weeks, structured into three distinct phases designed for three part-time engineers working alongside product development. The plan ensures no planned downtime, avoids forced password resets, and maintains reversibility within one hour at every major step. The strategy relies on a 'bridge' architecture where the monolith temporarily acts as an authenticator for the new IdP, allowing credentials to migrate passively without user intervention.

## Baseline answer

_qwen3.6:35b-mlx, asked for about 1350 words, used 2113 of 4096 output tokens allowed under a $0.0300 cap, cost $0.0000, cached from an earlier pass. Board handles are shown here; the judge saw the answers with them removed._

To begin the migration with three part-time engineers over a single quarter, we must prioritize low-risk, high-leverage steps that allow for immediate rollback. The strategy relies on parallel identity stores rather than an atomic switch, ensuring that any failure reverts to the monolith’s native login within an hour. The first step is establishing the foundational infrastructure: provisioning the hosted Identity Provider (IdP) instance and configuring the OIDC application metadata in the monolith. Crucially, we integrate the IdP’s credential migration hook into the monolith’s existing login endpoint as a secondary path. At this stage, nothing changes for the end user. The monolith still validates passwords via bcrypt locally. However, the codebase now contains the logic to attempt authentication against the IdP if the local lookup fails or if a specific flag is set. This step is trivially reversible by removing the integration code and redeploying the previous binary, which guarantees session consistency with the old state.

The second phase addresses the data migration for existing users without forcing password resets. We utilize the 'hook at login time' capability by writing a background worker that scans the monolith’s user database for bcrypt hashes. This worker exports the username and hashed password to a secure staging area, then triggers the IdP’s bulk import API to store these credentials in the hosted provider’s directory. Since we are importing the hash, not the plaintext password, users can continue logging in with their existing passwords. The critical safety mechanism here is that the monolith remains the source of truth for authentication. We verify the import by comparing counts and sample hashes. If this step fails or causes latency issues in the IdP during import, we simply stop the worker; the monolith continues to function exactly as before, serving all 40,000 active users with their known bcrypt hashes intact.

The third step introduces the dual-authentication capability for live traffic without changing user behavior. We modify the monolith’s login flow to attempt authentication against the IdP *after* attempting local bcrypt verification fails, or more safely, we implement a 'lazy migration' pattern. In this pattern, when a user successfully logs in via the monolith’s native bcrypt check, the system silently pushes the username and password hash to the IdP via the migration hook for future reference. This ensures that as users actively log in, their credentials are replicated to the hosted provider. Users who do not log in during this phase remain fully authenticated via the monolith. Sessions generated here are still stored in the monolith’s session store. This step is reversible because if the IdP becomes unstable, the monolith’s local bcrypt check still succeeds, and the silent background push can be paused or halted without affecting the successful login outcome for users.

The fourth phase shifts the 'source of truth' for authentication from the monolith to the IdP for new sessions. We update the monolith to redirect unauthenticated requests to the hosted IdP’s OIDC authorize endpoint while keeping a fallback to local bcrypt for emergency access. However, to maintain session continuity, we implement a bridge where the monolith accepts OIDC tokens issued by the IdP as valid session initiators. When a user logs in via the IdP, the token is validated, and a new local session record is created linked to that external identity ID. This allows us to start redirecting traffic to the IdP. If this fails, we simply disable the OIDC redirect flag, and all traffic falls back to the monolith’s native login. The point of no return is not reached here; we are merely adding a new pathway alongside the old one.

The fifth step focuses on handling the 40,000 active users who may have varying levels of engagement. We implement a 'silent redirect' for users whose accounts have been migrated to the IdP during the previous steps. When a user with a migrated credential attempts to log in, the system automatically redirects them to the IdP, bypassing the local password field. For users who have never logged in or whose credentials were not successfully migrated, the monolith’s local login remains the default. This ensures no user is forced to reset their password; they simply authenticate against where their hash exists. Sessions behavior during this dual-live state is critical: we must ensure that a session created via OIDC is indistinguishable from one created via bcrypt in terms of expiration and revocation. We achieve this by storing the 'issuer' (monolith vs IdP) in the session metadata but treating both as valid for accessing protected resources.

The sixth phase executes the cutover, ensuring no planned downtime. We roll out a configuration flag that makes the IdP the primary authentication method for all new login attempts. Existing sessions remain valid until they expire or are revoked, allowing for a graceful fade-out of the old monolith-based sessions. If a user’s existing session expires, they will authenticate via the IdP. If the IdP is down, we have a circuit breaker that redirects back to the monolith. This reversibility is key: if the IdP proves unstable under load, we flip the flag back, and all users return to the monolith login immediately. The 'point of no return' is defined as the moment we decommission the bcrypt validation logic in the monolith and remove the local session store dependency for authentication decisions. This is a high-risk operation that requires extensive monitoring.

The point of no return is safely reached only after the IdP has handled 100% of successful authentications for a sustained period (e.g., two weeks) with zero errors. We then perform a final cleanup: removing the bcrypt columns from the user table in the monolith’s database and removing the local session creation logic that relied on those hashes. At this stage, the monolith is purely an OIDC consumer. The old data is backed up offsite for 90 days as a cold backup, effectively serving as the undo button if a catastrophic error is found post-cleanup. After this cleanup, the monolith no longer stores passwords, reducing its attack surface and compliance burden.

Handling users who do not log in during the quarter is managed through the 'lazy migration' strategy in step three. These users’ bcrypt hashes are scanned and pushed to the IdP asynchronously. If they never log in, their credentials reside in the IdP but are unused. When they eventually attempt to log in after the cutover (step six), they will be redirected to the IdP. Since their password hash was imported during the quiet phase, the IdP can validate it successfully without requiring a reset. This ensures zero friction for inactive users; they simply become OIDC users upon their next active engagement.

To address session behavior while both systems are live, we implement 'session federation'. When a user logs in via the monolith, we create a local session. When they log in via the IdP, we create an OIDC-backed session. To prevent session hijacking or confusion, we tag each session with its origin. However, for the purpose of resource access, we treat them equally. If a user has both sessions valid (e.g., they logged in locally before cutover and now log in via IdP), we must decide whether to merge them. A safe approach is to keep them separate but ensure that logging out from one does not invalidate the other unless explicitly configured. Most OIDC providers allow for 'global logout', which we can configure to invalidate all sessions across both issuers, ensuring consistency.

The main caveats involve identity resolution and race conditions. If a user changes their password in the monolith during the migration, we must ensure the old hash is replaced in the IdP as well. We achieve this by triggering the migration hook on every successful password change event, not just login. Another caveat is performance: importing hashes can be I/O intensive. We throttle the background worker to avoid impacting the monolith’s database performance during product work hours. Finally, we must ensure that the IdP’s API limits are not exceeded for 40,000 users, using batched imports where supported.

The open questions revolve around edge cases in user identity. Do usernames collide? We assume unique usernames as keys. If emails are also identifiers, we must map them carefully. Another open question is the handling of 'magic links' or social logins if they existed; here we assume standard password auth only. The final review must confirm that all API keys and service-to-service authentication mechanisms are also migrated to OIDC client credentials, not just user-facing sessions.

In conclusion, this plan leverages a hybrid state for the majority of the quarter, allowing incremental trust building in the IdP. By keeping the monolith as the fallback and source of truth until the very end, we ensure that no step is irreversible without an hour’s rollback capability. The use of bcrypt hash migration allows users to retain their credentials seamlessly. The cutover is a configuration change, not a data migration, minimizing risk. Post-cutover, the cleanup removes legacy technical debt, leaving a clean OIDC-only architecture.

Engineering effort distribution should be weighted heavily towards the first half (infrastructure and dual-auth logic) and the validation/testing of the cutover flag in the second half. The 'lazy migration' worker is low-risk and can be run intermittently by the three engineers alongside their product duties, as it is asynchronous and idempotent. The critical path is the OIDC integration testing with the monolith’s session store.

Monitoring is essential: we must track login failures, redirect loops, and IdP latency. Alerts should be set for any deviation in auth success rates. If the IdP fails, the fallback to bcrypt ensures business continuity. This robust safety net allows the team to proceed with confidence, knowing that the quarter’s timeline is flexible enough to accommodate testing delays without impacting user experience.

Final validation involves a dry run of the cutover in a staging environment that mirrors production data volume. We simulate IdP outages, slow logins, and session expirations. This ensures that the 'point of no return' logic is sound. Only after passing these simulated failures do we proceed to production. This disciplined approach respects the constraints: no downtime, no forced resets, and full reversibility.

## Judgements

Swarm 14.3%, baseline 66.7%, winner baseline.

### Order 1: A = baseline, B = swarm; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 0 — Answer B only provides a brief introductory sentence and does not provide an ordered sequence of steps, reversal paths, or states after each step as required. | 2 — The answer provides a detailed six-step sequence with clear reversal paths for each step, but the steps are loosely organized and some logic (like 'lazy migration' vs bulk import) is contradictory or unclear regarding the specific state after each step. |
| credentials | 3 | 0 — It mentions the strategy relies on a bridge architecture but does not explain how bcrypt users migrate without forced reset or handle dormant users. | 1 — It explains that existing users migrate without reset by importing hashes, but contradicts itself between bulk import in step 2 and lazy migration in step 3/6, failing to clearly explain how dormant users are handled securely or efficiently without forcing a reset. |
| dual-run | 2 | 0 — It does not describe how sessions behave while both systems are live. | 1 — It describes running both systems but fails to provide a clear rule for session ownership or logout behavior, only mentioning tagging and separate sessions which is vague regarding the actual user experience of logout. |
| constraints | 2 | 0 — It mentions the constraints but provides no plan or schedule to fit them. | 1 — The plan mentions part-time engineers and no downtime but does not estimate effort per step or justify how the work fits into one quarter, lacking specific scheduling details. |
| cutover | 2 | 0 — It does not identify a point of no return or cleanup steps. | 2 — It identifies a cutover criterion (100% handling for two weeks) and cleanup actions, but lacks the monitoring period detail requested in the higher scores. |
| correctness | 2 | 1 — The single sentence is factually plausible but provides no substance to evaluate for correctness in the context of the problem's complexity. | 2 — The technical details are generally sound (OIDC, bcrypt), but the explanation of session management and credential migration is inconsistent and slightly confusing regarding the flow of control. |

> Answer A is significantly better as it provides a complete plan, whereas Answer B is essentially a placeholder.

### Order 2: A = swarm, B = baseline; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| sequencing | 3 | 1 — Answer A provides a high-level overview of the plan's structure but fails to list the specific ordered steps required by the rubric. | 3 — Answer B provides a detailed six-step sequence with clear reversal paths and justification for the order, ending with OIDC control. |
| credentials | 3 | 1 — It mentions a 'bridge' architecture and passive migration but lacks specific details on how bcrypt hashes are handled or migrated without reset. | 2 — It explains lazy migration at login for active users and an asynchronous scan for dormant users, including the retirement of old hashes. |
| dual-run | 2 | 0 — The answer does not describe the behavior of sessions or logout mechanisms during the transition period. | 2 — It describes session tagging and explicit rules for logout validity, though it misses some edge cases like API clients. |
| constraints | 2 | 1 — It states the plan is for three part-time engineers but offers no evidence that it fits within a quarter or details the reversibility mechanics requested. | 2 — It fits the constraints with rough effort estimates and naming the critical path, though it lacks specific buffering details for slippage. |
| cutover | 2 | 0 — The point of no return and cleanup are not addressed in the provided text. | 3 — It identifies the point of no return (decommissioning bcrypt logic) and lists post-cutover cleanup steps including offsite backups. |
| correctness | 2 | 1 — The concepts are generally sound but too vague to evaluate for material errors or precision. | 3 — The plan is sound regarding OIDC and bcrypt handling, with precise details on session federation and fallback mechanisms. |

> Answer B is significantly more detailed, addresses all success criteria explicitly, and provides a feasible, specific plan that adheres to the constraints. Answer A is too vague and fails to address most of the rubric's specific requirements.
