"use client";

import { createContext, useContext } from "react";
import type { User } from "@/lib/types";

// React context that exposes the auth'd user to client components.
// The (main) layout fetches the user server-side and provides it here, so
// pages and dialogs don't have to reach into mock-data for "who am I".

const UserContext = createContext<User | null>(null);

export function UserProvider({ user, children }: { user: User; children: React.ReactNode }) {
  return <UserContext.Provider value={user}>{children}</UserContext.Provider>;
}

export function useCurrentUser(): User {
  const u = useContext(UserContext);
  if (!u) throw new Error("useCurrentUser must be used inside <UserProvider>");
  return u;
}
