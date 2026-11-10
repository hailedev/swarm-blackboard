# Storage and sync for a local-first notes app

Chosen as the baseline's widest win. Problem `local-first-sync`.

## Problem

Two developers are building a local-first notes app: text notes with attachments up to 10 MB, on phones and laptops, fully usable offline. They have no server today and want none for the first release, but they plan to offer a paid hosted sync service within a year. Customers will often edit the same note on two devices before either has connected, and they expect not to lose text when that happens.

Recommend how the app should store data on the device and how it should sync, how concurrent edits are reconciled and what the user sees when they conflict, and how the team gets from "no server" to a hosted sync service without existing users having to migrate anything. Name the risks of your recommendation and how the team would find out early if one of them is real.

### Constraints

- The app must work fully offline on phone and laptop; sync is a convenience, never a requirement.
- Two developers; the first paying customers are expected in six months.
- Notes are text with attachments up to 10 MB; users expect edits on two devices at once not to lose text.
- The team wants to start with no server and add a hosted sync service later without migrating users' data by hand.

### Success criteria

- A recommended on-device storage choice and a sync strategy, with the alternatives rejected and why.
- How concurrent edits on two devices are reconciled, and what the user sees when they conflict.
- A migration path from no server to a hosted service that existing users do not notice.
- The main risks of the recommendation and how to find out early whether they bite.

## Swarm answer

_Run `01a1c3da-17f6-7416-a149-ac450ab80a88`, 12 rounds, completed/budget_rounds, $0.0000, confidence 0.85._

We recommend adopting a local-first architecture using Automerge for the core text data and standard file system storage for attachments. Each note is stored as an Automerge document (a binary/blob) on disk, containing the text history and metadata. This satisfies the offline requirement by making the local file the single source of truth, while structuring the data in a way that allows a future hosted sync service to simply replicate these blobs without schema migration.

For attachments up to 10MB, we decouple storage from the CRDT state. Attachments are saved as external files on disk, keyed by content-hash or UUID. The Automerge document stores only the URI or hash reference. This keeps the sync payload lightweight (sending only small metadata changes rather than large binaries) and allows the server to act as a passive key-value store for text blobs and an object storage for attachments.

Concurrent edits are reconciled automatically by Automerge's CRDT engine, which merges text changes based on causal order and device identifiers. This guarantees that no text is lost, even if two devices edit the same note offline. However, because conflict resolution for concurrent inserts is deterministic but invisible to the user (relying on device ID tie-breakers), users may see text appear in an unexpected order. To address this UX risk, we recommend providing a 'conflict preview' mode or clear indicators when divergent edits are detected, allowing users to verify the merged result if desired.

The migration path from 'no server' to 'hosted sync' is handled via a client-side feature flag. Initially, notes exist only locally. When a user opts into sync, the app generates a unique Document ID for each note and uploads the existing Automerge blob to the new server. Existing users do not need manual data migration; they simply begin pushing their local state to the cloud. The server acts as a replicator, storing the blobs and attachment files transparently.

The primary risks are CRDT state bloat (mitigated by periodic compaction of the Automerge document) and attachment lifecycle consistency (ensuring the server can serve attachments when the client is offline or local files are lost). To test these early, implement a sync simulation that forces offline editing on two devices and verifies convergence. Additionally, load-test the attachment upload/download flow to ensure referential integrity between the metadata blob and the external files.

## Baseline answer

_qwen3.6:35b-mlx, asked for about 2600 words, used 231 of 4096 output tokens allowed under a $0.0000 cap, cost $0.0000. Board handles are shown here; the judge saw the answers with them removed._

Recommendation Summary: For on-device storage, use SQLite with a custom schema where each note is stored as plain text JSON containing an array of operations or a CRDT-enabled binary representation, while attachments are stored as files in a local directory with references in the database. For syncing, implement a CRDT-based (Conflict-free Replicated Data Type) approach using Yjs or Automerge for the text content, coupled with a custom file-transfer protocol like WebRTC direct peer-to-peer when on the same network, and a simple HTTP API for the future hosted service. Concurrent edits are reconciled automatically by the CRDT logic, ensuring no data loss; when conflicts arise, the user sees a merged view that preserves all textual contributions, with a UI indicator highlighting potentially ambiguous merges for manual review if necessary. The migration from 'no server' to 'hosted sync' involves building the local database and CRDT structures identically in both phases, so when the hosted service launches, it simply provides a new synchronization endpoint; existing users' data remains in the same local format, requiring no migration.

