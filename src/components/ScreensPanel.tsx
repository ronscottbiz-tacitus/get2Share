import React, { useEffect, useState } from 'react';
import { Monitor, Plus, Trash2, X } from 'lucide-react';
import { onSnapshot, updateDoc } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import { normalizePairingCode, formatPairingCode } from '../spotPairing';
import { claimScreen, LAYOUTS, removeScreen, ScreenConfig, ScreenLayout, screenPaths, TV_PATH } from '../screens';
import CloseButton from './CloseButton';

const ONLINE_MS = 3 * 60 * 1000;

type Row = ScreenConfig & { id: string };

/** Host Console: the event's TVs. Add one by its code, pick what it shows, pause or remove it. */
export default function ScreensPanel({ hostUid }: { hostUid: string }) {
  const { event } = useEvent();
  const [screens, setScreens] = useState<Row[]>([]);
  const [adding, setAdding] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    return onSnapshot(
      screenPaths.screens(event.id),
      (snap) => setScreens(snap.docs.map((d) => ({ id: d.id, ...(d.data() as ScreenConfig) }))),
      (err) => console.error('Screens listener error:', err)
    );
  }, [event.id]);

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    const c = normalizePairingCode(code);
    if (c.length !== 6) { setError('Enter the 6-character code shown on the TV.'); return; }
    const n = name.trim() || `Screen ${screens.length + 1}`;
    setBusy(true);
    setError('');
    try {
      await claimScreen(c, event.id, hostUid, n);
      setAdding(false);
      setCode('');
      setName('');
    } catch (err: any) {
      console.error('Add screen failed:', err);
      setError(
        err?.message === 'already-claimed'
          ? 'That screen is already connected to an event.'
          : "That code didn't work. Check it on the TV; codes change every 15 minutes."
      );
    } finally {
      setBusy(false);
    }
  };

  const update = (id: string, patch: Partial<ScreenConfig>) =>
    updateDoc(screenPaths.screen(event.id, id), patch).catch((e) => console.error('Screen update failed:', e));

  return (
    <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
      <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center justify-between">
        <span className="flex items-center gap-1.5">
          <Monitor className="w-4 h-4 text-g2-blue-light" /> Screens ({screens.length})
        </span>
        <span className="text-[10px] text-g2-muted font-medium normal-case tracking-normal">Smart TVs and big displays</span>
      </h3>

      {!adding ? (
        <button
          type="button"
          onClick={() => { setAdding(true); setError(''); }}
          className="w-full h-11 rounded-xl border border-dashed border-g2-blue/50 text-g2-blue-light hover:text-white hover:border-g2-blue hover:bg-g2-blue/10 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" /> Add a screen
        </button>
      ) : (
        <form onSubmit={handleAdd} className="bg-g2-panel border border-g2-blue/40 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">Add a screen</p>
            <CloseButton onClick={() => setAdding(false)} label="Cancel" size="sm" />
          </div>
          <p className="text-xs text-g2-secondary">
            On the TV's web browser, open <span className="font-mono text-white">{window.location.host}{TV_PATH}</span>. Enter the code it shows:
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div className="space-y-1">
              <label htmlFor="screen-code" className="text-[11px] font-bold uppercase tracking-wider text-g2-muted">Screen code</label>
              <input
                id="screen-code"
                type="text"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                placeholder="ABC 123"
                value={formatPairingCode(normalizePairingCode(code))}
                onChange={(e) => { setCode(normalizePairingCode(e.target.value)); setError(''); }}
                className="w-full h-11 px-3 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-white font-mono text-lg tracking-[0.15em] uppercase focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="screen-name" className="text-[11px] font-bold uppercase tracking-wider text-g2-muted">Name it</label>
              <input
                id="screen-name"
                type="text"
                maxLength={40}
                placeholder="e.g. Main Hall TV"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full h-11 px-3 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-white text-sm focus:outline-none"
              />
            </div>
          </div>
          {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={busy}
            className="w-full h-11 bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold text-xs rounded-lg cursor-pointer disabled:cursor-default"
          >
            {busy ? 'Connecting…' : 'Connect screen'}
          </button>
        </form>
      )}

      {screens.length === 0 && !adding && (
        <p className="text-xs text-g2-muted">
          No screens yet. Open {window.location.host}{TV_PATH} on any TV with a web browser, then add it here.
        </p>
      )}

      <div className="space-y-3">
        {screens.map((s) => {
          const seen = s.lastSeen?.toMillis?.() ?? null;
          const online = seen !== null && now - seen < ONLINE_MS;
          return (
            <div key={s.id} className="bg-black/30 border border-white/5 rounded-xl p-3.5 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-white truncate">{s.name}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[10px] text-g2-muted">
                    <span className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-g2-muted'}`} />
                    {online ? 'Online' : seen ? 'Offline' : 'Connecting…'}
                    {s.paused ? ' · paused' : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => removeScreen(event.id, s.id, s.pairingCode)}
                  aria-label={`Remove ${s.name}`}
                  title="Remove this screen"
                  className="p-2 text-g2-muted hover:text-red-300 hover:bg-red-500/10 rounded-lg cursor-pointer transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div role="group" aria-label={`What ${s.name} shows`} className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-g2-page">
                {LAYOUTS.map((l) => {
                  const on = s.layout === l.id;
                  return (
                    <button
                      key={l.id}
                      type="button"
                      title={l.hint}
                      aria-pressed={on}
                      onClick={() => update(s.id, { layout: l.id as ScreenLayout })}
                      className={`h-9 rounded-md text-xs font-bold cursor-pointer transition-colors ${on ? 'bg-white text-g2-page' : 'text-g2-secondary hover:text-white'}`}
                    >
                      {l.label}
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-1.5">
                {([
                  ['showQr', 'Scan-to-join code'],
                  ['showNames', 'Who took each photo'],
                  ['paused', 'Pause screen'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex items-center justify-between gap-2 px-2.5 h-9 rounded-lg bg-white/[0.03] border border-white/5 text-[11px] font-semibold text-g2-secondary cursor-pointer">
                    {label}
                    <input
                      type="checkbox"
                      checked={!!s[key]}
                      onChange={(e) => update(s.id, { [key]: e.target.checked } as Partial<ScreenConfig>)}
                      className="w-4 h-4 accent-[#0052FF]"
                    />
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
