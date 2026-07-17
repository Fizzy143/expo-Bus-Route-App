import { haversineMeters } from './locationService';
import type { UserLocationSample } from './locationTypes';

export interface LocatedStopCandidate {
  key: string;
  name: string;
  index: number;
  lat: number;
  lon: number;
}

export interface RankedStopCandidate extends LocatedStopCandidate {
  distance: number;
}

export interface StableNearestState {
  currentKey: string | null;
  pendingKey: string | null;
  pendingCount: number;
}

export const initialStableNearestState: StableNearestState = {
  currentKey: null,
  pendingKey: null,
  pendingCount: 0,
};

export function rankNearestCandidates(
  location: UserLocationSample,
  candidates: LocatedStopCandidate[]
): RankedStopCandidate[] {
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      distance: haversineMeters(location.lat, location.lon, candidate.lat, candidate.lon),
    }))
    .sort((a, b) => a.distance - b.distance);
  const seen = new Set<string>();

  return ranked.filter((candidate) => {
    if (seen.has(candidate.key)) return false;
    seen.add(candidate.key);
    return true;
  });
}

export function advanceStableNearest(
  previous: StableNearestState,
  ranked: RankedStopCandidate[]
): StableNearestState {
  const nearest = ranked[0];
  if (!nearest) return initialStableNearestState;

  if (!previous.currentKey) {
    return { currentKey: nearest.key, pendingKey: null, pendingCount: 0 };
  }

  const current = ranked.find((candidate) => candidate.key === previous.currentKey);
  if (!current || nearest.key === previous.currentKey) {
    return { currentKey: nearest.key, pendingKey: null, pendingCount: 0 };
  }

  if (current.distance - nearest.distance >= 30) {
    return { currentKey: nearest.key, pendingKey: null, pendingCount: 0 };
  }

  const pendingCount = previous.pendingKey === nearest.key ? previous.pendingCount + 1 : 1;
  if (pendingCount >= 2) {
    return { currentKey: nearest.key, pendingKey: null, pendingCount: 0 };
  }

  return { currentKey: previous.currentKey, pendingKey: nearest.key, pendingCount };
}
