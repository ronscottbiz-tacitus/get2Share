import { useState, useEffect } from 'react';
import { ThumbsUp, ThumbsDown, Heart, EyeOff, Trash2, AlertTriangle, X, Check, Eye } from 'lucide-react';
import { doc, updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase';
import { Photo } from '../types';

interface PhotoLightboxProps {
  photo: Photo;
  onClose: () => void;
  sessionId: string;
  isFavorite: boolean;
  onToggleFavorite: (id: string) => void;
  isHiddenLocally: boolean;
  onToggleHideLocally: (id: string) => void;
  isHost?: boolean;
}

export default function PhotoLightbox({
  photo,
  onClose,
  sessionId,
  isFavorite,
  onToggleFavorite,
  isHiddenLocally,
  onToggleHideLocally,
  isHost,
}: PhotoLightboxProps) {
  const [likes, setLikes] = useState(photo.reactions?.likes || 0);
  const [dislikes, setDislikes] = useState(photo.reactions?.dislikes || 0);
  const [vote, setVote] = useState<'like' | 'dislike' | null>(null);
  const [flagged, setFlagged] = useState(photo.flagged || false);
  const [deleting, setDeleting] = useState(false);

  // Load guest's vote from local storage for this photo to avoid double-voting
  useEffect(() => {
    const votesKey = 'get2share-votes';
    const storedVotes = JSON.parse(localStorage.getItem(votesKey) || '{}');
    if (storedVotes[photo.id]) {
      setVote(storedVotes[photo.id]);
    }
  }, [photo.id]);

  const handleVote = async (type: 'like' | 'dislike') => {
    const votesKey = 'get2share-votes';
    const storedVotes = JSON.parse(localStorage.getItem(votesKey) || '{}');
    const existingVote = storedVotes[photo.id];

    let newLikes = likes;
    let newDislikes = dislikes;

    if (existingVote === type) {
      // Undo same vote
      if (type === 'like') newLikes = Math.max(0, newLikes - 1);
      if (type === 'dislike') newDislikes = Math.max(0, newDislikes - 1);
      delete storedVotes[photo.id];
      setVote(null);
    } else {
      // Apply new vote, remove old vote if present
      if (type === 'like') {
        newLikes += 1;
        if (existingVote === 'dislike') newDislikes = Math.max(0, newDislikes - 1);
      } else {
        newDislikes += 1;
        if (existingVote === 'like') newLikes = Math.max(0, newLikes - 1);
      }
      storedVotes[photo.id] = type;
      setVote(type);
    }

    localStorage.setItem(votesKey, JSON.stringify(storedVotes));
    setLikes(newLikes);
    setDislikes(newDislikes);

    // Sync back to Firestore
    try {
      const docRef = doc(db, 'photos', photo.id);
      await updateDoc(docRef, {
        reactions: {
          likes: newLikes,
          dislikes: newDislikes,
        },
      });
    } catch (e) {
      console.error('Failed to sync reaction votes:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${photo.id}`);
    }
  };

  const handleFlag = async () => {
    if (flagged) return;

    try {
      setFlagged(true);
      const docRef = doc(db, 'photos', photo.id);
      await updateDoc(docRef, {
        flagged: true,
      });
    } catch (e) {
      console.error('Failed to flag photo:', e);
      handleFirestoreError(e, OperationType.UPDATE, `photos/${photo.id}`);
    }
  };

  const handleDelete = async () => {
    if (!isHost && photo.sessionId !== sessionId) return;

    if (isHost && !window.confirm('Host God-Mode: Permanently delete this photo from the event?')) {
      return;
    }

    try {
      setDeleting(true);
      const docRef = doc(db, 'photos', photo.id);
      await deleteDoc(docRef);
      onClose();
    } catch (e) {
      console.error('Failed to delete photo:', e);
      setDeleting(false);
      handleFirestoreError(e, OperationType.DELETE, `photos/${photo.id}`);
    }
  };

  const isUploader = photo.sessionId === sessionId;

  return (
    <div className="fixed inset-0 bg-black/95 backdrop-blur-md z-50 flex flex-col justify-between md:flex-row items-stretch font-sans animate-fade-in">
      {/* Media Box */}
      <div className="flex-1 flex items-center justify-center p-4 relative bg-black min-h-[50vh] md:min-h-0">
        <button
          onClick={onClose}
          className="absolute top-4 left-4 p-2.5 bg-white/5 border border-white/10 hover:border-white/20 text-slate-300 hover:text-white rounded-full z-10 cursor-pointer transition-all duration-300"
        >
          <X className="w-5 h-5" />
        </button>

        <img
          src={photo.url}
          alt={`By ${photo.nickname}`}
          className="max-w-full max-h-[75vh] md:max-h-[90vh] object-contain rounded-xl shadow-2xl"
        />
      </div>

      {/* Control Box Panel */}
      <div className="w-full md:w-96 bg-[#0c0c0c]/90 border-t md:border-t-0 md:border-l border-white/5 p-6 flex flex-col justify-between shrink-0 backdrop-blur-xl">
        <div>
          {/* Header Info */}
          <div className="flex justify-between items-start pb-4 border-b border-white/5">
            <div>
              <p className="text-[10px] text-slate-500 font-extrabold uppercase tracking-widest">
                Event Participant
              </p>
              <h2 className="text-lg font-bold text-white flex items-center gap-1.5 mt-0.5">
                {photo.nickname}
                {isUploader && (
                  <span className="text-[10px] bg-[#00f2ff]/5 text-[#00f2ff] font-bold px-2.5 py-0.5 rounded-full border border-[#00f2ff]/20 shadow-[0_0_10px_rgba(0,242,255,0.05)]">
                    You
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-slate-500 mt-1">
                {new Date(photo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>

            <button
              onClick={() => onToggleFavorite(photo.id)}
              className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                isFavorite
                  ? 'bg-rose-500/10 border-rose-500/40 text-rose-400'
                  : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/25'
              }`}
            >
              <Heart className={`w-5 h-5 ${isFavorite ? 'fill-rose-400' : ''}`} />
            </button>
          </div>

          {/* Core Interactive Actions */}
          <div className="py-6 space-y-5">
            <div>
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">
                Rate this snap
              </h4>
              <div className="flex gap-3">
                <button
                  onClick={() => handleVote('like')}
                  className={`flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 font-bold text-sm cursor-pointer transition-all ${
                    vote === 'like'
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-md shadow-emerald-500/5'
                      : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                  }`}
                >
                  <ThumbsUp className="w-4 h-4" />
                  <span>{likes}</span>
                </button>
                <button
                  onClick={() => handleVote('dislike')}
                  className={`flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 font-bold text-sm cursor-pointer transition-all ${
                    vote === 'dislike'
                      ? 'bg-red-500/10 border-red-500/40 text-red-400 shadow-md shadow-red-500/5'
                      : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                  }`}
                >
                  <ThumbsDown className="w-4 h-4" />
                  <span>{dislikes}</span>
                </button>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">
                Moderation Actions
              </h4>

              {/* Hide Locally Toggle */}
              <button
                onClick={() => onToggleHideLocally(photo.id)}
                className={`w-full py-2.5 px-4 rounded-xl border text-xs font-bold flex items-center justify-between cursor-pointer transition-colors ${
                  isHiddenLocally
                    ? 'bg-[#00f2ff]/5 border-[#00f2ff]/20 text-[#00f2ff]'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:text-slate-200 hover:border-white/20'
                }`}
              >
                <span className="flex items-center gap-2">
                  {isHiddenLocally ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {isHiddenLocally ? 'Show Locally in Grid' : 'Hide from my Grid'}
                </span>
                <span className="text-[10px] text-slate-500">Local Only</span>
              </button>

              {/* Flag Content */}
              <button
                onClick={handleFlag}
                disabled={flagged}
                className={`w-full py-2.5 px-4 rounded-xl border text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
                  flagged
                    ? 'bg-amber-500/5 border-amber-500/20 text-amber-500/50'
                    : 'bg-white/5 border-white/10 text-slate-400 hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/30'
                }`}
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{flagged ? 'Flagged (Awaiting Review)' : 'Flag Content to Host'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Delete Options (Creator or Host God-Mode) */}
        <div className="pt-4 border-t border-white/5">
          {isHost ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full bg-red-600 hover:bg-red-500 text-white font-extrabold py-3.5 rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer transition-all shadow-lg shadow-red-600/20"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting snap...' : 'Delete Photo (Host God-Mode)'}
            </button>
          ) : isUploader ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-bold py-3 rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting snap...' : 'Delete My Photo'}
            </button>
          ) : (
            <div className="text-center p-3 bg-white/5 rounded-xl border border-white/5">
              <p className="text-[10px] text-slate-500 leading-relaxed">
                Guest deletions are locked. You can only remove snaps you originally uploaded from your session.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
