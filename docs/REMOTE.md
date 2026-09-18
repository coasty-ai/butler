# Phone remote (tailnet)

A small page your phone opens over your own Tailscale network to see what Open Assist is doing, send it plain-language instructions, stop, pause and continue, and, for phones you allow, approve routine steps. It replaces nothing: voice and the Mac's own pill keep working, and texted iMessage steering stays as a fallback. Off by default.

## What it is not

- Not on the internet. The server listens only on this Mac's Tailscale addresses (100.64.0.0/10 and fd7a:115c:a1e0::/48), never on 0.0.0.0, loopback or the LAN. Open Assist never runs `tailscale serve` or `tailscale funnel`, and refuses to start if either is configured on its port.
- Not a way around approvals. A phone can approve only "routine" questions (opening, quitting, benign navigation), the same set a follow-up "yes" without the wake phrase may answer. Sending, saving, deleting, paying, installing, signing in, settings, running programs, protected sites, blind surfaces and coding-agent requests are approved only on the Mac.
- Not a model channel for control. Stop, pause, continue, approve and skip are deterministic. Free text goes through the same router as typed text (`planVoiceTurn` with source `"remote"`); "yes" from a phone never approves.

## Transport

`electron/remote/server.ts` binds `remotePort` (default 41680) on each Tailscale address `src/remote/auth.ts#bindAddresses` finds, and nowhere else. Peers reach it only through WireGuard from nodes the coordination server admitted, so the peer address is authenticated and the daemon's `whois` for it is authoritative.

- **HTTPS** when Tailscale reports a certificate domain (MagicDNS and HTTPS Certificates on in the admin console): the certificate for `<mac>.<tailnet>.ts.net` is requested through the LocalAPI `cert` endpoint or the `tailscale cert` CLI, stored sealed with the vault key as `remote-cert.enc`, and renewed when under 14 days remain. The request runs in the background with its own two-minute timeout (a first DNS-01 issuance can take a minute): the page binds over plain HTTP at once and rebinds with TLS when the certificate arrives. A failed request is retried after an hour, three times, then daily; the old certificate keeps serving until it expires. This is what iOS needs for a padlock, a Home Screen web app and (phase 2) the microphone.
- **Plain HTTP inside the tailnet** otherwise. WireGuard already encrypts the path; the page works, the cookie is not marked `Secure`, and Settings says why. Turn on HTTPS Certificates to move to HTTPS; the watchdog picks it up within a minute.

Identity comes from `electron/remote/tailscale.ts`: the Standalone build's LocalAPI (`/Library/Tailscale/ipnport` and `sameuserproof-<port>`, readable by admin users) or the CLI at a fixed path (`/usr/local/bin/tailscale`, Homebrew, or the App Store bundle with `TAILSCALE_BE_CLI=1`). `whois` runs once per socket and again every five minutes on a long-lived stream. Without either, the remote stays off and Settings says so.

## Who may connect

`src/remote/auth.ts#access`, checked before any route:

