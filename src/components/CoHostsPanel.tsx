import React, { useEffect, useState } from 'react';
import { Users, UserPlus, Copy, Check, Share2, X } from 'lucide-react';
import { onSnapshot } from 'firebase/firestore';
import { useEvent } from '../EventContext';
import {
  HOST_INVITE_HOURS, HostClaim, HostInvite, MAX_COHOSTS, cancelHostInvite, createHostInvite,
  hostInviteExpiry, hostInviteUrl, paths, removeCohost,
} from '../events';

type InviteRow = HostInvite & { token: string };

function timeLeft(ms: number) {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}

/** Host Console: who helps run this event. The owner invites co-hosts with a one-time link
 *  and can remove them; co-hosts see the list. */
export default function CoHostsPanel({ uid, isAdmin = false }: { uid: string; isAdmin?: boolean }) {
  const { event } = useEvent();
  const isOwner = isAdmin || event.ownerUid === uid;
  const [claims, setClaims] = useState<Record<string, HostClaim>>({});
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    return onSnapshot(
      paths.hostClaims(event.id),
      (snap) => {
        const next: Record<string, HostClaim> = {};
        snap.forEach((d) => { next[d.id] = d.data() as HostClaim; });
        setClaims(next);
      },
      (err) => console.error('Co-host list error:', err)
    );
  }, [event.id]);

  useEffect(() => {
    if (!isOwner) { setInvites([]); return; }
    return onSnapshot(
      paths.hostInvites(event.id),
      (snap) => setInvites(snap.docs.map((d) => ({ token: d.id, ...(d.data() as HostInvite) }))),
      (err) => console.error('Co-host invites error:', err)
    );
  }, [event.id, isOwner]);

  const cohosts = (event.hostUids || []).filter((h) => h !== event.ownerUid);
  const open = invites
    .filter((i) => !i.claimedBy && hostInviteExpiry(i) > now)
    .sort((a, b) => hostInviteExpiry(b) - hostInviteExpiry(a));
  const room = MAX_COHOSTS - cohosts.length - open.length;

  // Links that ran out without being used are just clutter: clear them quietly.
  useEffect(() => {
    if (!isOwner) return;
    invites
      .filter((i) => !i.claimedBy && i.createdAt && hostInviteExpiry(i) <= now)
      .forEach((i) => { cancelHostInvite(event.id, i.token).catch(() => {}); });
  }, [invites, now, isOwner, event.id]);

  const handleInvite = async () => {
    if (busy || room <= 0) return;
    setBusy(true);
    setNote('');
    try {
      await createHostInvite(event, uid);
    } catch (e) {
      console.error('Creating a co-host invite failed:', e);
      setNote("Couldn't make an invite link. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async (token: string) => {
    const url = hostInviteUrl(event.id, token);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 2000);
    } catch {
      setNote(`Copy this link: ${url}`);
    }
  };

  const handleShare = async (token: string) => {
    const url = hostInviteUrl(event.id, token);
    try {
      await navigator.share({ title: `Co-host ${event.name}`, text: `Help me run "${event.name}" on Get2Share. This link works once, for ${HOST_INVITE_HOURS} hours.`, url });
    } catch { /* closed the share sheet */ }
  };

  const handleCancel = async (token: string) => {
    try {
      await cancelHostInvite(event.id, token);
    } catch (e) {
      console.error('Cancelling the invite failed:', e);
      setNote("Couldn't cancel that link. Try again.");
    }
  };

  const handleRemove = async (hostUid: string, label: string) => {
    if (!window.confirm(`Remove ${label} as a co-host? They lose access to this event's Host Console.`)) return;
    try {
      await removeCohost(event.id, hostUid);
      setNote(`${label} is no longer a co-host.`);
    } catch (e) {
      console.error('Removing the co-host failed:', e);
      setNote("Couldn't remove them. Check your connection and try again.");
    }
  };

  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  return (
    <div className="glass-card border border-white/5 rounded-2xl p-5 shadow-lg space-y-4">
      <div className="flex justify-between items-center gap-2">
        <h3 className="text-sm font-extrabold uppercase tracking-wider text-g2-tertiary flex items-center gap-1.5">
          <Users className="w-4 h-4 text-g2-blue-light" /> Co-hosts ({cohosts.length})
        </h3>
        {isOwner && (
          <button
            type="button"
            onClick={handleInvite}
            disabled={busy || room <= 0}
            className="text-[10px] bg-g2-blue/15 hover:bg-g2-blue/25 border border-g2-blue/40 text-g2-blue-light font-bold px-2.5 py-1 rounded-lg flex items-center gap-1 cursor-pointer transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <UserPlus className="w-3 h-3" /> {busy ? 'Making a link…' : 'Invite a co-host'}
          </button>
        )}
      </div>

      <p className="text-[11px] text-g2-tertiary leading-relaxed">
        Co-hosts can approve photos, remove guests, and run Share Spots, TVs and Flash.
        {isOwner ? ' Only you can add or remove co-hosts and delete the event.' : ' Only the event owner can add or remove co-hosts.'}
      </p>

      {cohosts.length === 0 && open.length === 0 ? (
        <div className="p-4 bg-black/30 border border-white/5 rounded-xl text-center text-g2-muted text-xs">
          No co-hosts yet.
        </div>
      ) : (
        <div className="space-y-2">
          {cohosts.map((h) => {
            const c = claims[h];
            const label = c?.name || c?.email || 'Co-host';
            return (
              <div key={h} className="flex items-center justify-between gap-3 bg-black/30 border border-white/5 px-3 py-2 rounded-lg">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white truncate">{label}{h === uid ? ' (you)' : ''}</p>
                  {c?.email && c.name && <p className="text-[10px] text-g2-muted truncate">{c.email}</p>}
                </div>
                {isOwner && (
                  <button
                    type="button"
                    onClick={() => handleRemove(h, label)}
                    className="text-[10px] bg-white/5 hover:bg-red-500/10 hover:text-red-300 border border-white/10 text-g2-secondary font-bold px-2.5 py-1 rounded-lg cursor-pointer transition-colors shrink-0"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}

          {open.map((i) => (
            <div key={i.token} className="bg-black/30 border border-g2-blue/20 px-3 py-2.5 rounded-lg space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">Invite link, not used yet</p>
                  <p className="text-[10px] text-g2-muted">Works once. Expires in {timeLeft(hostInviteExpiry(i) - now)}.</p>
                </div>
                <button
                  type="button"
                  onClick={() => handleCancel(i.token)}
                  className="p-1.5 rounded-md bg-white/5 hover:bg-red-500/10 text-g2-secondary hover:text-red-300 border border-white/10 cursor-pointer shrink-0"
                  title="Cancel this link" aria-label="Cancel this invite link"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleCopy(i.token)}
                  className="flex-1 flex items-center justify-center gap-1.5 text-[11px] font-bold bg-white/5 hover:bg-white/10 border border-white/10 text-g2-secondary py-1.5 rounded-lg cursor-pointer transition-colors"
                >
                  {copied === i.token ? <><Check className="w-3 h-3" /> Copied</> : <><Copy className="w-3 h-3" /> Copy link</>}
                </button>
                {canShare && (
                  <button
                    type="button"
                    onClick={() => handleShare(i.token)}
                    className="flex-1 flex items-center justify-center gap-1.5 text-[11px] font-bold bg-g2-blue hover:bg-g2-blue-hover text-white py-1.5 rounded-lg cursor-pointer transition-colors"
                  >
                    <Share2 className="w-3 h-3" /> Send it
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {isOwner && open.length > 0 && (
        <p className="text-[10px] text-g2-muted">Send the link only to the person you want as a co-host. They sign in with Google to accept.</p>
      )}
      {isOwner && room <= 0 && (
        <p className="text-[10px] text-g2-muted">This event has all {MAX_COHOSTS} co-host places taken or on offer.</p>
      )}
      {note && <p className="text-[11px] text-g2-secondary break-all" aria-live="polite">{note}</p>}
    </div>
  );
}
