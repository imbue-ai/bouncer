// Content script injected on bouncer.imbue.com and bouncer-dev.imbue.com
// Listens for postMessage from the hosted sign-in page, forwards the
// credential to the extension's background script, and posts an ack back
// to the page so it can tell whether delivery actually happened.

// Origins the hosted sign-in page is served from — matches the content_scripts
// `matches` in manifest.safari.json. A credential-bearing message is only
// honored (and the ack only sent) if event.origin is one of these, so the
// bridge can't be driven from any other origin it might end up loaded on.
const ALLOWED_ORIGINS = new Set([
  'https://bouncer.imbue.com',
  'https://bouncer-dev.imbue.com',
]);

function ack(targetOrigin: string, success: boolean, error?: string): void {
  window.postMessage({ type: 'bouncer-bridge-ack', success, error }, targetOrigin);
}

interface SigninResultMessage {
  type: 'bouncer-signin-result';
  providerId?: string;
  idToken?: string;
  firebaseToken?: string;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (!ALLOWED_ORIGINS.has(event.origin)) return;
  const data = event.data as SigninResultMessage | undefined;
  if (!data || data.type !== 'bouncer-signin-result') return;

  console.log('[Bouncer SignIn Bridge] Received credential from hosted page');
  console.log('[Bouncer SignIn Bridge] Provider:', data.providerId);

  chrome.runtime.sendMessage({
    type: 'appleSignIn',
    idToken: data.idToken || data.firebaseToken,
    rawNonce: '',
    firebaseToken: data.firebaseToken,
    providerId: data.providerId,
  }).then((response: unknown) => {
    console.log('[Bouncer SignIn Bridge] Background response:', response);
    const success = !!(response as { success?: boolean })?.success;
    ack(event.origin, success, success ? undefined : 'Extension failed to process credential');
  }).catch((err: unknown) => {
    console.error('[Bouncer SignIn Bridge] Error:', err);
    ack(event.origin, false, err instanceof Error ? err.message : String(err));
  });
});

console.log('[Bouncer SignIn Bridge] Listening for sign-in result');
