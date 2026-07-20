import {
  LOCATION_ACCURACY,
  type LocationSnapshot,
  type LocationTrackingMode,
  type UserLocationSample,
} from './locationTypes';

const FAST_RETRY_DELAYS = [1000, 2000, 5000] as const;
const CAPPED_RETRY_DELAY: Record<LocationTrackingMode, number> = {
  trip: 15_000,
  standard: 30_000,
};

export function getLocationRetryDelay(
  attempt: number,
  mode: LocationTrackingMode
): number {
  return FAST_RETRY_DELAYS[attempt] ?? CAPPED_RETRY_DELAY[mode];
}

export interface LocationDecision {
  accepted: boolean;
  quality: 'reliable' | 'degraded' | 'ignored';
  snapshot: LocationSnapshot;
}

export function acceptLocationSample(
  previous: LocationSnapshot,
  candidate: UserLocationSample
): LocationDecision {
  const values = [candidate.lat, candidate.lon, candidate.timestamp];
  if (values.some(value => !Number.isFinite(value))) {
    return { accepted: false, quality: 'ignored', snapshot: previous };
  }

  if (previous.location && candidate.timestamp <= previous.location.timestamp) {
    return { accepted: false, quality: 'ignored', snapshot: previous };
  }

  if (
    candidate.accuracy !== null &&
    (!Number.isFinite(candidate.accuracy) ||
      candidate.accuracy > LOCATION_ACCURACY.maximumUsableMeters)
  ) {
    return { accepted: false, quality: 'ignored', snapshot: previous };
  }

  const reliable =
    candidate.accuracy !== null &&
    candidate.accuracy <= LOCATION_ACCURACY.reliableMeters;

  return {
    accepted: true,
    quality: reliable ? 'reliable' : 'degraded',
    snapshot: {
      location: candidate,
      hasReliableLocation: reliable,
    },
  };
}

export function createLatestThrottle<T>(intervalMs: number, emit: (value: T) => void) {
  let lastEmittedAt: number | null = null;
  let queued: T | undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    timer = null;
    if (queued === undefined) return;

    const value = queued;
    queued = undefined;
    lastEmittedAt = Date.now();
    emit(value);
  };

  return {
    push(value: T) {
      const now = Date.now();
      if (lastEmittedAt === null || now - lastEmittedAt >= intervalMs) {
        if (timer) clearTimeout(timer);
        timer = null;
        queued = undefined;
        lastEmittedAt = now;
        emit(value);
        return;
      }

      queued = value;
      if (!timer) {
        timer = setTimeout(flush, intervalMs - (now - lastEmittedAt));
      }
    },
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
      queued = undefined;
    },
  };
}
