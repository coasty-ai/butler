# observer-worklog.json

Five synthetic weekdays of observer frames and owner actions in the shapes of `.data/design/observer.md` §2, for lane O3's measurement: `scripts/observer-eval.mjs` runs the consolidator over it and scores what it recovers; `tests/observer-eval.test.ts` pins what is planted. Everything in it is invented: the bundle ids are real applications', the window title stems, hosts (`example.com`, `example.org`, `example.net`) and control labels are made up. No text digest, no image (tier `structure`), no keystroke characters: typing is a field label and a count, as the design writes it.

Rebuild it with the builder beside it (a seeded generator, so the file is reproducible and the test checks it has not drifted):

```sh
node tests/fixtures/observer-worklog.build.mjs > tests/fixtures/observer-worklog.json
npx prettier --write tests/fixtures/observer-worklog.json
```

## Shape

```jsonc
{
  "version": 1,
  "timezone": "America/Los_Angeles", // the owner's clock; atMs is epoch ms
  "utcOffsetMinutes": -420, // fixed for the week (PDT)
  "tier": "structure",
  "days": [
    {
      "day": "2026-09-14",
      "weekday": 1,
      "rows": [/* frames and actions, in time order */],
    },
  ],
  "planted": {
    "routines": [],
    "procedures": [],
    "preferences": [],
    "decoys": [],
  },
}
```

A row is either a frame (`event: "observe_frame"`, `atMs`, `appId`, `appName`, `windowTitle?`, `host?`, `focusedRole?`, `focusedLabel?`, `controls`) or an action (`event: "observe_action"`, `atMs`, `appId`, `kind`, and one of `target`, `chord`, `typed`, `scroll`, `menu` by kind). An excluded frame (`excluded`) carries nothing but `appId` (`own_run`: only `runId`; `locked` and `idle`: nothing). Frames are event-driven (an app switch, a title change, a sheet opening) plus one every ten minutes of dwell; the cadence is thinned against the design's 20 s so the file stays reviewable. The `planted` block is the truth the scorer reads; `src/gym/observer-eval.ts` `worklogSchema` validates the whole file.

## Days

Monday 2026-09-14 to Friday 2026-09-18, roughly 08:50 to 17:45 local, a lunch gap around noon (an `idle` frame, then nothing until ~13:00), a `locked` frame at the end of each day.

## What is planted

**One routine: `morning-triage`.** Every weekday the owner switches to Slack (`com.tinyspeck.slackmacgap`), then Mail (`com.apple.mail`), then Linear (`com.linear`), in that order, starting between 08:52 and 09:03 and lasting about twenty minutes. Truth: apps `[slack, mail, linear]`, weekdays 1-5, `hourRange [8, 10]`. A found routine recovers it when those three apps are an ordered subsequence of its steps (at most one extra app), its hour window touches 8-10 within an hour, and any weekday it names is a weekday.

**Two procedures.**

- `file-receipt`, four runs (Mon 10:40, Tue 14:15, Wed 11:05, Fri 15:20), one slot (the vendor: Acme Cloud, Northwind Hosting, Contoso Print, Fabrikam Domains). Steps as observed: in Mail, `double_click` the attachment `Receipt - {vendor}.pdf` (the label carries the slot, so the truth leaves it open); Preview comes to the front (a frame, no owner switch); `menu_item` File › Export…; `typing` in the field "Export As"; `click` the "Where" pop-up; `menu_item` "Receipts"; `click` "Save". Then a switch back to Mail (not part of the procedure).
- `weekly-report`, three runs (Mon 16:30, Wed 16:45, Fri 16:20), no slot: `app_switch` to Numbers (`com.apple.iWork.Numbers`, "Weekly metrics"); `menu_item` File › Export To › PDF…; `click` "Next…"; `typing` in "Save As"; `click` "Export"; `app_switch` to Mail; `key_chord` CMD+N; `typing` in "To", "Subject" and "Message"; `click` "Send".

Each run's `fromMs..toMs` is recorded under `runs`, and the test checks the planted steps appear in order inside every run and that the distinctive menu items appear exactly as often as the runs.

**One contradiction: `docs-browser`.** `docs.example.com` ("Runbook · Docs", "Deploy checklist · Docs") is opened in Safari on Monday to Wednesday and in Google Chrome (`com.google.Chrome`) from Thursday 2026-09-17 on, once or twice a day. News and wiki reading stays in Safari all week, so the preference is about that host, not the browser in general. Truth: subject `docs.example.com`/`docs`, earlier `Safari`, later `Chrome`, `flipDay 2026-09-17`. A preference on the subject that names Chrome is the later value; one that names only Safari is stale.

## Noise and decoys

- Terminal sessions at varying hours every day (typing bursts in "Terminal", the odd CMD+T), 20-60 minutes of dwell.
- News (`news.example.org`) and wiki (`wiki.example.net`) reading in Safari at varying hours, with scrolls and "Read more"/"Back" clicks.
- Notes ("Standup notes") typing bursts, Finder visits (Downloads › Documents, an occasional right-click on `brief.pdf`), Calendar checks ("Today"), an end-of-day Slack glance on three days.
- `music-messages`: Music (Play) then Messages (a typed burst and "Send") on Tuesday 15:00 and Thursday 13:30 only. Two days at different hours is not a routine; a consolidator that reports it has invented one.
- Exclusions: `secure_input` during a sign-in at `accounts.example.com` (Tue 13:45, Thu 10:20; two frames each carrying only Safari's id), `protected` (Keychain Access, Wed 15:30, the id only), `own_run` (Mon 14:05, `runId` only), `idle` at lunch and `locked` at the end of every day.

## Targets (design §7)

Routine recall ≥ 0.8; at most one invented routine per five days; at most 200,000 input tokens of consolidation per day. `src/gym/observer-eval.ts` `TARGETS` carries them and `scripts/observer-report.mjs` prints the token target against a real log.
