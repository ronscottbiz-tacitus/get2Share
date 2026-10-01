export interface Photo {
  id: string;
  url: string;
  nickname: string;
  sessionId: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
  reactions: {
    likes: number;
    dislikes: number;
  };
  flagged: boolean;
}

export interface GuestSession {
  sessionId: string;
  nickname: string;
  lastActive: number;
  role: 'guest' | 'tripod' | 'host';
  deviceInfo: {
    batteryLevel?: number;
    userAgent?: string;
    deviceName?: string;
  };
  invited_to_lens?: boolean;
  lens_status?: 'off' | 'requesting' | 'streaming' | 'declined';
  stream_frame?: string; // base64 low-res preview frame for live viewfinder stream
}

export interface ShutterCommand {
  id: string;
  tripodId: string;
  command: 'shutter';
  timestamp: number;
  status: 'pending' | 'completed' | 'failed';
}

export interface EventSettings {
  autoApproval: boolean;
  eventTitle?: string;
  eventSubtitle?: string;
  guestLensEnabled?: boolean;
}
