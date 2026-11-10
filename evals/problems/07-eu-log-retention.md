---
id: eu-log-retention
title: Log and backup retention for a B2B SaaS with EU customers
domain: policy-design
constraints:
  - "Application logs contain user identifiers and sometimes free text typed by users; infrastructure logs contain IP addresses."
  - "Customers are companies in the EU and the US; contracts promise deletion of a customer's data within 30 days of termination."
  - "Daily database backups are kept for 90 days today; security wants at least a year of audit logs."
  - "The engineering team is six people; there is no dedicated compliance function."
successCriteria:
  - "A retention schedule per data class (application logs, infrastructure logs, audit logs, backups) with a reason for each period."
  - "How the 30-day deletion promise is kept when backups and logs outlive it."
  - "The mechanisms that enforce the schedule automatically, and how the team proves they ran."
  - "The GDPR concepts the schedule relies on, stated correctly, without overclaiming."
rubric:
  - id: schedule
    weight: 3
    criterion: Gives a retention period per data class with a reason tied to its purpose.
    scale: "0 = one blanket period or none; 1 = periods without reasons; 2 = periods with purpose-based reasons; 3 = plus how personal data is minimised or pseudonymised within each class."
  - id: deletion
    weight: 3
    criterion: Reconciles the 30-day deletion promise with backups and logs that live longer.
    scale: "0 = conflict not noticed; 1 = 'delete from backups too' with no mechanism; 2 = a workable approach (backup expiry within the window, per-tenant keys, deletion on restore) and its honest limits; 3 = plus how the contract wording and the practice are kept aligned."
  - id: enforcement
    weight: 2
    criterion: Names automatic mechanisms (lifecycle rules, TTLs, scheduled jobs) and the evidence that they ran.
    scale: "0 = manual or unspecified; 1 = 'automate it'; 2 = concrete mechanisms per store; 3 = mechanisms plus an audit trail or report that proves deletion."
  - id: gdpr
    weight: 2
    criterion: Uses GDPR concepts (storage limitation, lawful basis, controller/processor roles, data subject requests) correctly and does not overclaim.
    scale: "0 = material misstatements; 1 = vague references; 2 = correct use of the relevant concepts; 3 = correct, and clear about what it is not asserting (legal advice, specific national rules)."
  - id: fit
    weight: 1
    criterion: Fits a six-person team with no compliance function.
    scale: "0 = assumes a compliance team or heavy tooling; 1 = plausible but unscoped; 2 = fits, with the owner of each mechanism named; 3 = fits, with the smallest version that is defensible first."
---
A B2B SaaS company with six engineers and no compliance function serves business customers in the EU and the US. Its application logs carry user identifiers and sometimes free text users typed; its infrastructure logs carry IP addresses; database backups are kept daily for 90 days; the security lead wants at least a year of audit logs. Customer contracts promise that a customer's data is deleted within 30 days of termination.

Design the company's retention policy: how long each class of data (application logs, infrastructure logs, audit logs, backups) is kept and why, how the 30-day deletion promise is honoured when backups and logs live longer than that, which automatic mechanisms enforce the schedule and how the team can prove they ran, and which GDPR concepts the policy rests on. Be precise about what you are and are not claiming.
