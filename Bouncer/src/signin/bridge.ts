// Content script injected on bouncer.imbue.com and bouncer-dev.imbue.com
// Listens for postMessage from the hosted sign-in page, forwards the
// credential to the extension's background script, and posts an ack back
// to the page so it can tell whether delivery actually happened.

function ack(success: boolean, error?: string): void {
  window.postMessage({ type: 'bouncer-bridge-ack', success, error }, '*');
}

interface SigninResultMessage {
  type: 'bouncer-signin-result';
  providerId?: string;
  idToken?: string;
  firebaseToken?: string;
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
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
    ack(success, success ? undefined : 'Extension failed to process credential');
  }).catch((err: unknown) => {
    console.error('[Bouncer SignIn Bridge] Error:', err);
    ack(false, err instanceof Error ? err.message : String(err));
  });
});

console.log('[Bouncer SignIn Bridge] Listening for sign-in result');
