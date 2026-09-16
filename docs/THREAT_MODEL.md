# Threat model

Assets: local prompts/screenshots, provider keys, input authority, encryption keys, consent receipts, contributed bundles and provenance.

| Threat | Current control | Residual work |
|---|---|---|
| Model/page prompt injection | Strict action vocabulary; consequential/unknown inputs confirmed; local AX allow-list; blocked credentials/clipboard; no shell/DOM/filesystem tools | Semantic destination detection, unsafe editable surfaces and adversarial live testing |
| Misheard voice or stale correction | Local STT after hold/wake activation; endpointed commands; recovered hypotheses cannot approve; pending-action/confidence checks for approval; native interrupt and inference epoch | Signed device testing, background speakers, accents/noise; no speaker authentication |
| Malformed/stale action | Zod strict unions, finite normalized bounds, frame ID, application/geometry/fresh-screen checks in native helper | Real multi-monitor/window-move test matrix |
| Provider hangs or renderer stalls | Abort signal, native process stop latch and event tap; input cleanup | Native drag/input interruption under CPU load; signed permissions QA |
| Secret capture | Protected-app exclusions; sensitive-input takeover; no screenshots during takeover | OCR and sensitive multi-window/browser coverage; avoid sensitive work in alpha |
| Provider exfiltration/routing | Direct configured HTTPS; local mode literal loopback only; redirects refused; cloud Ollama IDs rejected | Malicious local proxy cannot be constrained by this client; production egress audit |
| Renderer compromise | Sandbox/context isolation, narrow IPC, sender/frame validation, no navigation, restrictive CSP | CSP for dev deliberately allows local React refresh; dependency and release review |
| Journal theft/corruption | OS-wrapped master key, GCM authentication, per-event chain/sequence, encrypted frames, truncated-tail recovery | Key rotation, tail-rollback resistance, cryptographic erasure and backup policy |
| Silent/incomplete upload | Separate opt-in path, checksum-bound consent, per-chunk verification and final receipt | Production identity, concurrency and quotas |
| Ingest compromise/abuse | Loopback binding, possession tokens, encrypted quarantine, request/object limits, seven-day expiration | KMS/least privilege, per-user quotas, review workers, authenticated deployment |
| Consent withdrawal gaps | Verified deletion endpoint; exact approved bundle used for export | Derivative/backup deletion and synthetic release review |
| Forged Gym result | Exact fixture/distractor state and GUI vocabulary check | Trusted execution/trace provenance, richer graders and held-out variants |

Trust boundaries: renderer → IPC/main → policy → native controller/OS; main → chosen model provider; separate consent/review → contribution endpoint; quarantine → analyst → synthetic task registry. No automatic raw-data release crosses the final boundary.
