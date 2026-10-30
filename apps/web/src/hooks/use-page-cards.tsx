import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
} from 'react';

export type PageCard = {
  id: string;
  title: string;
  content: React.ReactNode;
  actions?: React.ReactNode;
  collapsible?: boolean;
};

type Registration = { owner: symbol; label: string; cards: PageCard[] };
const RegistrationContext = createContext<{
  register: (value: Registration) => void;
  unregister: (owner: symbol) => void;
} | null>(null);
export const PageCardsContext = createContext<Registration | null>(null);

export function PageCardsProvider({ children }: { children: React.ReactNode }) {
  const [registration, setRegistration] = useState<Registration | null>(null);
  // Keep registration independent of card updates so page content doesn't
  // render again just because the shared card area received its content.
  const actions = useMemo(
    () => ({
      register: setRegistration,
      unregister: (owner: symbol) =>
        setRegistration((current) =>
          current?.owner === owner ? null : current,
        ),
    }),
    [],
  );
  return (
    <RegistrationContext.Provider value={actions}>
      <PageCardsContext.Provider value={registration}>
        {children}
      </PageCardsContext.Provider>
    </RegistrationContext.Provider>
  );
}

/** Supply the right-hand cards for the mounted page; unmounting clears them. */
export function usePageCards(cards: PageCard[], label = 'Page information') {
  const registration = useContext(RegistrationContext);
  if (!registration)
    throw new Error('usePageCards requires a PageCardsProvider.');
  const [owner] = useState(() => Symbol('page-cards'));
  useLayoutEffect(() => {
    registration.register({ owner, cards, label });
  }, [registration, owner, cards, label]);
  useLayoutEffect(
    () => () => registration.unregister(owner),
    [registration, owner],
  );
}