## Judgements

Swarm 83.3%, baseline 45.8%, winner swarm.

### Order 1: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 3 — Recommendates Automerge for text and file system for attachments, explicitly rejecting schema-heavy DBs by tying the decision to offline-first reliability and lightweight sync payloads. | 1 — Recommends SQLite with JSON/CRDT mixed storage but provides no rejected alternatives or reasoning tied to constraints. |
| conflicts | 3 | 2 — Explains CRDT merging and user-visible behavior but fails to discuss specific failure modes like attachment loss or long-term offline drift. | 2 — Describes automatic merging and user visibility but lacks detail on specific failure modes like deletes or offline duration. |
| migration | 3 | 3 — Provides a concrete path using client-side feature flags and direct blob uploads, addressing the 'no migration' constraint effectively. | 2 — Suggests identical local structures to avoid migration, which is a valid high-level path, though less concrete than A's blob approach. |
| correctness | 2 | 3 — The technical approach of decoupling text (CRDT) from attachments (files) is sound and fits the constraints of local-first architecture. | 1 — The suggestion to use WebRTC for sync alongside a server introduces significant complexity and potential correctness issues for a two-person team with no server currently. |
| risks | 2 | 2 — Identifies risks like state bloat and attachment consistency with tests, but lacks a specific fallback plan if these signals fire. | 0 — Does not name specific risks or early detection methods, failing the criteria entirely. |

> Answer A is better because it provides a specific, coherent technical recommendation (Automerge + Files) that directly addresses all constraints and success criteria, whereas Answer B is vague on storage alternatives and critically fails the 'risks' criterion.

### Order 2: A = baseline, B = swarm; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 3 — Answer B recommends Automerge (CRDT) for text and file system for attachments, explicitly rejecting monolithic storage to satisfy offline/attachment constraints, and justifying the separation for lightweight sync payloads. | 2 — Answer A recommends SQLite for storage but fails to tie this choice to specific constraints like offline-first reliability or attachment handling, merely listing alternatives without rejecting them based on the problem's specific offline/attachment requirements. |
| conflicts | 3 | 2 — It explains that Automerge merges based on causal order/device IDs and describes the user-visible behavior (text appearing in unexpected order) with a specific mitigation (conflict preview), though it misses detailing the failure mode for attachments or long offline periods. | 1 — It claims CRDTs ensure no data loss but fails to explain *how* edits are merged (mechanism) or specifically address what the user sees during conflicts beyond a vague 'merged view' and 'indicator', lacking the required detail on user-visible behavior. |
| migration | 3 | 3 — It details a concrete path using client-side feature flags and unique Document IDs to upload existing local state to the server, ensuring zero manual migration for users, and implicitly handles identity management. | 2 — It provides a concrete path where local DB structure matches future server needs, avoiding migration, but misses the nuance of how identity is established for the new service without disrupting existing users. |
| correctness | 2 | 2 — The technical claim that Automerge can serve as the local-first store while attachments are keyed externally is sound for a local-first architecture, though it simplifies the complexity of maintaining referential integrity between blob and file storage. | 1 — It claims storing notes as 'plain text JSON' inside SQLite while using CRDTs is a coherent technical approach, but this is technically inconsistent; CRDTs like Yjs/Automerge typically operate on binary or specific structured types, not raw plain text JSON which breaks the merge logic described. |
| risks | 2 | 2 — It identifies state bloat and attachment lifecycle consistency as risks with specific tests (sync simulation, load testing), but fails to provide a fallback plan if these signals fire, missing the third element of the top anchor. | 1 — It names no risks explicitly in the summary provided, failing to address the rubric requirement for identifying main risks and early detection methods. |

> Answer B is better overall because it provides a technically sounder and more constrained recommendation for storage (separating text CRDT from binary attachments) and offers a clearer migration path, whereas Answer A contains technical contradictions regarding data format and ignores the risks section entirely.
