# Storage and sync for a local-first notes app

Chosen as the swarm's widest win. Problem `local-first-sync`.

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

_Run `01a1c3a6-ae1a-7a0a-9973-580a9e4f22f0`, 12 rounds, completed/budget_rounds, $0.0000, confidence 0.75._

Recommend using Automerge as the core CRDT engine for text state and IndexedDB for local binary storage of attachments. This architecture satisfies the offline-first constraint by ensuring full data persistence on-device, while the CRDT logic handles concurrent edits without requiring a central server initially. To mitigate the risk of state bloat identified in C20, separate 10 MB attachments as BLOBs in IndexedDB keyed by content hash, storing only the metadata hashes within the Automerge document (supported by H21 and E24). This keeps sync payloads small and delta-based.

For synchronization, adopt a 'Lazy Server' pattern using a unified binary protocol. Initially, devices can sync via a local LAN exchange or file-system broker (H14), treating this transport as a drop-in replacement for the future hosted service. The hosted service will simply accept the same Automerge binary updates (Frankencode) via an HTTP API endpoint, requiring zero client-side migration logic (H22). This approach avoids the NAT traversal issues of WebRTC without servers (E27) and eliminates the drift risks associated with multi-source history accumulation in a broker model (C21).

Handle concurrent edits by relying on Automerge’s automatic merging for text, but implement a 'Conflict Preview' UI for high-divergence notes. When significant divergence is detected (many delimiters), present the user with options to resolve conflicts manually rather than silently merging (H23). To address the critical risk in C22 regarding 'ghost conflicts', ensure the UI explicitly renders conflict markers or provides a diff view before the final state is committed, allowing users to clean up artifacts that would otherwise persist in the CRDT state.

Primary risks include CRDT state bloat on large documents with long edit histories and the complexity of maintaining a zero-migration sync protocol. Mitigation involves implementing periodic 'squash' operations for finalized notes and validating the lazy server interface early. The team can find out if these risks are real by building a 'sync simulator' (H6) that tests concurrent editing on simulated devices, measuring memory usage against Automerge’s vector clock growth (E25) and verifying that the unified binary format persists correctly through a simulated server switch.

## Baseline answer

_qwen3.6:35b-mlx, 4096 output tokens allowed under a $0.0000 cap, cost $0.0000._

Recommendation: For on-device storage, use SQLite with CRDT-based text synchronization (specifically Yjs or Automerge) for the note content, and a local file system reference for attachments. For syncing, implement a conflict-resolving sync protocol using CRDTs that operates over any transport layer, initially targeting no-server mode via local peer-to-peer discovery (e.g., mDNS/local network) or manual file export/import, with a pre-planned architecture to swap in a hosted server backend later without changing the client-side logic.

The primary alternative for text storage—plain files or simple JSON—is rejected because it lacks built-in conflict resolution capabilities, making concurrent edits on two devices extremely difficult to handle without data loss. Another alternative, using a full distributed database like SQLite + WAL with custom merge logic, is rejected because implementing robust, conflict-free replicated data types (CRDTs) from scratch is error-prone and time-consuming for a two-person team. CRDT libraries like Yjs or Automerge provide proven, battle-tested algorithms for handling concurrent edits and merging changes automatically, ensuring no text is lost even when devices are offline.

For attachments, store them as local files in a dedicated directory with their filenames recorded in the SQLite database. This avoids bloating the database and allows easy synchronization later since file transfer protocols can be reused or adapted from the existing sync infrastructure. Attachments are treated as opaque blobs, while the text content is the only part requiring complex versioning and conflict resolution.

Reconciliation of concurrent edits is handled entirely by the CRDT library. When two devices edit the same note offline, the CRDT ensures that all changes are eventually consistent and no data is lost by using unique identifiers for each character or operation. When the devices finally sync (via local network or later via hosted server), the CRDT merges the edits deterministically. The user sees a unified view of the text with all their edits preserved; there is no need for manual conflict resolution prompts because the algorithm handles it invisibly in the background.

The migration path from 'no server' to 'hosted sync service' involves designing the sync layer as an abstract interface (e.g., SyncEngine) that exposes methods like fetchUpdates() and pushChanges(). Initially, this interface is implemented using local file sharing or manual backups for the no-server phase. When adding the hosted service, you simply implement a new backend API endpoint and update the SyncEngine to use HTTP/WebSocket calls to the server instead of local reads/writes. Since the data format (SQLite + CRDT state) remains unchanged, users do not need to migrate their data manually; they just configure the app to point to the new server URL.

The main risks are: 1) Performance degradation with large notes or many attachments on mobile devices due to heavy CRDT computation; 2) Complexity in implementing a reliable no-server sync mechanism (local network discovery, bandwidth throttling, error handling); 3) Security and privacy concerns when moving to hosted sync without proper encryption. To find out early if these bite: a) Benchmark CRDT operations on actual mobile hardware with large notes during the prototyping phase; b) Build a minimal local-network sync proof-of-concept first to validate feasibility before investing in the server backend; c) Design the data schema with end-to-end encryption in mind from day one, even if the no-server mode doesn't use it, so that transitioning to a hosted service doesn't require a painful data reshuffle.

