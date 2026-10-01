// How Share Spots decide how often to send preview frames.
//
// The Host Console writes a small "I'm watching" doc (live/console) every
// HEARTBEAT_MS, plus which spot (if any) is focused. Share Spots listen to it:
//   * nobody watching  → no preview frames at all (saves the free-plan budget)
//   * watching         → one frame every NORMAL_MS
//   * focused spot     → one frame every FOCUS_MS, a bit sharper
//   * other spots while one is focused → BACKGROUND_MS
//
// Timing uses each device's own clock for "when did I last hear from you",
// so clock differences between devices don't matter.

export const CONSOLE_DOC = ['live', 'console'] as const;

export const HEARTBEAT_MS = 30_000;
export const WATCH_TIMEOUT_MS = 75_000; // spot stops if it hears nothing for this long
export const FOCUS_AUTO_OFF_MS = 2 * 60_000;

export const NORMAL_MS = 3_000;
export const FOCUS_MS = 1_000;
export const BACKGROUND_MS = 5_000;

export const FRAME = {
  normal: { width: 320, quality: 0.5 },
  focus: { width: 480, quality: 0.6 },
};

// Host side: a spot is "offline" if no update arrived for this long while watching.
export const OFFLINE_AFTER_MS = 15_000;

export interface ConsoleState {
  watching: boolean;
  focusSpot: string | null;
}
