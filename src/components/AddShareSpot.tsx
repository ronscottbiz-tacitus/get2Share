import React, { useEffect, useState } from 'react';
import { CheckCircle2, Plus, X } from 'lucide-react';
import { deleteDoc, doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { SpotPairing } from '../types';
import { PAIRING_TTL_MS, SPOT_SETUP_PATH, formatPairingCode, newPairingCode } from '../spotPairing';

/**
 * Host-only: name a Share Spot and get a one-time code to enter on the tablet.
 * The database only lets a device become a Share Spot by claiming one of these.
 */
export default function AddShareSpot() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState<SpotPairing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const setupUrl = `${window.location.host}${SPOT_SETUP_PATH}`;

  // Watch the code so we know the moment the tablet claims it.
  useEffect(() => {
    if (!code) return;
    const unsub = onSnapshot(
      doc(db, 'spotPairings', code),
      (snap) => setPairing(snap.exists() ? (snap.data() as SpotPairing) : null),
      (err) => console.error('Pairing listener error:', err)
    );
    return () => unsub();
  }, [code]);

  // Countdown tick while a code is waiting.
  const waiting = !!code && !pairing?.claimedBy;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [waiting]);

  // Close a few seconds after the tablet connects.
  useEffect(() => {
    if (!pairing?.claimedBy) return;
    const t = setTimeout(() => reset(), 4000);
    return () => clearTimeout(t);
  }, [pairing?.claimedBy]);

  const reset = () => {
    setOpen(false);
    setName('');
    setCode(null);
    setPairing(null);
    setError('');
  };

  const createdMs = pairing?.createdAt?.toMillis?.() ?? null;
  const msLeft = createdMs ? createdMs + PAIRING_TTL_MS - now : PAIRING_TTL_MS;
  const expired = waiting && msLeft <= 0;
  const mmss = `${Math.max(0, Math.floor(msLeft / 60000))}:${String(Math.max(0, Math.floor((msLeft % 60000) / 1000))).padStart(2, '0')}`;

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    const spotName = name.trim();
    if (!spotName) {
      setError('Name it after where it will stand, like "Photo Wall".');
      return;
    }
    setBusy(true);
    setError('');
    try {
      // Retry on the (very unlikely) chance a code is already taken.
      for (let attempt = 0; attempt < 3; attempt++) {
        const candidate = newPairingCode();
        const ref = doc(db, 'spotPairings', candidate);
        try {
          const taken = await getDoc(ref);
          if (taken.exists()) continue;
          await setDoc(ref, { spotName, createdAt: serverTimestamp(), claimedBy: null });
          setNow(Date.now());
          setCode(candidate);
          return;
        } catch (err) {
          if (attempt === 2) throw err;
        }
      }
    } catch (err) {
      console.error('Create pairing failed:', err);
      setError("Couldn't create a code. If this keeps happening, republish the database rules in Firebase.");
      handleFirestoreError(err, OperationType.CREATE, 'spotPairings');
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (code && !pairing?.claimedBy) {
      deleteDoc(doc(db, 'spotPairings', code)).catch(() => {});
    }
    reset();
  };

  const handleNewCode = async () => {
    if (code) deleteDoc(doc(db, 'spotPairings', code)).catch(() => {});
    setCode(null);
    setPairing(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full h-11 rounded-xl border border-dashed border-g2-blue/50 text-g2-blue-light hover:text-white hover:border-g2-blue hover:bg-g2-blue/10 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
      >
        <Plus className="w-4 h-4" aria-hidden="true" /> Add a Share Spot
      </button>
    );
  }

  return (
    <div className="bg-g2-panel border border-g2-blue/40 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-condensed font-extrabold text-xs tracking-[0.12em] uppercase text-g2-blue-light">
          Add a Share Spot
        </p>
        <button
          type="button"
          onClick={handleCancel}
          aria-label="Cancel"
          className="p-1 rounded-md text-g2-tertiary hover:text-white hover:bg-white/5 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {!code && (
        <form onSubmit={handleCreate} className="space-y-2.5">
          <label htmlFor="new-spot-name" className="block text-xs text-g2-secondary">
            Where will it stand? Guests will see this name.
          </label>
          <div className="flex gap-2">
            <input
              id="new-spot-name"
              type="text"
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              maxLength={30}
              autoFocus
              placeholder="e.g. Photo Wall, Bar Patio"
              className="flex-1 min-w-0 h-11 px-3 bg-g2-page border border-white/10 focus:border-g2-blue rounded-lg text-sm text-white placeholder-g2-muted focus:outline-none"
            />
            <button
              type="submit"
              disabled={busy}
              className="h-11 px-4 bg-g2-blue hover:bg-g2-blue-hover disabled:opacity-60 text-white font-bold text-xs rounded-lg cursor-pointer disabled:cursor-default"
            >
              {busy ? 'Creating…' : 'Get code'}
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>
      )}

      {code && pairing?.claimedBy && (
        <div className="flex items-center gap-2.5 py-2" aria-live="polite">
          <CheckCircle2 className="w-6 h-6 text-emerald-400 shrink-0" aria-hidden="true" />
          <p className="text-sm text-white">
            <span className="font-bold">{pairing.spotName}</span> is connected.
          </p>
        </div>
      )}

      {code && !pairing?.claimedBy && !expired && (
        <div className="space-y-2.5" aria-live="polite">
          <p className="text-xs text-g2-secondary">
            On the Share Spot device, open <span className="font-mono text-white">{setupUrl}</span> and enter:
          </p>
          <p className="font-mono font-bold text-4xl tracking-[0.25em] text-white text-center py-2 bg-g2-page rounded-lg border border-white/10">
            {formatPairingCode(code)}
          </p>
          <div className="flex items-center justify-between text-[11px] text-g2-muted">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-g2-blue-light animate-pulse" />
              Waiting for “{name.trim()}” to connect…
            </span>
            <span className="font-mono">Expires in {mmss}</span>
          </div>
        </div>
      )}

      {expired && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-amber-300">That code expired.</p>
          <button
            type="button"
            onClick={handleNewCode}
            className="h-9 px-3 bg-white/5 hover:bg-white/10 border border-white/10 text-white text-xs font-bold rounded-lg cursor-pointer"
          >
            Get a new code
          </button>
        </div>
      )}
    </div>
  );
}
