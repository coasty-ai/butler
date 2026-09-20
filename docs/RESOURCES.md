# Resources required

## To use this build now

| Resource                | Needed for               | Requirement / planning allowance                                                                                                                                                                                                        |
| ----------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS computer          | Native capture and input | macOS 14+, Apple Silicon tested for compilation. Start with 16 GB RAM and 5 GB free disk for development; local models need additional memory/storage.                                                                                  |
| Node and build tools    | Build from source        | Node 22.12+; Node 24 recommended. npm and Xcode Command Line Tools. Not needed to launch the packaged `.app`.                                                                                                                           |
| OS permissions          | Live desktop use         | Screen Recording and Accessibility; Microphone and Speech Recognition for push-to-talk; Input Monitoring if macOS requests it. The tutorial needs none of these.                                                                        |
| On-device speech        | Voice commands           | macOS Speech support for the selected system language, an available local recognition model, and a working microphone. No transcription API key or cloud STT subscription. Text input remains available if local speech is unsupported. |
| Vision model            | Real agent decisions     | Either a locally downloaded Ollama vision model, or your own provider API key. No model training or GPU server is needed for the tutorial or BYOM.                                                                                      |
| Local model capacity    | Private-local mode       | Budget 16–32 GB unified memory for experimenting with a quantized 7–8B vision model, and 10–20 GB additional disk. These are planning allowances, not measured performance guarantees. Larger models require more.                      |
| Provider key + model ID | Cloud inference          | OpenAI, Anthropic, Gemini or an OpenAI-compatible provider. Confirm image/function-call support and account access. Configure token prices and a provider-side spend cap.                                                               |
| Local disk              | Encrypted run history    | User controlled, per-run deletion. At 30 compressed frames × 250 KB, plan around 7.5 MB/run before metadata and encoding overhead. Actual PNGs can be larger.                                                                           |
| Additional backend      | Core private assistant   | None. No CoArena login, cloud database or ingest service is required.                                                                                                                                                                   |
| Interface assets        | Monochrome UI and motion | Space Grotesk is bundled locally under SIL OFL 1.1. The icon and animations are native/vector/CSS assets; no paid font, image service or animation service is required.                                                                 |

