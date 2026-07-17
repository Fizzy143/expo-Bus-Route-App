export type LocationStatus =
  | 'requesting'
  | 'tracking'
  | 'paused'
  | 'denied'
  | 'unavailable'
  | 'degraded';

export type LocationTrackingMode = 'standard' | 'trip';

export type ForegroundPermissionStatus =
  | 'undetermined'
  | 'granted'
  | 'denied'
  | 'unavailable';

export interface UserLocationSample {
  lat: number;
  lon: number;
  accuracy: number | null;
  timestamp: number;
}

export interface LocationSnapshot {
  location: UserLocationSample | null;
  hasReliableLocation: boolean;
}

export const LOCATION_ACCURACY = {
  reliableMeters: 100,
  maximumUsableMeters: 200,
} as const;

export const TRACKING_PROFILE = {
  standard: { distanceInterval: 50, androidTimeInterval: 15_000 },
  trip: { distanceInterval: 10, androidTimeInterval: 3_000, throttleMs: 3_000 },
} as const;
