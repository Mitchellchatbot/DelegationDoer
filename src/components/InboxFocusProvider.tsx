"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from "react";

// Shared "focus mode" state for the inbox surface. Provided high up (the
// inboxes layout) so BOTH sibling subtrees can react: the InboxTree rail and
// the InboxSplit thread list collapse to give the reply composer maximum room.
//
// The reply composer toggles it; the rail + list column animate away. The
// global DD sidebar is outside this provider and is deliberately left untouched.
//
// Default value is a harmless no-op so any consumer rendered outside the
// provider (e.g. a non-inbox route reusing a component) just behaves as if
// focus mode is always off.

interface InboxFocusCtx {
  focusMode: boolean;
  setFocusMode: (v: boolean) => void;
}

const Ctx = createContext<InboxFocusCtx>({
  focusMode: false,
  setFocusMode: () => {}
});

export const useInboxFocus = () => useContext(Ctx);

export function InboxFocusProvider({ children }: { children: ReactNode }) {
  const [focusMode, setFocusMode] = useState(false);
  const value = useMemo<InboxFocusCtx>(
    () => ({ focusMode, setFocusMode }),
    [focusMode]
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
