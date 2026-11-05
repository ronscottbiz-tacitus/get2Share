import { useEffect, useState } from 'react';
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { auth, db } from './firebase';
import { isAdminEmail } from './hosts';

// Flow (called Walkthrough in the code and database): a host picks a few photos, and an outside AI video service animates from each
// photo to the next. A cloud job (services/step-in/walkthrough_app.py) makes the clips, joins
// them, burns in the label below, and writes events/{eid}/walkthroughs/{id}. The host previews
// it and approves it; only then can guests and TVs read it (see firestore.rules).
//
// config/walkthrough switches it on. No doc means off, for everyone. The cloud job makes the
// real checks and enforces the limits; what's read here only decides what the app offers.

/** The cloud job's web address. Override with VITE_WALKTHROUGH_API for a test deployment. */
export const WALKTHROUGH_API: string =
  (import.meta as any).env?.VITE_WALKTHROUGH_API || 'https://ronscottbiz-tacitus--get2share-walkthrough-api.us-east.modal.run';

/** Burned into every video and always shown next to it. Same text as walkthrough/config.py. */
export const WALKTHROUGH_LABEL = "AI-generated video. Some moments and details aren't real.";

/** What a host must accept before creating. Bump NOTICE_VERSION (here and in config.py) if it changes. */
export const WALKTHROUGH_NOTICE = "These photos go to an outside AI service, which may use them to improve its AI. The AI can add or change people's faces and moments. I have permission from everyone pictured, and none of them are kids.";
export const NOTICE_VERSION = 2;

export type WalkthroughAspect = '9:16' | '16:9';
export type WalkthroughStatus = 'queued' | 'generating' | 'joining' | 'preview' | 'published' | 'failed' | 'blocked';

export interface WalkthroughClip {
  index: number;
  startPhotoId: string;
  endPhotoId: string;
  status: 'pending' | 'submitting' | 'submitted' | 'ready' | 'failed' | 'blocked';
}

export interface Walkthrough {
  id: string;
  status: WalkthroughStatus;
  aspect: WalkthroughAspect;
  seconds: number;
  clips: WalkthroughClip[];
  photoIds: string[];
  videoUrl?: string | null;
  posterUrl?: string | null;
  redosUsed?: number;
  /** Burned-in label on the video. On unless the host turned it off. The note in the app always shows. */
  showLabel?: boolean;
  error?: string | null;
  redoNotice?: string | null;
  createdAt?: { toMillis(): number } | null;
  updatedAt?: { toMillis(): number } | null;
}

export interface WalkthroughConfig {
  enabled: boolean;
  allHosts: boolean;
  minPhotos: number;
  maxPhotos: number;
  clipSeconds: number;
}

export const OFF_CONFIG: WalkthroughConfig = { enabled: false, allHosts: false, minPhotos: 3, maxPhotos: 10, clipSeconds: 5 };

/** Reads config/walkthrough the way the cloud job does: only a literal true turns anything on. */
export function parseWalkthroughConfig(d: any): WalkthroughConfig {
  if (!d) return OFF_CONFIG;
  const whole = (v: any, fallback: number) => (Number.isInteger(v) && v >= 2 ? v : fallback);
  const minPhotos = whole(d.photos?.min, OFF_CONFIG.minPhotos);
  return {
    enabled: d.enabled === true,
    allHosts: d.allHosts === true,
    minPhotos,
    maxPhotos: Math.max(minPhotos, whole(d.photos?.max, OFF_CONFIG.maxPhotos)),
    clipSeconds: typeof d.clipSeconds === 'number' && d.clipSeconds >= 1 ? d.clipSeconds : OFF_CONFIG.clipSeconds,
  };
}

/** Each photo after the first adds one clip. */
export const flowSeconds = (photos: number, clipSeconds: number) => Math.max(0, photos - 1) * clipSeconds;

export interface FlowMeter { allowanceSeconds: number; usedSeconds: number; remainingSeconds: number; plan: 'free' | 'event' | 'grant'; access?: boolean }

export function useWalkthroughConfig(active: boolean): WalkthroughConfig {
  const [config, setConfig] = useState<WalkthroughConfig>(OFF_CONFIG);
  useEffect(() => {
    if (!active) return;
    return onSnapshot(
      doc(db, 'config', 'walkthrough'),
      (s) => setConfig(parseWalkthroughConfig(s.exists() ? s.data() : null)),
      () => setConfig(OFF_CONFIG), // rules not published yet, or no connection: off
    );
  }, [active]);
  return config;
}

