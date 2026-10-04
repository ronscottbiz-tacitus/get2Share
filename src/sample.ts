// The "See a sample party" demo: a fictional event, every photo AI-generated.
// Static and read-only: nothing here touches the database.

export const SAMPLE_PATH = '/sample';

export const SAMPLE_EVENT = {
  name: "Mina's 30th",
  subtitle: 'Rooftop night · Downtown LA',
  startsAt: '7:30 PM',
};

export interface SamplePhoto {
  id: string;
  src: string;
  /** Who took it: a guest handle, a Share Spot, or a Group Shot. */
  by: string;
  kind: 'guest' | 'spot' | 'group';
  alt: string;
  /** Minutes after the party started (oldest first). */
  minute: number;
  w: number;
  h: number;
}

/** Oldest first. */
export const SAMPLE_PHOTOS: SamplePhoto[] = [
  { id: "m18", src: "/sample/mina30-18.jpg", by: "@mina", kind: "guest", alt: "Guests arrive past the Get2Share sign", minute: 0, w: 967, h: 1200 },
  { id: "m01", src: "/sample/mina30-01.jpg", by: "@dee", kind: "guest", alt: "G2 hugs Aaliyah as she arrives", minute: 9, w: 967, h: 1200 },
  { id: "m02", src: "/sample/mina30-02.jpg", by: "@zuri", kind: "guest", alt: "Marco scans the Get2Share QR card", minute: 18, w: 967, h: 1200 },
  { id: "m07", src: "/sample/mina30-07.jpg", by: "@mina", kind: "guest", alt: "Jake and Aaliyah laughing at the bar", minute: 27, w: 967, h: 1200 },
  { id: "m05", src: "/sample/mina30-05.jpg", by: "@zuri", kind: "guest", alt: "Zuri selfie with G2 photobombing", minute: 36, w: 967, h: 1200 },
  { id: "m24", src: "/sample/mina30-24.jpg", by: "@mina", kind: "guest", alt: "Taco bar", minute: 45, w: 967, h: 1200 },
  { id: "m14", src: "/sample/mina30-14.jpg", by: "@aaliyah", kind: "guest", alt: "Jake laughing", minute: 54, w: 967, h: 1200 },
  { id: "m16", src: "/sample/mina30-16.jpg", by: "@g2", kind: "guest", alt: "Zuri and Mina clink glasses", minute: 63, w: 967, h: 1200 },
  { id: "m13", src: "/sample/mina30-13.jpg", by: "@dee", kind: "guest", alt: "Marco taps the Share Spot, crew rushes in", minute: 72, w: 967, h: 1200 },
  { id: "m04", src: "/sample/mina30-04.jpg", by: "Spot \u00b7 Photo Wall", kind: "spot", alt: "The crew posing at the Share Spot", minute: 81, w: 967, h: 1200 },
  { id: "m03", src: "/sample/mina30-03.jpg", by: "@aaliyah", kind: "guest", alt: "G2 dancing on the LED floor", minute: 90, w: 967, h: 1200 },
  { id: "m17", src: "/sample/mina30-17.jpg", by: "@zuri", kind: "guest", alt: "Marco busts a move, G2 hypes him up", minute: 99, w: 967, h: 1200 },
  { id: "m15", src: "/sample/mina30-15.jpg", by: "@mina", kind: "guest", alt: "Aaliyah dancing", minute: 108, w: 967, h: 1200 },
  { id: "m19", src: "/sample/mina30-19.jpg", by: "@marco", kind: "guest", alt: "G2 teaches the crew a step", minute: 117, w: 967, h: 1200 },
  { id: "m09", src: "/sample/mina30-09.jpg", by: "@jake", kind: "guest", alt: "G2 at the DJ booth", minute: 126, w: 967, h: 1200 },
  { id: "m08", src: "/sample/mina30-08.jpg", by: "@marco", kind: "guest", alt: "The crew points at the TV photo wall", minute: 135, w: 967, h: 1200 },
  { id: "m12", src: "/sample/mina30-12.jpg", by: "@zuri", kind: "guest", alt: "G2 cracking up at Marco", minute: 144, w: 967, h: 1200 },
  { id: "m20", src: "/sample/mina30-20.jpg", by: "@aaliyah", kind: "guest", alt: "A toast", minute: 153, w: 967, h: 1200 },
  { id: "m06", src: "/sample/mina30-06.jpg", by: "@marco", kind: "guest", alt: "Mina blows out her 30 candle", minute: 162, w: 967, h: 1200 },
  { id: "m22", src: "/sample/mina30-22.jpg", by: "@marco", kind: "guest", alt: "Mina hugs G2", minute: 171, w: 967, h: 1200 },
  { id: "m10", src: "/sample/mina30-10.jpg", by: "Group Shot \u00b7 14 phones", kind: "group", alt: "Group Shot with a ring of phones", minute: 180, w: 967, h: 1200 },
  { id: "m25", src: "/sample/mina30-25.jpg", by: "@g2", kind: "guest", alt: "A Share Spot clamped to the railing", minute: 189, w: 967, h: 1200 },
  { id: "m21", src: "/sample/mina30-21.jpg", by: "Spot \u00b7 Dance Floor", kind: "spot", alt: "Overhead view of the dance floor", minute: 198, w: 1200, h: 944 },
  { id: "m23", src: "/sample/mina30-23.jpg", by: "Spot \u00b7 Skyline", kind: "spot", alt: "The crew at the rooftop edge", minute: 207, w: 967, h: 1200 },
  { id: "m11", src: "/sample/mina30-11.jpg", by: "@aaliyah", kind: "guest", alt: "Late night on the couches", minute: 216, w: 967, h: 1200 },
];

export function sampleTime(minute: number): string {
  const total = 19 * 60 + 30 + minute;
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}
