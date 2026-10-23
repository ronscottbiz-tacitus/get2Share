import { Timer } from 'lucide-react';
import { fmtMs, stepDurations, useJoinTimings, waitingMs } from '../joinTiming';

/** Host Console: how long each guest waited to get into the event, step by step. */
export default function JoinSpeedPanel({ eventId, enabled }: { eventId: string; enabled: boolean }) {
  const rows = useJoinTimings(eventId, enabled);
  return (
    <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-3">
      <div>
        <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
          <Timer className="w-4 h-4 text-g2-blue-light" /> Join speed
        </h3>
        <p className="mt-1 text-[11px] text-g2-muted">
          How long each phone waited to get in, not counting typing a name. Slow steps are highlighted.
        </p>
      </div>
      {rows.length === 0 ? (
        <div className="p-4 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
          No joins recorded yet. They appear here as guests open the gallery.
        </div>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const wait = waitingMs(r.steps || {});
            const steps = stepDurations(r.steps || {}).filter((s) => s.key !== 'joined');
            return (
              <li key={r.id} className="p-3 bg-black/30 border border-white/5 rounded-xl">
                <div className="flex justify-between items-baseline gap-2">
                  <span className="font-bold text-sm text-white truncate">{r.nickname}</span>
                  {wait !== null && (
                    <span className={`font-mono text-sm font-bold shrink-0 ${wait > 10000 ? 'text-red-400' : wait > 4000 ? 'text-amber-300' : 'text-emerald-300'}`}>
                      {fmtMs(wait)}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 font-mono text-[10.5px] text-g2-muted truncate">
                  {[r.device, r.network !== 'unknown' ? r.network : '', r.notes?.signIn ? `sign-in ${r.notes.signIn}` : '',
                    r.at?.toMillis ? new Date(r.at.toMillis()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '']
                    .filter(Boolean).join(' · ')}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {steps.map((s) => (
                    <span
                      key={s.key}
                      className={`px-1.5 py-0.5 rounded-md font-mono text-[10px] ${s.ms > 3000 ? 'bg-amber-400/15 text-amber-200' : 'bg-white/5 text-g2-secondary'}`}
                    >
                      {s.label} {fmtMs(s.ms)}
                    </span>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