export function canMakeWalkthrough(config: WalkthroughConfig, isHost: boolean): boolean {
  const user = auth.currentUser;
  const admin = !!user && !user.isAnonymous && !!user.emailVerified && isAdminEmail(user.email);
  return isHost && config.enabled && (admin || config.allHosts);
}

const walkthroughsCol = (eventId: string) => collection(db, 'events', eventId, 'walkthroughs');
const toRows = (snap: any): Walkthrough[] => {
  const rows: Walkthrough[] = [];
  snap.forEach((d: any) => rows.push({ id: d.id, ...d.data() }));
  return rows.sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
};

/** Every video for this event, newest first. Hosts only (the rules refuse anyone else). */
export function useHostWalkthroughs(eventId: string, isHost: boolean): Walkthrough[] {
  const [rows, setRows] = useState<Walkthrough[]>([]);
  useEffect(() => {
    if (!isHost) return;
    return onSnapshot(walkthroughsCol(eventId), (s) => setRows(toRows(s)), () => setRows([]));
  }, [eventId, isHost]);
  return rows;
}

/** Approved videos, for the gallery and TVs. Asks only for published ones: that's all the rules allow. */
export function usePublishedWalkthroughs(eventId: string): Walkthrough[] {
  const [rows, setRows] = useState<Walkthrough[]>([]);
  useEffect(() => {
    return onSnapshot(query(walkthroughsCol(eventId), where('status', '==', 'published')), (s) => setRows(toRows(s)), () => setRows([]));
  }, [eventId]);
  return rows;
}

export const walkthroughBusy = (w: Pick<Walkthrough, 'status'> | null | undefined) =>
  w?.status === 'queued' || w?.status === 'generating' || w?.status === 'joining';

/** How many clips are finished, for progress. */
export const clipsDone = (w: Pick<Walkthrough, 'clips'>) => w.clips.filter((c) => c.status === 'ready').length;

/** No update for this long: tell the host it's slow. The cloud job restarts stuck work by itself. */
export const WALKTHROUGH_SLOW_MS = 12 * 60 * 1000;
export const walkthroughSlow = (w: Walkthrough, now = Date.now()) => {
  const at = w.updatedAt?.toMillis?.();
  return walkthroughBusy(w) && !!at && now - at > WALKTHROUGH_SLOW_MS;
};

async function call(path: string, body: Record<string, unknown>): Promise<any> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error('Sign in first.');
  let res: Response;
  try {
    res = await fetch(`${WALKTHROUGH_API}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the video service. Check the Wi-Fi and try again.");
  }
  const answer = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((answer && typeof answer.detail === 'string' && answer.detail) || 'The video service is unavailable right now. Try again in a minute.');
  }
  return answer;
}

export const getFlowMeter = (eventId: string): Promise<FlowMeter> => call('/meter', { eventId });
export const setFlowLabel = (eventId: string, walkthroughId: string, show: boolean) => call('/label', { eventId, walkthroughId, show });
export const createWalkthrough = (args: { eventId: string; photoIds: string[]; aspect: WalkthroughAspect; requestId: string; showLabel: boolean }) =>
  call('/create', { ...args, acceptedNotice: true, noticeVersion: NOTICE_VERSION });
export const redoWalkthroughClip = (eventId: string, walkthroughId: string, clipIndex: number) =>
  call('/redo', { eventId, walkthroughId, clipIndex });
export const approveWalkthrough = (eventId: string, walkthroughId: string) => call('/approve', { eventId, walkthroughId });
export const unpublishWalkthrough = (eventId: string, walkthroughId: string) => call('/unpublish', { eventId, walkthroughId });
export const deleteWalkthrough = (eventId: string, walkthroughId: string) => call('/delete', { eventId, walkthroughId });

/** The video as a file, to save to this device. Needs the bucket's CORS set, as saving photos does. */
export async function walkthroughFile(eventName: string, w: Walkthrough): Promise<File> {
  const res = await fetch(w.videoUrl!, { mode: 'cors', credentials: 'omit' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  const slug = eventName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'party';
  return new File([blob], `get2share-${slug}-flow.mp4`, { type: 'video/mp4' });
}
