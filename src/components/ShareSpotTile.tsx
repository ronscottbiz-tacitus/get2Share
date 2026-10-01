import React from 'react';
import { BatteryCharging, BatteryFull, BatteryLow, BatteryMedium, Maximize2, Radio, Trash2, WifiOff, Zap } from 'lucide-react';
import { GuestSession } from '../types';
import { ShotState } from './useRemoteShutter';
import { Liveness } from './useSpotLiveness';
import { ShutterButton, ShotOverlay, shotStatusText } from './ShutterButton';

interface Props {
  key?: string; // project has no @types/react, so JSX doesn't know about key
  spot: GuestSession;
  shot?: ShotState;
  liveness: Liveness;
  focused: boolean;
  onFire: () => void;
  onToggleFocus: () => void;
  onRemove: () => void;
}

function ago(ms: number | null) {
  if (!ms) return '';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return ` · ${s}s ago`;
  const m = Math.round(s / 60);
  return ` · ${m}m ago`;
}

function BatteryBadge({ level, charging }: { level?: number | null; charging?: boolean | null }) {
  if (level == null) return null; // browser doesn't report battery (e.g. iPhone/iPad)
  const tone = charging
    ? 'text-emerald-300 border-emerald-400/30'
    : level < 15
      ? 'text-red-300 border-red-400/50 bg-red-950/70'
      : level < 30
        ? 'text-amber-300 border-amber-400/40'
        : 'text-g2-secondary border-white/10';
  const Icon = charging ? BatteryCharging : level < 15 ? BatteryLow : level < 60 ? BatteryMedium : BatteryFull;
  return (
    <span
      className={`absolute top-2 right-2 flex items-center gap-1 text-[10px] font-bold bg-black/60 backdrop-blur-md px-2 py-0.5 rounded-full border ${tone}`}
      title={charging ? 'Plugged in' : level < 30 ? 'Plug this device in' : 'On battery'}
    >
      <Icon className="w-3.5 h-3.5" aria-hidden="true" />
      {level}%{charging ? ' · charging' : level < 15 ? ' · plug in now' : level < 30 ? ' · low' : ''}
    </span>
  );
}

export default function ShareSpotTile({ spot, shot, liveness, focused, onFire, onToggleFocus, onRemove }: Props) {
  const offline = liveness.state === 'offline';
  const connecting = liveness.state === 'connecting';
  const info = (spot.deviceInfo || {}) as GuestSession['deviceInfo'];

  const status = offline
    ? `Offline${ago(liveness.lastSeenMs)}`
    : connecting
      ? 'Connecting…'
      : shotStatusText(shot, focused ? 'Ready · fast preview' : 'Ready');

  return (
    <div
      className={`bg-black/30 border rounded-xl overflow-hidden flex flex-col transition-colors ${
        focused ? 'border-g2-blue ring-2 ring-g2-blue/60' : 'border-white/5'
      }`}
    >
      {/* Preview: one fixed upright frame so every tile lines up, whatever the device. */}
      <button
        type="button"
        onClick={onToggleFocus}
        aria-pressed={focused}
        aria-label={focused ? `Stop focusing ${spot.nickname}` : `Focus ${spot.nickname} for a faster preview`}
        className={`relative w-full overflow-hidden bg-black/50 border-b border-white/5 cursor-pointer group aspect-[4/5]`}
      >
        {spot.stream_frame ? (
          <img
            src={spot.stream_frame}
            alt={`Live preview from ${spot.nickname}`}
            className={`absolute inset-0 w-full h-full object-cover transition-[filter,opacity] ${
              offline ? 'grayscale opacity-40' : connecting ? 'opacity-60' : ''
            }`}
          />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <Radio className="w-6 h-6 text-g2-muted animate-ping mb-1" aria-hidden="true" />
            <p className="text-[10px] text-g2-muted">Waiting for preview</p>
          </div>
        )}

        {offline && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-4">
            <WifiOff className="w-7 h-7 text-g2-secondary" aria-hidden="true" />
            <p className="text-xs font-bold text-white">Offline</p>
            <p className="text-[10px] text-g2-tertiary">Check that the device is awake and on Wi-Fi.</p>
          </div>
        )}

        <ShotOverlay shot={shot} />

        <span className="absolute top-2 left-2 max-w-[55%] truncate text-[10px] font-bold bg-black/60 backdrop-blur-md text-g2-blue-light px-2 py-0.5 rounded-full border border-g2-blue/20">
          {spot.nickname}
        </span>
        <BatteryBadge level={info?.batteryLevel ?? null} charging={(info as any)?.charging ?? null} />

        <span
          className={`absolute bottom-2 right-2 flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full backdrop-blur-md transition-opacity ${
            focused
              ? 'bg-g2-blue text-white opacity-100'
              : 'bg-black/60 text-g2-secondary border border-white/10 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100'
          }`}
        >
          {focused ? <Zap className="w-3 h-3" aria-hidden="true" /> : <Maximize2 className="w-3 h-3" aria-hidden="true" />}
          {focused ? 'Fast preview' : 'Tap to focus'}
        </span>
      </button>

      <div className="p-3 bg-black/40 flex items-center gap-2">
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${spot.nickname}`}
          title="Remove this Share Spot"
          className="p-1.5 shrink-0 text-g2-muted hover:text-red-300 hover:bg-red-500/10 rounded-lg cursor-pointer transition-colors"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
        <span
          className={`flex-1 min-w-0 truncate text-[10px] font-mono ${offline ? 'text-amber-300' : 'text-g2-muted'}`}
          aria-live="polite"
        >
          {status}
        </span>
        <ShutterButton shot={shot} onFire={onFire} disabled={offline} />
      </div>
    </div>
  );
}