| Peer | Result |
|---|---|
| No whois answer, or an address outside the Tailscale ranges | 403 |
| This Mac's own node (a browser on the Mac) | 403 |
| A tagged node (a server, no person) or a node shared in from another tailnet | 403 |
| A different Tailscale login than `remoteUser` (pinned to this Mac's login on first start) | 403 |
| The right login on a phone not yet allowed | "Not allowed yet" page; the phone appears in Settings with every switch off |
| A phone with "Allow control" on | The page, a session and the event stream |

Pairing is Mac-only: the phone is already authenticated by Tailscale, and the switch in Settings is the consent. There is no code, QR or pairing route on the phone side. At most 12 phones are remembered; unallowed ones are pruned least-recently-seen first.

## What a phone can do

- **Control** (one switch): stop, pause, continue, plain-language instructions, "What are you doing?", and Skip on any pending approval (a skip only pauses).
- **Approve routine steps** (second switch, needs the first): Approve for questions `src/remote/auth.ts#remoteApprovalTier` calls `routine`. The tier is `never` for anything `followUpApprovalAllowed` refuses, anything matching `NEVER_BY_PHONE`, "I can't see" questions, "Change this setting?", and coding-agent relays; `never` questions show "Approve this one on the Mac" and no button.

Every approval also needs, in `approvalVerdict` order: the device not locked out (three replayed, forged or cross-device nonces in ten minutes lock approvals for an hour; a stale gate, the ordinary race with the Mac answering first, never counts), the gate the phone saw to be the gate pending now, a single-use nonce issued to that device for that gate (ten-minute life, withdrawn when the gate changes), the tier and the device's switches, and nobody at the Mac (`presence !== "present"`). Only an answer that goes through spends the nonce: a tap refused for the tier, the switches or presence leaves the same card good for the retry once the reason has passed. `electron/main.ts#approveFromRemote` re-checks the gate and the tier before calling `runner.approveFromVoice(yes, "remote")`, and the runner restores and revalidates the screen before acting, as for any voice approval.

Instructions from a phone become a run with `origin: "remote"` and `taskSource: "user_words"`; the pill says "From your phone." and never the text. Credentials in a line are refused before the router sees them.

## Protocol

| Route | Needs | Body / result |
|---|---|---|
| `GET /` | control | The page, with `Content-Security-Policy: default-src 'none'; script-src 'nonce-…'; style-src 'nonce-…'; connect-src 'self'; img-src 'self' data:; …`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` |
| `GET /manifest.webmanifest` | control | Home Screen manifest with an inline icon |
| `GET /api/session` | control | `{ token, device: { name, control, approve }, mac: { name }, screenshots, mic: false }` and the `oa_remote` cookie (`HttpOnly; SameSite=Strict; Path=/api`, `Secure` over HTTPS) |
| `GET /api/events` | cookie | Server-sent events: `status` (the view), `progress`, `reply`, `notice`, `ping` every 20 s; at most 2 streams per phone, 6 in all |
| `POST /api/say` | cookie + header | `{ text ≤ 2000 }` → `{ plan, reply }` |
| `POST /api/control` | cookie + header | `{ kind: stop \| pause \| continue }` → `{ ok, reply }` |
| `POST /api/approve` | cookie + header | `{ gate, nonce, answer: approve \| skip }` → `{ verdict, reply }` |
| `POST /api/ask` | cookie + header | `{ kind: "status" }` → `{ reply }` |
| `GET /api/frame/<id>.jpg` | cookie | The thumbnail for the frame the last `status` named, or 404 |
| `POST /api/audio` | cookie + header | Phase 2 stub: 501 |

Every request must carry a `Host` naming this Mac (its MagicDNS name or one of its tailnet addresses, with the remote's port or none); anything else is answered 421 before any route, so a site whose DNS is pointed at this Mac (rebinding) can never become same-origin with the page in the phone's browser. Every POST must also carry `Origin` equal to one of those names on this port (never the request's own Host reflected back), `Content-Type: application/json`, `Sec-Fetch-Site: same-origin` when present, and `X-Remote-Token` equal to the cookie; no CORS headers are ever sent, so a page elsewhere cannot make the call. Bodies over 4 KB are refused before parsing; per-phone limits are 10 lines a minute (60 an hour), 20 controls and 6 approvals a minute, 30 thumbnails a minute; 16 sockets in all; unauthenticated peers get 10 tries a minute per address.

The view (`src/remote/protocol.ts#remoteView`) is built from the same `RunView` voice and texts use: status, task line, minutes, steps, app, the run's question, the last six step lines ("typed 12 characters"), queued tasks, the last finished task, presence, and for a pending approval the policy question (`speakableApproval`) plus the shape of the step (`pendingWhat`: a label, a menu path, "typing 8 characters", never the text). It never carries a screenshot, screen text, a full address or path, or a credential.

## Screenshots

Off by default. "Blurred layout only" serves a 24-pixel mosaic of the current frame scaled back to 360 pixels wide as a JPEG: layout and colour, no readable text. Only for the frame id the last `status` named, only to allowed phones, never pushed, never stored anew. No frame exists during takeover, secure input or protected surfaces, so nothing is served then.

## Settings

`remoteEnabled` (off), `remotePort` (41680; never 41641), `remoteUser` ("" until pinned), `remoteScreenshots` (`off` | `thumbnail`), `remoteDevices` (id, name, control, approve, firstSeen, lastSeen; at most 12). Device switches are applied the moment they are ticked through `setRemoteDevice` and `forgetRemoteDevice`; a settings save never carries the list, so it cannot go stale. "Lock phone remote now" in Settings and in the menu bar cuts every phone off, revokes every session and turns the remote off.

## Setup

1. Install the Standalone Tailscale build on the Mac (tailscale.com), Tailscale from the App Store on the phone; sign both in to the same account. In the admin console turn on MagicDNS and HTTPS Certificates (DNS page).
2. Settings › Phone remote → on. The status line shows the `http` address at once and moves to `https` when the first certificate arrives (a minute or so). `tailscale serve status` should print nothing.
3. On the phone with Tailscale connected, open the address in Safari: "Not allowed yet". On the Mac, tick "Allow control" for the phone; reload.
4. Tick "Approve routine steps" only if you want to answer opening and quitting questions from the phone. Send-type and delete-type questions stay on the Mac whatever you tick.
5. Share › Add to Home Screen for a full-screen app.

Lost your phone? Lock the remote (Settings or menu bar), then remove the device in the Tailscale admin console. Until you lock it, an unlocked phone with an allowed device can stop, steer and routine-approve.

## Traces and storage

Traces are content-free: `RemoteRequest { route, httpStatus, durationMs, device }`, `RemoteDenied { cause }`, `RemoteApproval { verdict, tier, device }`, `RemoteSay { plan, textLength }`, `RemoteSse { code, device }`, `RemoteTailscale { kind, state }`. `device` is `d` plus 8 hex of the node id's SHA-256. Never text, logins, addresses, tokens or nonces.

Stored: the settings above and the phone list in the encrypted config; the certificate sealed as `remote-cert.enc`; a line that starts or corrects a run becomes task or correction text in encrypted run history, as a typed task does. Sessions and nonces live in memory only.

## Deliberate limits

There is no route for any of these, so a phone can never: change a setting, pair or unpair itself, arm approvals, read history, diagnostics, keys, screen text or typed text, open a protected app (the policy floor is unchanged), or reach the Settings window.

## Phase 2: talking from the phone

`POST /api/audio` answers 501 today and the page hides the button. The plan: a hold-to-talk button recording at most 15 seconds with `MediaRecorder` (`audio/mp4`), uploaded to the Mac, transcribed on-device by the voice helper, then deleted; the transcript goes through `say` with the recognizer's confidence and never approves. Safari's Web Speech API is not used: its audio goes to Apple's servers.

## Unconfirmed

Read from the Tailscale sources and docs, not run against a live daemon: whether the Standalone same-user token grants the `cert` endpoint (the CLI is the fallback); the LocalAPI path for the serve config (`serve-config`, with `tailscale serve status --json` as the fallback); first-issuance time for the certificate. `tests/remote-*.test.ts` cover the rules, the parsers and the server against a fake daemon; a Mac and phone on one tailnet are needed to confirm the rest.
