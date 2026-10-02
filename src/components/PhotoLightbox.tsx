import { useState, useEffect } from 'react';
import { ThumbsUp, ThumbsDown, Heart, EyeOff, Trash2, AlertTriangle, X, Check, Eye } from 'lucide-react';
import { updateDoc, deleteDoc, getDoc } from 'firebase/firestore';
import { deletePhotoFile, handleFirestoreError, OperationType } from '../firebase';
import { paths } from '../events';
import { useEvent } from '../EventContext';
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
  const { event } = useEvent();
  const eventId = event.id;
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
      const docRef = paths.photo(eventId, photo.id);
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
      const docRef = paths.photo(eventId, photo.id);
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

    if (isHost && !window.confirm('Delete this photo for everyone at the event?')) {
      return;
    }

    try {
      setDeleting(true);
      const docRef = paths.photo(eventId, photo.id);
      await deleteDoc(docRef);
      deletePhotoFile(photo.url);
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
          aria-label="Close"
          className="absolute top-4 left-4 p-2.5 bg-white/5 border border-white/10 hover:border-white/20 text-g2-secondary hover:text-white rounded-full z-10 cursor-pointer transition-all duration-300"
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
      <div className="w-full md:w-96 bg-g2-panel/90 border-t md:border-t-0 md:border-l border-white/5 p-6 flex flex-col justify-between shrink-0 backdrop-blur-xl">
        <div>
          {/* Header Info */}
          <div className="flex justify-between items-start pb-4 border-b border-white/5">
            <div>
              <p className="text-[10px] text-g2-muted font-extrabold uppercase tracking-widest">
                Posted by
              </p>
              <h2 className="text-lg font-bold text-white flex items-center gap-1.5 mt-0.5">
                {photo.nickname.replace(/\s*\((Tripod|Photo Spot|Share Spot|Guest Lens|Group Shot)\)$/, '')}
                {isUploader && (
                  <span className="text-[10px] bg-g2-blue/5 text-g2-blue-light font-bold px-2.5 py-0.5 rounded-full border border-g2-blue/20 shadow-[0_0_10px_rgba(0,82,255,0.05)]">
                    You
                  </span>
                )}
              </h2>
              <p className="text-[11px] text-g2-muted mt-1">
                {new Date(photo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>

            <button
              onClick={() => onToggleFavorite(photo.id)}
              aria-label={isFavorite ? 'Remove from Loved' : 'Add to Loved'}
              aria-pressed={isFavorite}
              className={`p-2.5 rounded-xl border transition-all cursor-pointer ${
                isFavorite
                  ? 'bg-white/10 border-white text-white'
                  : 'bg-white/5 border-white/10 text-g2-tertiary hover:text-g2-text hover:border-white/25'
              }`}
            >
              <Heart className={`w-5 h-5 ${isFavorite ? 'fill-white' : ''}`} />
            </button>
          </div>

          {/* Core Interactive Actions */}
          <div className="py-6 space-y-5">
            <div>
              <h4 className="text-xs font-semibold text-g2-tertiary uppercase tracking-wider mb-2">
                React
              </h4>
              <div className="flex gap-3">
                <button
                  onClick={() => handleVote('like')}
                  className={`flex-1 py-3 px-4 rounded-xl border flex items-center justify-center gap-2 font-bold text-sm cursor-pointer transition-all ${
                    vote === 'like'
                      ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400 shadow-md shadow-emerald-500/5'
                      : 'bg-white/5 border-white/10 text-g2-tertiary hover:text-g2-text hover:border-white/20'
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
                      : 'bg-white/5 border-white/10 text-g2-tertiary hover:text-g2-text hover:border-white/20'
                  }`}
                >
                  <ThumbsDown className="w-4 h-4" />
                  <span>{dislikes}</span>
                </button>
              </div>
            </div>

            <div className="space-y-2 pt-2">
              <h4 className="text-xs font-semibold text-g2-tertiary uppercase tracking-wider mb-1">
                More
              </h4>

              {/* Hide Locally Toggle */}
              <button
                onClick={() => onToggleHideLocally(photo.id)}
                className={`w-full py-2.5 px-4 rounded-xl border text-xs font-bold flex items-center justify-between cursor-pointer transition-colors ${
                  isHiddenLocally
                    ? 'bg-g2-blue/5 border-g2-blue/20 text-g2-blue-light'
                    : 'bg-white/5 border-white/10 text-g2-tertiary hover:text-g2-text hover:border-white/20'
                }`}
              >
                <span className="flex items-center gap-2">
                  {isHiddenLocally ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                  {isHiddenLocally ? 'Show in my gallery' : 'Hide from my gallery'}
                </span>
                <span className="text-[10px] text-g2-muted">Only you</span>
              </button>

              {/* Flag Content */}
              <button
                onClick={handleFlag}
                disabled={flagged}
                className={`w-full py-2.5 px-4 rounded-xl border text-xs font-bold flex items-center gap-2 transition-colors cursor-pointer ${
                  flagged
                    ? 'bg-amber-500/5 border-amber-500/20 text-amber-500/50'
                    : 'bg-white/5 border-white/10 text-g2-tertiary hover:bg-amber-500/10 hover:text-amber-400 hover:border-amber-500/30'
                }`}
              >
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>{flagged ? 'Reported to the host' : 'Report to the host'}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Delete options (uploader or host) */}
        <div className="pt-4 border-t border-white/5">
          {isHost ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full bg-red-600 hover:bg-red-500 text-white font-extrabold py-3.5 rounded-xl text-xs flex items-center justify-center gap-2 cursor-pointer transition-all shadow-lg shadow-red-600/20"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting…' : 'Delete for everyone'}
            </button>
          ) : isUploader ? (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 font-bold py-3 rounded-xl text-xs flex items-center justify-center gap-1.5 cursor-pointer transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {deleting ? 'Deleting…' : 'Delete my photo'}
            </button>
          ) : (
            <div className="text-center p-3 bg-white/5 rounded-xl border border-white/5">
              <p className="text-[10px] text-g2-muted leading-relaxed">
                Only the person who took this photo, or the host, can delete it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
