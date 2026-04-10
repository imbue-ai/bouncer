/**
 * Wrap an async function for use as a DOM event handler.
 * Catches and logs errors so promises are never left floating.
 * Provides a single hook point for adding user-visible error feedback later.
 *
 * Uses fn.name to identify the function in error logs. Named function
 * references get a useful name automatically; arrow wrappers fall back
 * to 'anonymous'.
 */
export function asyncHandler(fn: () => Promise<void>): () => void {
  const name = fn.name || 'anonymous';
  return () => {
    fn().catch(err => {
      console.error(`[Async] Unhandled error in ${name}:`, err);
    });
  };
}
