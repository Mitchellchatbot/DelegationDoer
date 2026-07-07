"use client";

import { useEffect } from "react";

// Locks <body> scroll while `locked` is true and restores the prior inline
// value on unlock/unmount. Used by the mobile nav + inbox-tree drawers so the
// page behind the overlay doesn't scroll. Mirrors the save/restore pattern in
// ThreadConversation.tsx so nested locks don't clobber each other's value.
export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [locked]);
}
