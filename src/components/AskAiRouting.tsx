"use client";

import { createContext, useContext, type ReactNode } from "react";

// Which body the Ask AI drawer shows on this page load. The layout works it
// out on the server and passes one boolean down; every drawer mount (the
// floating button, the sidebar shortcut, a client page's button) reads it
// here. Off unless the server said so. It is a display choice only: the
// endpoint behind the other body checks everything again.
//
// This file ships to every signed-in browser, so it names nothing but the
// switch itself.

export interface AskAiRouting {
  routed: boolean;
  /** Whether his mailbox can be read (only ever true when routed); the routed body's copy follows it. */
  emailOn: boolean;
}

const AskAiRoutingContext = createContext<AskAiRouting>(Object.freeze({ routed: false, emailOn: false }));

export function AskAiRoutingProvider({ routed, emailOn = false, children }: { routed: boolean; emailOn?: boolean; children?: ReactNode }) {
  return <AskAiRoutingContext.Provider value={{ routed: routed === true, emailOn: routed === true && emailOn === true }}>{children}</AskAiRoutingContext.Provider>;
}

export function useAskAiRouting(): AskAiRouting {
  return useContext(AskAiRoutingContext);
}
