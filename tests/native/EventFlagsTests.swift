import Foundation
import CoreGraphics

// Pure checks for the flags a posted event carries and for the session's
// modifier words (InputSafety.swift). Live 2026-09-20: from 05:37 PT every
// type_text into a Safari field lost its text (checkin-flight-seat 3/3 -> 0/4,
// booking-table-pause-before-confirm 3/3 -> 0/4) while the field's click read
// focused; at 12:15 PT the session's flags state read Fn held with the owner
// away, so each nil-source event had gone out as Globe+<char> or an Fn-click.
// postInput and postToTarget set every event's flags to postedFlags, so a
// held or stuck modifier never rides on the helper's own events.
func eventFlagsChecks(_ check: (Bool, String) -> Void) {
    let fn = CGEventFlags.maskSecondaryFn
    let stuck: CGEventFlags = [.maskSecondaryFn, .maskAlphaShift, .maskNumericPad, .maskNonCoalesced]
    // The typed character, the navigation key, the click: no modifiers, whatever the session holds.
    check(postedFlags(intended: [], created: fn) == [], "a typed character created under a held Fn goes out with no flags")
    check(postedFlags(intended: [], created: stuck) == [], "Fn, Caps Lock, the numeric pad and the coalescing bit inherited at creation are all dropped")
    check(postedFlags(intended: [], created: [.maskCommand, .maskShift]) == [], "a Command or Shift the person holds does not ride on a plain click or key")
    check(postedFlags(intended: [], created: []) == [], "nothing intended, nothing created: no flags")
    // A chord: exactly the requested set, on the down and the up alike.
    check(postedFlags(intended: .maskCommand, created: fn) == .maskCommand, "Command-L under a held Fn posts Command alone")
    check(postedFlags(intended: [.maskCommand, .maskShift], created: [.maskSecondaryFn, .maskControl]) == [.maskCommand, .maskShift],
          "a Command-Shift chord keeps both and takes neither the Fn nor the Control the session held")
    check(postedFlags(intended: [.maskControl, .maskAlternate], created: []) == [.maskControl, .maskAlternate], "Control-Option is posted as requested")
    check(postedFlags(intended: .maskCommand, created: .maskCommand) == .maskCommand, "an intended bit the session also holds is posted once, as intended")
    for flags in [CGEventFlags.maskCommand, .maskControl, .maskAlternate, .maskShift] {
        check(postedFlags(intended: flags, created: stuck) == flags, "each chord modifier survives a stuck session state on its own")
    }
    // Only the four chord modifiers can be intended: the helper never asks for Fn or Caps Lock.
    check(postedFlags(intended: [.maskCommand, .maskSecondaryFn], created: []) == .maskCommand, "an intended Fn is not posted: only the four chord modifiers are")
    check(postedFlags(intended: .maskAlphaShift, created: []) == [], "an intended Caps Lock is not posted")
    check(requestableModifiers == [.maskCommand, .maskControl, .maskAlternate, .maskShift], "the requestable set is CMD, CTRL, ALT and SHIFT (the chord names in `keys`)")
    check(postedFlags(intended: requestableModifiers, created: stuck) == requestableModifiers, "all four together survive whole")

    // The session's modifier words: fixed, ordered, one per bit, empty for none.
    check(modifierWords([]) == [], "no modifier held: an empty list")
    check(modifierWords(fn) == ["fn"], "the stuck Fn of 2026-09-20 reads as fn")
    check(modifierWords(CGEventFlags(rawValue: 0x20800000)) == ["fn"], "the raw flags state read that day (0x20800000) names fn and nothing else")
    check(modifierWords(.maskCommand) == ["command"], "Command alone")
    check(modifierWords(.maskShift) == ["shift"], "Shift alone")
    check(modifierWords(.maskAlternate) == ["option"], "Option alone")
    check(modifierWords(.maskControl) == ["control"], "Control alone")
    check(modifierWords(.maskAlphaShift) == ["capslock"], "Caps Lock alone")
    check(modifierWords([.maskShift, .maskCommand]) == ["command", "shift"], "two held: the fixed order, not the caller's")
    check(modifierWords([.maskAlphaShift, .maskControl, .maskAlternate, .maskShift, .maskCommand, .maskSecondaryFn]) == ["fn", "command", "shift", "option", "control", "capslock"], "all six in order")
    check(modifierWords([.maskNumericPad, .maskNonCoalesced, .maskHelp]) == [], "bits that are not modifiers name nothing")
    check(modifierWords(CGEventFlags(rawValue: UInt64.max)) == ["fn", "command", "shift", "option", "control", "capslock"], "every bit set names the six words and no other")
    let words = Set(modifierWordOrder.map { $0.word })
    check(words == ["fn", "command", "shift", "option", "control", "capslock"] && modifierWordOrder.count == 6, "the word list is the six fixed words, each once")
    check(modifierWordOrder.allSatisfy { $0.word == $0.word.lowercased() && $0.word.allSatisfy { $0.isLetter } }, "each word is lowercase letters: a code, never a sentence")
}
