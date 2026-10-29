'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * **Which account this surface is rendered for**, as a fact the client can key on.
 *
 * The member layout resolves the actor on the server and hands the id down once. It is here for
 * exactly one kind of consumer: client code that keeps something *on the device* under the
 * account — the note draft in local storage is the first — and must never read back what another
 * account wrote. It is **never what permits anything**: the API refuses independently
 * ([3.1.5](docs/project/prd.md)), and nothing here is more than an opaque id.
 */
const AccountContext = createContext<string | null>(null);

export function AccountProvider({ userId, children }: { userId: string; children: ReactNode }) {
  return <AccountContext.Provider value={userId}>{children}</AccountContext.Provider>;
}

/**
 * The signed-in account's id. Throws outside the member surface rather than answering `null`: a
 * consumer that keys device storage by account must not quietly key it by nothing.
 */
export function useAccountId(): string {
  const userId = useContext(AccountContext);
  if (userId === null) {
    throw new Error('useAccountId() is only available under the member layout.');
  }
  return userId;
}
