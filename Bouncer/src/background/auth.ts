// Google OAuth authentication via Firebase Auth + chrome.identity.launchWebAuthFlow
// Firebase handles token persistence and automatic refresh.
// launchWebAuthFlow handles the Google sign-in popup (cross-browser).

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  onAuthStateChanged,
} from 'firebase/auth/web-extension';
import type { User } from 'firebase/auth';

// Firebase config and Google client ID — injected at build time via process.env
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
};
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const REDIRECT_URI = `https://${chrome.runtime.id}.chromiumapp.org/`;
const SCOPES = 'email';

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

// Track auth state
let currentUser: User | null = null;
let authReady = false;
let authReadyResolve: (() => void) | null = null;
const authReadyPromise = new Promise<void>((resolve) => {
  authReadyResolve = resolve;
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (!authReady) {
    authReady = true;
    authReadyResolve!();
  }
});

// ==================== Token management ====================

// Get a valid Firebase ID token. Firebase auto-refreshes expired tokens.
// Returns null if no user is signed in.
export async function getAuthToken(): Promise<string | null> {
  await authReadyPromise;

  if (!currentUser) {
    return null;
  }

  try {
    const token = await currentUser.getIdToken(/* forceRefresh */ false);
    return token;
  } catch (err) {
    console.error('[Auth] Failed to get ID token:', (err as Error).message);
    return null;
  }
}

// ==================== Interactive sign-in ====================

// Launch Google sign-in via launchWebAuthFlow, then sign into Firebase.
export async function launchAuthFlow(): Promise<string | null> {
  try {
    // Step 1: Get Google access token via launchWebAuthFlow
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'token',
      scope: SCOPES,
    });
    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    const responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });

    // Extract access token from redirect URL fragment
    if (!responseUrl) {
      console.error('[Auth] No response URL from launchWebAuthFlow');
      return null;
    }
    const hash = new URL(responseUrl).hash.substring(1);
    const hashParams = new URLSearchParams(hash);
    const accessToken = hashParams.get('access_token');

    if (!accessToken) {
      console.error('[Auth] No access token in redirect URL');
      return null;
    }

    // Step 2: Sign into Firebase with the Google credential
    const credential = GoogleAuthProvider.credential(null, accessToken);
    const userCredential = await signInWithCredential(auth, credential);

    // Step 3: Get Firebase ID token
    const idToken = await userCredential.user.getIdToken();
    return idToken;
  } catch (err) {
    console.error('[Auth] Sign-in failed:', (err as Error).message);
    return null;
  }
}

// ==================== Startup & cleanup ====================

// Restore auth state on startup. Firebase auto-restores from chrome.storage.local.
export async function refreshAuthToken(): Promise<string | null> {
  await authReadyPromise;

  if (currentUser) {
    const token = await getAuthToken();
    if (token) return token;
  }

  return null;
}