/** Official JS-context API (not DispatchQueue / UIKit dispatch):
 * https://scriptingapp.github.io/guide/Utilities/Thread.md
 * Despite the page's "synchronous execution" wording, runInMain returns void
 * and device evidence shows deferred callbacks. Await the callback, not dispatch.
 * No guarantee is made about the execution queue after any await/native callback.
 */
function mainFlag(): string {
  try { return typeof Thread === "undefined" ? "unknown" : String(Thread.isMainThread) } catch (_) { return "unknown" }
}
function message(error: any): string { return String(error?.message || error) }

/** For asynchronous phases/UI only. Never use this to return a synchronous
 * ItemProvider or performDrop boolean; those callbacks must return directly.
 */
export function localImportOnMain<T>(phase: string, task: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let started = false
    let cancelled = false
    let callMain = "unknown"
    const available = typeof Thread !== "undefined" && typeof Thread.runInMain === "function"
    const dispatch = mainFlag() === "true" ? "direct-main" : available ? "runInMain" : "unavailable"
    const fail = (error: unknown) => reject(new Error(`[导入:${phase}; callMain=${callMain}; errorMain=${mainFlag()}; Thread=${dispatch}] ${message(error)}`))
    const execute = () => {
      if (started || cancelled) return
      started = true
      callMain = mainFlag()
      try { Promise.resolve(task()).then(resolve, fail) }
      catch (error) { fail(error) }
    }
    try {
      // isMainThread describes the CURRENT JS context, not an await continuation.
      if (dispatch === "runInMain") Thread.runInMain(execute)
      else execute() // Older runtime: no invented scheduler; diagnostic says unavailable.
    } catch (error) {
      // A dispatch failure before callback must not leave a delayed side effect.
      // If execution already started, its own result/error remains authoritative.
      if (!started) { cancelled = true; fail(error) }
    }
  })
}

export function localImportStep<T>(phase: string, task: () => T | Promise<T>): Promise<T> {
  return localImportOnMain(phase, task)
}
