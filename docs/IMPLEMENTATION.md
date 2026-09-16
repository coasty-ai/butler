# What is built and what remains

| PDF deliverable | Implemented here | Remaining before production beta |
|---|---|---|
| Architecture inventory | Empty-repo inventory and read-only inspection of nearby Python prototype | Integrate the original Open Cowork repo if supplied |
| Threat model | Concrete boundaries and residual risks documented | Independent security review |
| Voice-first Mac product | Menu-bar app, native hold/tap shortcut, floating pill, terse status, hidden settings/review | Signed device validation, measured latency and polish |
| On-device streaming speech | Apple Speech/AVAudioEngine helper; push-to-talk/optional wake capture; partial feedback; endpointed commands with empty-final recovery; no cloud fallback | Locale/model availability, accents/noise, mic denial/revocation, permission attribution on signed app |
| Interrupt/revise | Native stop on shortcut-down, same-run corrections, late-response invalidation, scoped final voice approval | Stress testing at every action boundary and live correction success metrics |
| User takeover / Escape | Native unmarked input pauses; tagged agent events are ignored; Escape cancels speech/run; takeover event journaled | Live mixed-input, held modifiers, drag interruption and cursor-priority matrix |
| Current context | Screenshot; app/window; selected/static accessibility text; bounded open/recently observed windows and document names; last three local tasks | Complete application coverage, invocation-time prefetch, richer recent-file discovery and permission QA |
| Privacy modes | Private local/BYOM; explicit no-network local endpoint rules; no telemetry sender | Provider-side policy review; optional telemetry opt-in; sponsored routing |
| Provider-neutral protocol | Strict schemas for all 15 action types, bounds, keys and frame IDs | Vendor-native specialized computer-use translation and live matrix |
| macOS controller | Swift ScreenCaptureKit + CGEvent + local AX safety; protected-app capture exclusions; monitor geometry; native stop latch | Signed permission flows; live device/Retina/multi-monitor/drag interruption QA |
| Windows/Linux | Controller interface and explicit unsupported status | Native adapters and packaging |
| Run loop | Capture, observe, validate, policy, approve, execute, fresh screenshot; cancellation, corrections and budgets | Long-horizon reliability study |
| Safety | Local AX allow-list for known editing/navigation; consequential controls require approval; unidentified targets retry before takeover; protected surfaces; credentials/clipboard blocked; fresh-state checks | Wider semantic coverage and adversarial live evaluation |
| Encrypted recorder | AES-256-GCM files; OS-wrapped master key; chained events; interrupted-tail recovery; delete | Rotation, configurable retention, backup-aware erasure and stronger rollback resistance |
| Review/consent | Per-run level selection, exact bundle preview, frame/action exclusion, unchecked consent | Production consent policy and identity/account rights workflows |
| Sanitization | Local text regex detectors; raw native frames blocked from contribution | OCR, rectangle redaction, contextual PII review and validated image sanitization |
| Ingest | Local encrypted quarantine, versioned consent, chunk checksums, resume, commit receipt, withdrawal, seven-day expiry | Authentication/rate limits, database/object store/KMS, distributed concurrency, queue and backup deletion |
| Telemetry | Strict allow-list schema and tests; sender absent | Explicit opt-in and privacy network audit in a packaged release |
| Gym | Exact-approved-bundle exporter; seeded task-board fixtures and grader | Runnable VM/app orchestration, analyst console, 25+ validated families, anti-cheating and held-out tasks |
| Documentation | README, developer guide, privacy/security drafts, resources and test record | Publish reviewed policies and operator runbooks |

The tutorial is scripted, not model-driven; it demonstrates the run loop and consent UX without requiring credentials or capturing real content. Real provider calls and macOS actuation require explicit configuration and OS permissions. Successful tutorial tests must not be interpreted as a live desktop reliability result.

The model sees screenshots, the user task/corrections, compact action/result history and bounded current/recent context. Local safety hit-test metadata is excluded from provider observations. No shell, DOM, file tool, arbitrary accessibility API or clipboard is exposed to the model.

Safety limitations matter: domain discovery is best effort, screenshots can include sensitive content outside the foreground app, and arbitrary desktop UI is not fully understood by deterministic policy. Protected applications are excluded from ScreenCaptureKit capture, but other visible content can remain in a screenshot. Latency and live task-completion targets have not been measured.

There is no dashboard, chat sidebar, workflow builder, agent configuration page, learned personal memory, proactive mode, scheduling, mobile app or integration marketplace. A bounded recent-task context supports the updated specification without a separate memory system. The Gym and ingest code remain internal developer tools inherited from the PDF scope. Optional spoken TTS is not implemented; acknowledgments appear in the pill.
