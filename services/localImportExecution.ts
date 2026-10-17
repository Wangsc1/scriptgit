/** Official JS-context API (not DispatchQueue / UIKit dispatch):
 * https://scriptingapp.github.io/guide/Utilities/Thread.md
 * runInMain is synchronous and returns void. It does NOT promise that a later
 * Promise/native callback resumes on that same execution queue.
 */
function mainFlag(): string {
  try { return typeof Thread === "undefined" ? "unknown" : String(Thread.isMainThread) } catch (_) { return "unknown" }
}
function message(error: any): string { return String(error?.message || error) }

/** Initiate one phase on the documented main context; do not use a timer as dispatch. */
export function localImportOnMain<T>(phase: string, task: () => T): T {
  let value!: T
  let called = false
  let callMain = "unknown"
  let failed = false
  let taskError: unknown
  const available = typeof Thread !== "undefined" && typeof Thread.runInMain === "function"
  const execute = () => {
    called = true; callMain = mainFlag()
    try { value = task() } catch (error) { failed = true; taskError = error }
  }
  try {
    if (available) Thread.runInMain(execute)
    else execute() // Older runtime: no invented scheduler; diagnostic explicitly says unavailable.
    if (!called) throw new Error("Thread.runInMain 未同步执行回调，与公开接口约定不符")
    if (failed) throw taskError
    return value
  } catch (error) {
    throw new Error(`[导入:${phase}; callMain=${callMain}; errorMain=${mainFlag()}; Thread=${available ? "runInMain" : "unavailable"}] ${message(error)}`)
  }
}

export async function localImportStep<T>(phase: string, task: () => T | Promise<T>): Promise<T> {
  let callMain = "unknown"
  const dispatch = typeof Thread !== "undefined" && typeof Thread.runInMain === "function" ? "runInMain" : "unavailable"
  try {
    return await localImportOnMain(phase, () => { callMain = mainFlag(); return task() })
  } catch (error) {
    const text = message(error)
    if (text.startsWith(`[导入:${phase};`)) throw error
    throw new Error(`[导入:${phase}; callMain=${callMain}; errorMain=${mainFlag()}; Thread=${dispatch}] ${text}`)
  }
}
