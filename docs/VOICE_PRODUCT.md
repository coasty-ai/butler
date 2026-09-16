# Voice product contract

The subsequent Open Assist MVP specification narrows the user-facing product from the strategy PDF to the primary interaction: **hold a key → speak → release → watch the computer work**. Open Assist is the consumer app; CoArena is the intelligence/evaluation layer, and CoArena Gym packages reviewed workflows into environments and evaluations.

The app lives in the macOS menu bar. It shows a compact floating pill only while listening, working, paused, asking for approval, or briefly confirming completion. There is no dashboard, chat sidebar, model picker on the main surface, task builder, agent page, integration marketplace or prompt history on the main screen. Small settings and optional local review remain accessible through the tray. The browser page is an interactive preview, not the desktop's main screen.

## Interaction

1. Hold Option-Space. The native helper signals the controller's stop latch, emits the listening event and requests a haptic on supported hardware.
2. At 160 ms, start microphone capture and on-device streaming STT. Audio is never written to disk. Partial text is transient pill feedback.
3. Release. Stop audio, show “On it.” and wait up to 1.8 seconds for final recognition. If the recognizer sends an empty final marker after this endpoint, retain the latest nonempty hypothesis as a recovered command. Timeouts and recognition errors do not automatically submit partials. Recovered speech can never approve a pending consequential action.
4. Capture current screen context and begin the task. The model chooses one validated mouse/keyboard action at a time.
5. Hold again to interrupt. Final corrections revise the same run; stale in-flight responses cannot execute. “Wait” pauses; “Stop” cancels. Neither requires waiting for model inference.
6. Consequential/unknown actions show an approval. Click Yes or hold and say “yes.” Spoken approval must match the pending action from listening start and pass the final confidence gate. “Not yet” pauses the task.
7. “Done.” appears briefly, then the pill hides.

A short tap opens text entry; Command-Shift-Space provides a fallback. Escape and Control-Option-Escape are native stop controls during real runs. Escape also cancels ongoing speech. Manual mouse/keyboard input pauses the run; “continue” resumes from a fresh observation. With hands-free mode off, voice steering requires holding the shortcut. With optional “Hey Assist” enabled, the native helper listens locally for a phrase at the start of an utterance, opens the same pill, and submits after 1.3 seconds of stable recognition plus at least one second of audio silence. The command window times out after eight seconds without words and ends at 30 seconds. A nonempty final recognition normally supplies the command. An empty final after the explicit silence/release endpoint may recover the latest nonempty hypothesis; it is marked separately and cannot approve an action. Say the wake phrase again for corrections, stopping, and approval. Bare ambient “yes” cannot approve. The microphone remains active until disabled in the menu bar or the app quits. Existing settings migrate with this mode off.

## Data and measurement

Local encrypted records connect intent → action → finalized correction → revised action → outcome through one run ID and action index. Correction timestamps remain local. Per-run opt-in contribution can include sanitized task/action/correction text; raw audio is never included, and real desktop screenshots are excluded until image sanitization is implemented and validated. There is no default telemetry upload.

The proposed north-star metric is the number/share of active users initiating at least five real tasks from the shortcut per local day. Count a new task once; exclude tutorials, retries within a run, approval utterances and correction utterances. Track correction success, task completion and time to first useful action alongside it. Central collection and a users/day report are not implemented; they require a separate opt-in measurement design.

The <100 ms listening-feedback target is a target, not a measured result. Measure key-down→visible pill, key-down→audio-ready, release→final transcript, release→first action, and interrupt→last emitted input at p50/p95 on target Macs. Avoid speculative input before the user releases the key. The optional hands-free implementation uses rolling Apple on-device recognition, not a dedicated low-power wake-word model; wake latency, false activations and battery impact still require microphone testing.

No learned personal memory, proactive assistant, schedules, mobile app or integration platform is part of this MVP. Bounded current/recent context is included: app/window title, selection/static accessibility text, up to 12 open/recently observed windows, eight observed document basenames and the last three local tasks. This is first-observation context after release, not a continuous screen recorder or a system-wide recent-files index. Optional local TTS remains a follow-up; visual acknowledgments are implemented.
