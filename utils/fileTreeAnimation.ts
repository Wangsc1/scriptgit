import { Transition } from "scripting"

/**
 * Local row insertion/removal only: do not fade tree content while the native
 * DisclosureGroup animates its layout and chevron. This is NOT animation=null,
 * and does not change the parent's expansion animation/transaction.
 * Shared by the real tree and diagnostic ⑤ so the phone comparison is exact.
 * Native List/DisclosureGroup may still impose an internal transition; only a
 * device recording can establish whether the bridge honors this row modifier.
 * Official API: /guide/View%20Modifiers/Animation%20and%20Transition.md
 */
export const fileTreeRowTransition = Transition.identity()