Ollama documents base64 image input and supported vision models in its [vision guide](https://docs.ollama.com/capabilities/vision). Hardware capacity depends on model, quantization and context length; benchmark the selected model before committing to devices.

## To enable contributions beyond local development

The included loopback ingest service is enough to exercise the full protocol locally. For a beta, provision:

- An authenticated HTTPS API, initially around 2 vCPU / 4 GB RAM; benchmark before scaling. The reference service intentionally binds to loopback and must not simply be exposed to the internet.
- Encrypted object storage with per-object checksums, quarantine and sanitized-data separation, lifecycle expiry and restricted access.
- A database for consent versions, upload manifests, object references, receipts, deletion jobs and retention status. PostgreSQL is a reasonable production target; it is not a dependency of this alpha.
- A job queue and separate workers for image OCR/redaction, quarantine review, retention and deletion propagation.
- A managed key service or secret manager, access auditing, rate limits, request quotas and backup/restore/deletion procedures. The alpha's single environment key needs rotation and per-tenant/per-object key management before production.
- A domain, TLS certificates and operational monitoring that excludes task content and secrets.
- A reviewed contribution policy, retention policy, incident process and privacy/security review. The PDF specifically calls for privacy/provenance review before any dataset publication and an EU-facing DPIA assessment. Counsel must confirm the actual obligations for the deployment.

Planning estimate for an early, low-volume beta: **$100–500/month for backend infrastructure**, excluding inference, staff, security review and human data review. This is a capacity/budget assumption, not a vendor quote or a provisioned service.

For storage context, R2 Standard lists **$0.015/GB-month**, plus operations. 10,000 runs × 7.5 MB = about 75 GB, or about $1.13/month in capacity before free allowances, request charges and processing. Do not use storage capacity alone as the full backend estimate. [Cloudflare R2 pricing, checked September 2026](https://developers.cloudflare.com/r2/pricing/)

## Inference budget

BYOM means users pay their provider; local mode uses their hardware. CoArena has no inference bill for those paths. Sponsored inference is not enabled.

Use this formula rather than the PDF's model-price examples:

`cost/run = input_tokens × input_price_per_million / 1,000,000 + output_tokens × output_price_per_million / 1,000,000`

Illustrative assumption: 200,000 aggregate input tokens and 10,000 output tokens, with rates of $2/M input and $10/M output, cost **$0.50/run**. These rates are deliberately hypothetical, not a current model quote. At 100 sponsored users × 3 runs/day × 30 days that would be **$4,500/month**. Measure actual screenshot/context usage and retry overhead before offering credits. This client only estimates token cost; an in-flight call can exceed its cap.

## To ship a signed desktop beta

- Apple Developer membership, Developer ID signing certificate and notarization access. Apple lists **US$99/year**, varying by region. These credentials have not been requested or added. [Apple enrollment](https://developer.apple.com/programs/enroll/)
- macOS CI/release runner, secure signing secrets, native-helper signing, SBOM/dependency scanning, release artifacts and a signed update channel.
- Signed microphone/audio-input entitlements for the app and helper as required by the final hardened-runtime layout; verify macOS permission attribution in the signed package. The local development package is not a notarized release.
- At least two Macs or test configurations for Retina/external displays, multiple monitor origins, permission denial/revocation, window movement and app restart. Test built-in and external microphones, accents, quiet/noisy rooms, unsupported language models, background speech and shortcut conflicts. Add Intel hardware if Intel support is promised.
- Windows and Linux test machines plus native input/capture implementations before claiming those platforms are supported.

## Team and remaining effort

For the focused **voice MVP**, start with **two engineers** (macOS/audio/input and agent/product), shared design/QA, and a security review. Budget **4–6 weeks of hardening and device testing** as an initial planning allowance, subject to the first live-task reliability results. Prioritize speech latency, safe interruption during input, foreground restoration, actual task completion and signed delivery. No backend engineer or contribution service is required for a private local/BYOM pilot. This estimate is a planning judgment, not a completion guarantee.

The report's full 12-week beta needs sustained product engineering and data operations. A reasonable planning team is:

| Role                             | Allocation        | Main work                                                                                                       |
| -------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Desktop/native engineer          | 1 full-time       | Audio/STT, push-to-talk latency, permissions, capture, input, interruption, multi-monitor QA, signed packaging. |
| Agent/product engineer           | 1 full-time       | Provider-native computer-use adapters, run reliability, safety UX, live-provider evaluation.                    |
| Backend/data engineer            | 1 full-time       | Production ingest, key management, OCR/quarantine, consent/deletion/retention.                                  |
| Gym/environment engineer         | 0.5–1 full-time   | Synthetic workflows, runnable environments, hidden-state graders and held-out variants.                         |
| Design/QA                        | 0.5 shared        | Usability, accessibility, 100-run reliability matrix and beta feedback.                                         |
| Security and privacy specialists | Milestone reviews | Threat-model review, dependency/release review, data governance and launch review.                              |

Treat **3–4 engineers for roughly 8–12 weeks**, plus shared design/QA and specialist reviews, as a planning range to reach the PDF's beta criteria from this alpha. It is not an estimate that the entire strategy is already complete. Existing Open Cowork code and reusable CoArena Gym infrastructure could reduce this effort after integration review.

The next inputs for the voice pilot are an enabled provider/model or installed local vision model, OS permission grants, and testing on the intended Macs/languages. A signing account is needed for distribution. Contribution hosting and an existing Open Cowork repository are optional follow-on inputs. No secret needs to be pasted into chat; configure it in the application or deployment secret store.

The local speech contract uses Apple's [`supportsOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognizer/supportsondevicerecognition) and [`requiresOnDeviceRecognition`](https://developer.apple.com/documentation/speech/sfspeechrecognitionrequest/requiresondevicerecognition). Actual availability and recognition latency must be checked on each target device/language.
