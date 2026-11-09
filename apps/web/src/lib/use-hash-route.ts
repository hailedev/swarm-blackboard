import { useCallback, useSyncExternalStore } from 'react';

// The selected run lives in the URL fragment (#/runs/<id>), so a reload or a pasted link
// opens the same run. One route is not worth a router.

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange);
  return () => {
    window.removeEventListener('hashchange', onChange);
  };
};

const readHash = (): string => window.location.hash;

/** Outside a browser (the static-markup tests) there is no fragment: no run is selected. */
const noHash = (): string => '';

const RUN_ROUTE = /^#\/runs\/([^/]+)$/;

/** The run id a fragment names, or null. */
export const runIdFromHash = (hash: string): string | null => {
  const match = RUN_ROUTE.exec(hash);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
};

export const hashForRun = (runId: string | null): string =>
  runId === null ? '#/' : `#/runs/${encodeURIComponent(runId)}`;

export const useSelectedRun = (): [string | null, (runId: string | null) => void] => {
  const hash = useSyncExternalStore(subscribe, readHash, noHash);
  const select = useCallback((runId: string | null) => {
    window.location.hash = hashForRun(runId);
  }, []);
  return [runIdFromHash(hash), select];
};