For conflict resolution visibility, since CRDTs handle merges automatically, the user typically sees no explicit 'conflict' interface. However, if a conflict is visually apparent (e.g., duplicated text due to edge cases in merge logic), provide an in-app 'History' or 'Undo Stack' feature that allows users to revert specific changes. This approach minimizes cognitive load while providing a safety net. Ensure that the UI clearly indicates when a note has been updated by a peer device, but avoid interrupting the user with complex merge dialogs.

The recommendation ensures offline functionality by design: all data is stored locally in SQLite and local files, with no dependency on network availability for core editing. The CRDT-based sync works seamlessly over any transport, allowing the transition from no-server to hosted service to be a backend change only, preserving user data integrity and eliminating manual migration efforts.

## Judgements

Swarm 75.0%, baseline 72.2%, winner tie.

### Order 1: A = swarm, B = baseline; preferred swarm

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 3 — Recommendation is specific (Automerge + IndexedDB), rejects alternatives with reasons tied to constraints (bloat/NAT issues for P2P, server drift), and fits the offline/attachment requirements. | 2 — Recommends SQLite + CRDT library but lacks the depth of justification for why this specific combination is superior to others relative to the 'no server' constraint compared to A's more targeted reasoning. |
| conflicts | 3 | 2 — Explains automatic merging but introduces a 'Conflict Preview' UI which is plausible; however, it fails to explicitly address the specific failure modes for attachments or deletes mentioned in the top anchor. | 1 — States CRDTs merge automatically and users see no conflict, which ignores the prompt's requirement for what the user sees when they *do* conflict (e.g. text loss risks), offering only a vague 'history' fallback. |
| migration | 3 | 3 — Proposes a concrete path (Lazy Server/Unification) where the client logic remains identical, allowing zero-migration switching via protocol compatibility. | 2 — Proposes an abstract sync interface pattern which works logically, but is less concrete about the data format identity than A's binary protocol unification. |
| correctness | 2 | 2 — The technical claims regarding CRDTs and storage are sound, but references to 'C20'/'H21' appear to be hallucinations or uncited internal notes rather than grounded technical facts. | 2 — Technically sound advice on using CRDTs and SQLite, though less precise about the limitations of handling large binary attachments within the sync stream context. |
| risks | 2 | 3 — Names specific risks (state bloat, protocol complexity) and provides concrete early tests (sync simulator, memory benchmarking) with a fallback mentioned (squash operations). | 2 — Names risks (performance, complexity) and provides early tests (benchmarks, PoC), but lacks specific fallback strategies if those signals fire. |

> Answer A is better because it addresses the 'conflicts' criterion with a more realistic UI strategy (previewing conflicts rather than hiding them) and offers a more concrete, low-friction migration path (protocol unification vs abstract interface). Answer B's claim that users see no conflict interface is technically weak for a system expected to handle significant divergent edits without data loss.

### Order 2: A = baseline, B = swarm; preferred baseline

| Criterion | Weight | Swarm | Baseline |
|---|---|---|---|
| storage | 2 | 2 — Recommends Automerge (text) and IndexedDB (binary) but includes irrelevant citations like 'C20' and 'H21' which suggests hallucinated context or poor formatting rather than clear reasoning tied to constraints. | 3 — Recommends SQLite for text storage with explicit rejection of plain files based on offline conflict resolution needs, addressing the two-developer constraint by leveraging proven libraries. |
| conflicts | 3 | 3 — Details a specific 'Conflict Preview' UI for high-divergence notes and addresses 'ghost conflicts', providing clear user-visible behavior for conflicts. | 2 — Explains automatic merging via CRDTs but fails to address what users see for conflicts beyond a generic history feature, lacking specific details on attachment handling or offline divergence visibility. |
| migration | 3 | 2 — Describes a 'Lazy Server' pattern with zero migration but relies on vague concepts like 'Frankencode' and lacks the concrete interface abstraction detail found in Answer A. | 3 — Provides a concrete path using an abstract sync interface that allows swapping local P2P/file transport for hosted HTTP without data migration, meeting the zero-migration constraint. |
| correctness | 2 | 0 — Contains material errors and hallucinations, such as referring to 'Frankencode' (not a standard term) and citing non-existent sections like H21/C20/E24, making the technical advice unreliable. | 2 — Technically sound in combining SQLite with CRDT logic, though slightly complex to implement for a small team compared to simpler CRDT-native stores. |
| risks | 2 | 2 — Identifies state bloat risks and suggests a sync simulator test, but the reliability is undermined by the factual errors in the correctness criterion. | 3 — Identifies performance risks and provides specific early tests like benchmarking on mobile hardware and building a local sync PoC, with a fallback of encryption design. |

> Answer A is better because it provides grounded, standard technical recommendations without hallucinated references, whereas Answer B contains nonsensical terms and fake citations that violate correctness constraints.
