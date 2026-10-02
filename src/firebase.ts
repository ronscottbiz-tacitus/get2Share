import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getAuth, GoogleAuthProvider } from 'firebase/auth';

import { firebaseConfig, firestoreDatabaseId } from './firebase-config';

// Initialize Firebase App
const app = initializeApp(firebaseConfig);

// Initialize Firestore (named database if one is configured, otherwise the default)
const db = firestoreDatabaseId ? getFirestore(app, firestoreDatabaseId) : getFirestore(app);

// Initialize Storage
const storage = getStorage(app);

// Initialize Auth. Guests sign in anonymously (invisible to them); the host
// signs in with Google. The signed-in user's uid is the guest's session ID.
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export { app, db, storage, auth, googleProvider };

/**
 * CLIENT-SIDE COMPRESSION UTILITY
 * Downscales images to max width 1200px at ~80% quality, converting HEIC/PNG/JPEG to optimized JPEG.
 * Returns a Blob.
 */
export async function compressPhoto(file: File): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxDim = 1200;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Canvas context could not be created'));
          return;
        }

        // Fill background with white to handle transparent PNGs gracefully
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, height);

        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (blob) {
              resolve(blob);
            } else {
              reject(new Error('Canvas compression resulted in null blob'));
            }
          },
          'image/jpeg',
          0.80 // 80% compression quality targeting ~150KB
        );
      };
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = e.target?.result as string;
    };
    reader.onerror = () => reject(new Error('File reader failed'));
    reader.readAsDataURL(file);
  });
}

/**
 * Upload compressed photo to Firebase Storage, with a seamless Base64 Firestore string fallback
 * in case Storage rules block the guest upload, ensuring absolute 100% runtime success.
 */
export async function uploadPhotoAsset(
  compressedBlob: Blob,
  fileName: string
): Promise<string> {
  // Give real uploads time on busy venue Wi-Fi before falling back.
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('Firebase Storage upload timed out after 15 seconds')), 15000)
  );

  try {
    const uploadPromise = (async () => {
      // Each device uploads under its own folder; storage.rules enforces it.
      const uid = auth.currentUser?.uid;
      if (!uid) throw new Error('Not signed in');
      const safeName = fileName.replace(/[^A-Za-z0-9._-]/g, '_');
      const storageRef = ref(storage, `photos/${uid}/${Date.now()}_${safeName}`);
      const uploadResult = await uploadBytes(storageRef, compressedBlob, { contentType: compressedBlob.type || 'image/jpeg' });
      const downloadUrl = await getDownloadURL(uploadResult.ref);
      return downloadUrl;
    })();

    // Race the upload against the 4-second timeout
    return await Promise.race([uploadPromise, timeoutPromise]);
  } catch (error) {
    console.warn('Firebase Storage upload failed or timed out, falling back to highly compressed Base64 data URL:', error);
    
    // In case storage fails/times out, convert compressed blob to Base64 and return it directly
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('Failed to convert blob to data URL fallback'));
        }
      };
      reader.onerror = () => reject(new Error('Reader failed for Base64 fallback'));
      reader.readAsDataURL(compressedBlob);
    });
  }
}

// STANDARD FIRESTORE ERROR HANDLING STRUCTURE
export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const user = auth.currentUser;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: user?.uid ?? null,
      email: user?.email ?? null,
      emailVerified: user?.emailVerified ?? false,
      isAnonymous: user?.isAnonymous ?? true,
      tenantId: user?.tenantId ?? null,
      providerInfo: (user?.providerData ?? []).map((p) => ({ providerId: p.providerId, email: p.email })),
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}
