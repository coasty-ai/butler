/**
 * Media and device controls the user names a thing for: "pause the video",
 * "stop the music", "resume the podcast", "mute this", "skip the ad", "turn
 * the volume down", "stop the timer". Pause, stop and resume are Butler's
 * own controls only when they stand alone or refer to it or the task
 * ("pause", "hold on", "stop it", "resume the task"), and the router settles
 * those before any model is asked. Said of a thing that plays, sounds,
 * records or counts down, they are a task on that thing, for the run whose
 * model sees the same screen. The dialog model read one as Butler's own
 * (live 2026-09-19 07:09Z: "Pause the current video" with nothing running
 * was answered "Nothing's running"), so these words are recognised before
 * it is asked (fastStart) and its pause or resume is never honoured for them
 * (arbitrate). There is no media key to press instead: the native helper's
 * key table (native/macos/Controller.swift) has none, so the run presses
 * the player's own control.
 */
import { intentKey } from "../voice/turns";

const wordSet = (list: string) => new Set(list.split(/\s+/).filter(Boolean));

/** Request frames before the verb: "can you pause the video", "just mute it". */
const LEAD = wordSet(
  "can could would will you please just now also then and go ahead",
);
/**
 * Verbs that are Butler's own control, or nothing in particular, until a
 * thing is named: "pause the video" but not "pause it"; "turn the volume
 * down" but not "turn it down", which the model reads.
 */
const NEEDS_THING = wordSet(`
  pause stop cancel resume continue unpause restart start play end halt turn lower raise crank
`);
/** Verbs that are never Butler's own: their object may be a pointer or nothing ("mute", "skip this"). */
const MEDIA_VERBS = wordSet("mute unmute skip rewind replay");
/** What plays, sounds, records, counts down or transfers on the screen. */
const THINGS = wordSet(`
  video videos music song songs track tracks tune tunes playlist album podcast podcasts episode episodes
  movie movies film show stream livestream audio sound sounds playback player playing recording clip
  trailer ad ads advert adverts advertisement commercial commercials preview tv radio station volume
  speaker speakers headphones mic microphone camera webcam sharing screenshare youtube spotify netflix
  vlc quicktime twitch soundcloud tidal pandora hulu plex timer alarm stopwatch download downloads
  upload uploads call
`);
/** Words between the verb and its thing: "pause the current video", "turn down the volume", "stop what's playing". */
const BETWEEN = wordSet(`
  the this that these those my our a an current currently next previous last whatever whats what is it
  its of on in for up down off back
`);
const DIRECTIONS = wordSet("up down");
const ORDER = wordSet("next previous");

/**
 * Whether words are a media or device control on a thing of its own
 * ("pause the video", "stop the music in Spotify", "skip this ad", "volume
 * down", "next track"), never Butler's own pause, stop or resume ("pause",
 * "stop it", "resume the task", "hold that thought"), a control on the
 * task's own subject ("pause the flights search") or a question about a
 * thing ("is the music still playing").
 */
export function mediaCommand(text: string): boolean {
  const words = intentKey(text).split(" ").filter(Boolean);
  let at = 0;
  while (at < words.length && LEAD.has(words[at])) at++;
  const verb = words[at];
  if (!verb) return false;
  if (MEDIA_VERBS.has(verb)) return true;
  if (words.length === 2 && at === 0) {
    if (verb === "volume" && DIRECTIONS.has(words[1])) return true;
    if (ORDER.has(verb) && THINGS.has(words[1])) return true;
  }
  if (!NEEDS_THING.has(verb)) return false;
  for (const word of words.slice(at + 1)) {
    if (THINGS.has(word)) return true;
    if (!BETWEEN.has(word)) return false;
  }
  return false;
}
