import { JOIN_STEPS, fmtMs, timingOverlayOn, useJoinMarks } from '../joinTiming';

/** ?timing=1: a small live readout of each join step, for testing on a real phone. */
export default function JoinTimerOverlay() {
  if (!timingOverlayOn()) return null;
  return <Readout />;
}

function Readout() {
  const { marks, notes, now } = useJoinMarks();
  let prev = 0;
  const next = JOIN_STEPS.find((s) => marks[s.key] === undefined);
  return (
    <div
      className="fixed left-2 bottom-2 z-[200] w-[200px] rounded-xl bg-black/85 border border-white/15 p-2.5 font-mono text-[11px] leading-[1.5] text-white pointer-events-none"
      style={{ marginBottom: 'env(safe-area-inset-bottom)' }}
      aria-hidden="true"
    >
      <p className="font-bold text-g2-blue-light mb-1">Join timer</p>
      {JOIN_STEPS.filter((s) => marks[s.key] !== undefined).map((s) => {
        const at = marks[s.key]!;
        const d = at - prev;
        prev = at;
        return (
          <p key={s.key} className={`flex justify-between ${d > 3000 ? 'text-amber-300' : ''}`}>
            <span>{s.label}</span><span>+{fmtMs(d)}</span>
          </p>
        );
      })}
      {next && next.key !== 'joined' && (
        <p className="flex justify-between text-white/60"><span>{next.label}…</span><span>{fmtMs(now - prev)}</span></p>
      )}
      {notes.signIn && <p className="mt-1 text-white/50">sign-in: {notes.signIn}</p>}
    </div>
  );
}
