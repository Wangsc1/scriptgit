/**
 * Compatibility entry points for existing operation callers.
 * Operations already show their results inside the app (toast/dialog/result rows).
 * Never read legacy notification preferences, request permission, or schedule system alerts.
 */
type SyncKind = "commit" | "push" | "pull" | "fetch" | "clone"

export async function notifySync(
  _kind: SyncKind,
  _repoName: string,
  _detail?: string
): Promise<void> {}

export async function notifyError(
  _kind: SyncKind,
  _repoName: string,
  _message: string
): Promise<void> {}
