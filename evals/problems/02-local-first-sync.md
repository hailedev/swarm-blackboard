---
id: local-first-sync
title: Storage and sync for a local-first notes app
domain: architecture
constraints:
  - "The app must work fully offline on phone and laptop; sync is a convenience, never a requirement."
  - "Two developers; the first paying customers are expected in six months."
  - "Notes are text with attachments up to 10 MB; users expect edits on two devices at once not to lose text."
  - "The team wants to start with no server and add a hosted sync service later without migrating users' data by hand."
successCriteria:
  - "A recommended on-device storage choice and a sync strategy, with the alternatives rejected and why."
  - "How concurrent edits on two devices are reconciled, and what the user sees when they conflict."
  - "A migration path from no server to a hosted service that existing users do not notice."
  - "The main risks of the recommendation and how to find out early whether they bite."
rubric:
  - id: storage
    weight: 2
    criterion: Recommends a specific on-device storage approach and rejects at least one alternative for a stated reason.
    scale: "0 = no recommendation; 1 = a recommendation with no alternatives; 2 = recommendation plus a rejected alternative with a reason; 3 = plus a reason tied to this app's constraints (offline, attachments, two developers)."
  - id: conflicts
    weight: 3
    criterion: Explains how edits from two devices are merged and what the user sees on conflict.
    scale: "0 = conflicts ignored; 1 = 'last write wins' or 'use CRDTs' with no detail; 2 = a mechanism and its user-visible behaviour; 3 = a mechanism, its user-visible behaviour, and where it fails (attachments, deletes, offline for weeks)."
  - id: migration
    weight: 3
    criterion: Gives a path from no server to hosted sync that does not require users to export or re-import data.
    scale: "0 = migration not addressed; 1 = 'add a server later'; 2 = a concrete path (data format, identity, first sync) users do not notice; 3 = plus what must be decided now to keep that path open."
  - id: correctness
    weight: 2
    criterion: Technical claims are correct and the recommended parts exist and fit together.
    scale: "0 = material errors; 1 = one questionable claim; 2 = sound; 3 = sound and precise about limits (sizes, platforms, guarantees)."
  - id: risks
    weight: 2
    criterion: Names the main risks and an early test for each.
    scale: "0 = no risks; 1 = risks with no way to detect them; 2 = risks with early signals; 3 = risks, signals, and the fallback if a signal fires."
---
Two developers are building a local-first notes app: text notes with attachments up to 10 MB, on phones and laptops, fully usable offline. They have no server today and want none for the first release, but they plan to offer a paid hosted sync service within a year. Customers will often edit the same note on two devices before either has connected, and they expect not to lose text when that happens.

Recommend how the app should store data on the device and how it should sync, how concurrent edits are reconciled and what the user sees when they conflict, and how the team gets from "no server" to a hosted sync service without existing users having to migrate anything. Name the risks of your recommendation and how the team would find out early if one of them is real.
