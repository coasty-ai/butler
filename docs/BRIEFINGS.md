# Periodic briefings

In **Settings → Briefings**, enable **Give me regular briefings**, choose an
interval (5 minutes to 24 hours), and save. The default is every 30 minutes,
with a spoken briefing and a readable copy. Notifications or both forms of
delivery are also available. **Check now** uses the saved settings. The menu
bar's **Your latest briefing…** opens the copy and its source coverage.

Butler checks app names and available window titles without screenshots,
window activation, clicks or keyboard input. Browser window titles are omitted
from these periodic checks. The notification switch starts a banner observer
between tasks; it cannot reconstruct earlier or silent notifications from
Notification Center. Up to 200 observed banners are held in memory for 24 hours;
a check includes at most 100 new ones. Protected app notifications are excluded.
The cursor advances after a successful banner read, so a failed helper or
canceled briefing does not discard the previous interval's notifications.

Calendar and Reminders follow their existing opt-in and macOS grants. Unread
Mail uses the consented Apple tool when enabled. Calendar/Reminders tools can
also supply those sources when the separate agenda opt-in is off. These reads
are bounded summaries; they are not complete copies of the apps' databases.

Other apps need connections in **Tools**. Under **Connected app checks**, add
an enabled read tool and its query arguments. The server must allow unattended
reads. Arguments are saved by the owner rather than generated from app content;
`{{today}}` and `{{tomorrow}}` use the owner's local date, while `{{since}}` and
`{{now}}` provide ISO timestamps. This allows rolling inbox, Slack or other
app queries without a planning-model call at every interval. Tool schemas,
credential checks, pins, protected paths/websites and privacy gates still
apply. Writes and tools requiring a question never run in a briefing.

Reads start together, with independent deadlines. A stalled connection leaves
the other sources usable. A single text-model call then summarizes priorities
and suggests next steps, using at most 16,000 input characters and 500 output
tokens. Foreground conversation and task starts cancel background inference.
Checks and delivery wait while Butler is busy and while the Mac is locked or
asleep; returning from sleep produces one due check rather than a backlog.
The configurable daily token allowance applies to the current app session.
With no model, a failed model, or an exhausted allowance, a local factual recap
is still available. Source text and replies are bounded and redact detected
secrets. App data is untrusted information, never an instruction to execute.

The latest briefing and banner buffer are in memory and disappear at quit;
**Clear latest** removes the copy and cancels an in-flight check. Changing
privacy, sources or protections invalidates the previous copy. A suggested
action becomes a normal task only when the owner asks for it.

**Discuss this briefing** uses the existing conversational path. The dated
recap travels with that conversation for up to 24 hours, with bounded text and
verification codes removed. Fresh questions still need fresh reads. The JARVIS
personality now reaches the dialog model as well as speech: composed British
phrasing, understated warmth and occasional dry wit. The automatic system voice
prefers British English independently of the owner's recognition language;
explicit voice choices are preserved. Installed voices and the selected engine
determine the actual sound.
