---
id: api-rate-limiting
title: Rate limiting a public API for bursty clients across three regions
domain: system-design
constraints:
  - "The API runs in three regions behind one global DNS name; a client's requests may land in any region."
  - "Paying customers are limited by plan (for example 600 requests per minute); free clients to 60 per minute."
  - "Legitimate clients are bursty: a client may send its whole minute's quota in two seconds, then nothing."
  - "The limiter must not add more than about five milliseconds to a request, and the API must keep serving if the limiter's storage is unavailable."
successCriteria:
  - "A named limiting algorithm and why it suits bursty clients better than the alternatives."
  - "Where the limiter's state lives, how three regions see one customer's quota, and what inaccuracy that implies."
  - "What happens when the state store is slow or down, and what the client sees."
  - "How a client learns its limit and when to retry."
rubric:
  - id: algorithm
    weight: 3
    criterion: Names an algorithm (token bucket, sliding window log or counter, leaky bucket) and argues it against alternatives for bursty traffic.
    scale: "0 = no algorithm; 1 = an algorithm with no comparison; 2 = compared with one alternative on burstiness; 3 = compared on burstiness and on memory or accuracy, with the parameters (bucket size, refill rate) stated."
  - id: state
    weight: 3
    criterion: Says where the counters live and how three regions share a customer's quota, with the inaccuracy named.
    scale: "0 = state placement not addressed; 1 = 'use Redis' with no regional story; 2 = a regional design (central store, per-region share, or async sync) with its latency; 3 = plus a quantified or clearly described over- or under-admission."
  - id: failure
    weight: 3
    criterion: Specifies the behaviour when the state store is slow or unavailable, within the latency budget.
    scale: "0 = failure not addressed; 1 = 'fail open' or 'fail closed' with no reasoning; 2 = a choice with reasoning and a timeout that meets the budget; 3 = plus a local fallback (in-memory bucket) and how it recovers."
  - id: client
    weight: 1
    criterion: Describes the response headers or body that tell a client its limit, remaining quota and retry time.
    scale: "0 = not addressed; 1 = 'return 429'; 2 = 429 plus retry timing; 3 = 429, remaining-quota and reset headers, and advice for burst clients."
  - id: correctness
    weight: 2
    criterion: Technical claims hold up; numbers are consistent with the constraints.
    scale: "0 = material errors; 1 = one questionable claim; 2 = sound; 3 = sound and explicit about the guarantees it does and does not make."
---
A company runs a public HTTP API in three regions behind a single global hostname; a client's consecutive requests can land in different regions. Paying plans allow between 600 and 6,000 requests per minute, free accounts 60. Many legitimate clients are bursty: a scheduled job may send its whole minute's allowance in two seconds and then go quiet. The team has been asked to add rate limiting that adds no more than about five milliseconds to a request and that never takes the API down when the limiter's own storage is slow or unavailable.

Design the rate limiter: the algorithm and why it fits bursty clients, where its state lives and how the three regions share a customer's quota, what happens when that state is slow or unreachable, and how clients learn their limits and when to retry. Be explicit about what the design gets wrong and by how much.
