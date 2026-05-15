// Authentication via Firebase Auth
// Chrome: Google OAuth via chrome.identity.launchWebAuthFlow
// Safari: Apple Sign-In via OAuthProvider popup
// Firebase handles token persistence and automatic refresh.

import { initializeApp } from 'firebase/app';
import {
  getAuth,
  signInWithCredential,
  GoogleAuthProvider,
  OAuthProvider,
  onAuthStateChanged,
  signOut as firebaseSignOut,
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
export const IS_SAFARI = typeof (globalThis as unknown as { browser?: unknown }).browser !== 'undefined' && typeof chrome.identity?.getRedirectURL !== 'function';
const REDIRECT_URI = IS_SAFARI ? '' : chrome.identity.getRedirectURL();
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
// On iOS, auto-signs in anonymously (no user interaction needed).
// On Chrome, requires Google sign-in first.
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

// Sign out
export async function signOut(): Promise<void> {
  try {
    await firebaseSignOut(auth);
    currentUser = null;
    console.log('[Auth] Signed out');
  } catch (err) {
    console.error('[Auth] Sign out failed:', (err as Error).message);
  }
}

// Launch sign-in flow. Chrome uses Google OAuth, Safari uses hosted page.
export async function launchAuthFlow(_method?: string): Promise<string | null> {
  if (IS_SAFARI) {
    return launchHostedAuthFlow();
  }
  return launchGoogleAuthFlow();
}

// Safari sign-in — opens a hosted page on BOUNCER_SIGNIN_DOMAIN
// (bouncer.imbue.com in prod, bouncer-dev.imbue.com in dev) that runs
// Firebase Auth's signInWithPopup for both Apple and Google. The bridge
// content script on that domain relays the credential back to the extension.
const SIGNIN_DOMAIN = process.env.BOUNCER_SIGNIN_DOMAIN || '';

async function launchHostedAuthFlow(): Promise<string | null> {
  try {
    const authDomain = firebaseConfig.authDomain;
    const extensionId = chrome.runtime.id;
    const params = new URLSearchParams({
      apiKey: firebaseConfig.apiKey || '',
      authDomain: authDomain || '',
      projectId: firebaseConfig.projectId || '',
      extensionId: extensionId || '',
    });
    const signinUrl = `https://${SIGNIN_DOMAIN}/signin#${params.toString()}`;

    console.log('[Auth] Opening sign-in tab:', signinUrl);
    await chrome.tabs.create({ url: signinUrl, active: true });
    // The bridge content script on SIGNIN_DOMAIN will send the credential
    // back via chrome.runtime.sendMessage({ type: 'appleSignIn' }).
    // The background message handler in index.ts will call handleAppleSignIn().
    return null;
  } catch (err) {
    console.error('[Auth] Failed to open sign-in tab:', (err as Error).message);
    return null;
  }
}

// Called when the bridge content script sends a credential from the hosted sign-in page.
// The message may contain an Apple/Google OAuth idToken or a Firebase token.
export async function handleAppleSignIn(idToken: string, rawNonce: string, firebaseToken?: string, providerId?: string): Promise<string | null> {
  try {
    // If we got a Firebase token directly (from the hosted page's getIdToken()),
    // we can't use it to sign into this background instance of Firebase Auth.
    // We need the OAuth credential to call signInWithCredential.
    if (idToken && providerId === 'apple.com') {
      console.log('[Auth] Exchanging Apple credential with Firebase...');
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({ idToken, rawNonce: rawNonce || undefined });
      const userCredential = await signInWithCredential(auth, credential);
      const token = await userCredential.user.getIdToken();
      console.log('[Auth] Apple sign-in succeeded');
      return token;
    }

    if (idToken && providerId === 'google.com') {
      console.log('[Auth] Exchanging Google credential with Firebase...');
      const credential = GoogleAuthProvider.credential(idToken);
      const userCredential = await signInWithCredential(auth, credential);
      const token = await userCredential.user.getIdToken();
      console.log('[Auth] Google sign-in succeeded');
      return token;
    }

    // Fallback: try as Apple credential
    if (idToken) {
      console.log('[Auth] Exchanging credential with Firebase (provider unknown)...');
      const provider = new OAuthProvider('apple.com');
      const credential = provider.credential({ idToken, rawNonce: rawNonce || undefined });
      const userCredential = await signInWithCredential(auth, credential);
      const token = await userCredential.user.getIdToken();
      console.log('[Auth] Sign-in succeeded');
      return token;
    }

    console.error('[Auth] No usable credential received');
    return null;
  } catch (err) {
    console.error('[Auth] Sign-in credential exchange failed:', (err as Error).message);
    return null;
  }
}

// Google OAuth via chrome.identity.launchWebAuthFlow (Chrome)
async function launchGoogleAuthFlow(): Promise<string | null> {
  try {
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

    const credential = GoogleAuthProvider.credential(null, accessToken);
    const userCredential = await signInWithCredential(auth, credential);
    const idToken = await userCredential.user.getIdToken();
    return idToken;
  } catch (err) {
    console.error('[Auth] Google sign-in failed:', (err as Error).message);
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