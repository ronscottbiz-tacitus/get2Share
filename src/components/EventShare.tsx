import { useEffect, useState } from 'react';
import { Check, Copy, Download, Share2, UserPlus } from 'lucide-react';
import { canShareLinks, copyText, qrCardFile, shareInvite, startLine } from '../eventShare';
import { downloadBlob, saveViaShareSheet, shareFiles } from '../savePhotos';

const hostBtn =
  'flex-1 min-w-0 h-10 rounded-xl border border-white/10 text-g2-secondary hover:text-white hover:bg-white/5 text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer transition-colors';

/**
 * Host Console, under the QR code: Share (the phone's share sheet), Copy link, and Save QR (a card
 * with the event's name, the QR code and the join code, to print, put on a flyer or text around).
 * The card is drawn ahead of time so a phone can hand it to the share sheet straight from the tap.
 * Before the event starts, the card and the share message say when it starts.
 */
export function HostShareButtons({ eventName, code, url, startMs = null }: { eventName: string; code: string; url: string; startMs?: number | null }) {
  const [copied, setCopied] = useState(false);
  const [card, setCard] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const canShare = canShareLinks();

  // Redrawn when the start passes, so a card saved during the event has no date on it.
  const when = startLine(startMs);
  useEffect(() => {
    let live = true;
    setCard(null);
    qrCardFile(eventName, code, url, window.location.host, when)
      .then((f) => { if (live) setCard(f); })
      .catch((e) => console.error('Making the QR card failed:', e));
    return () => { live = false; };
  }, [eventName, code, url, when]);

  const handleShare = async () => {
    setNote('');
    try {
      await shareInvite(eventName, url, startMs);
    } catch {
      setNote("Your device didn't open sharing. Use Copy link instead.");
    }
  };

  const handleCopy = async () => {
    setNote('');
    if (await copyText(url)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } else {
      setNote(`Copy this link: ${url}`);
    }
  };

  const handleSaveQr = async () => {
    setNote('');
    if (!card) {
      setNote('The QR card is still being made. Try again in a second.');
      return;
    }
    // Phones and tablets: the share sheet, where "Save Image" puts it in Photos. Laptops (even
    // ones whose browser has a share menu, like Chrome on a Mac): a plain download.
    if (saveViaShareSheet([card])) {
      try {
        await shareFiles([card]);
      } catch {
        downloadBlob(card, card.name);
      }
      return;
    }
    downloadBlob(card, card.name);
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {canShare && (
          <button type="button" onClick={handleShare} className={hostBtn}>
            <Share2 className="w-4 h-4 text-g2-blue-light" aria-hidden="true" /> Share
          </button>
        )}
        <button type="button" onClick={handleCopy} className={hostBtn}>
          {copied
            ? <><Check className="w-4 h-4 text-emerald-400" aria-hidden="true" /> Copied</>
            : <><Copy className="w-4 h-4 text-g2-blue-light" aria-hidden="true" /> Copy link</>}
        </button>
        <button type="button" onClick={handleSaveQr} disabled={!card} className={`${hostBtn} disabled:opacity-60 disabled:cursor-wait`}>
          <Download className="w-4 h-4 text-g2-blue-light" aria-hidden="true" /> Save QR
        </button>
      </div>
      {note && <p className="text-[11px] text-g2-secondary break-all" aria-live="polite">{note}</p>}
    </div>
  );
}

/** Gallery, under the event's name: lets a guest bring friends in. Opens the share sheet, or copies the link. */
export function InviteButton({ eventName, url, startMs = null }: { eventName: string; url: string; startMs?: number | null }) {
  const [note, setNote] = useState('');

  const handleInvite = async () => {
    setNote('');
    if (canShareLinks()) {
      try {
        await shareInvite(eventName, url, startMs);
        return;
      } catch { /* fall through to copying */ }
    }
    setNote((await copyText(url)) ? 'Link copied. Paste it to your friends.' : `Send your friends this link: ${url}`);
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={handleInvite}
        className="h-9 px-3.5 rounded-full border border-g2-blue/50 bg-g2-blue/10 hover:bg-g2-blue/20 text-[12.5px] font-bold text-white inline-flex items-center gap-1.5 cursor-pointer transition-colors"
      >
        <UserPlus className="w-4 h-4 text-g2-blue-light" aria-hidden="true" /> Invite friends
      </button>
      {note && <p className="mt-1.5 text-[12px] text-g2-secondary break-all" aria-live="polite">{note}</p>}
    </div>
  );
}
