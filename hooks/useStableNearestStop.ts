import { useEffect, useMemo, useRef, useState } from 'react';

import {
  advanceStableNearest,
  initialStableNearestState,
  rankNearestCandidates,
  type LocatedStopCandidate,
} from '../components/nearestStop';
import type { UserLocationSample } from '../components/locationTypes';

export function useStableNearestStop(
  location: UserLocationSample | null,
  candidates: LocatedStopCandidate[],
  scopeKey: string
) {
  const [state, setState] = useState(initialStableNearestState);
  const scopeKeyRef = useRef(scopeKey);
  const ranked = useMemo(
    () => (location ? rankNearestCandidates(location, candidates) : []),
    [candidates, location]
  );

  useEffect(() => {
    setState((previous) => {
      const baseState = scopeKeyRef.current === scopeKey
        ? previous
        : initialStableNearestState;
      scopeKeyRef.current = scopeKey;
      return ranked.length > 0
        ? advanceStableNearest(baseState, ranked)
        : initialStableNearestState;
    });
  }, [ranked, scopeKey]);

  return ranked.find((candidate) => candidate.key === state.currentKey) ?? null;
}
