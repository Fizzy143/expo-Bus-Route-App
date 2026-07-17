import * as Location from 'expo-location';
import { Platform } from 'react-native';

import {
  TRACKING_PROFILE,
  type ForegroundPermissionStatus,
  type LocationTrackingMode,
  type UserLocationSample,
} from './locationTypes';

export interface LocationSubscription {
  remove(): void;
}

interface LocationEventEmitterCompatibility {
  removeSubscription?: (subscription: LocationSubscription) => void;
}

export function ensureLocationEmitterCompatibility(
  emitter: LocationEventEmitterCompatibility
): void {
  if (typeof emitter.removeSubscription === 'function') return;

  emitter.removeSubscription = (subscription) => subscription.remove();
}

ensureLocationEmitterCompatibility(Location.EventEmitter);

export interface LocationAdapter {
  getPermission(): Promise<ForegroundPermissionStatus>;
  requestPermission(): Promise<ForegroundPermissionStatus>;
  hasServices(): Promise<boolean>;
  getCurrentLocation(mode: LocationTrackingMode): Promise<UserLocationSample>;
  watchLocation(
    mode: LocationTrackingMode,
    onLocation: (sample: UserLocationSample) => void,
    onError: (error: Error) => void
  ): Promise<LocationSubscription>;
}

const normalizePermission = (status: string): ForegroundPermissionStatus =>
  status === 'granted' || status === 'denied' ? status : 'undetermined';

const toSample = (location: Location.LocationObject): UserLocationSample => ({
  lat: location.coords.latitude,
  lon: location.coords.longitude,
  accuracy: location.coords.accuracy,
  timestamp: location.timestamp,
});

const hasGeolocationApi = () =>
  Platform.OS !== 'web' ||
  (typeof navigator !== 'undefined' && 'geolocation' in navigator);

export function buildLocationOptions(
  mode: LocationTrackingMode,
  platform: typeof Platform.OS = Platform.OS
): Location.LocationOptions {
  const profile = TRACKING_PROFILE[mode];
  const options: Location.LocationOptions = {
    accuracy: mode === 'trip' ? Location.Accuracy.High : Location.Accuracy.Balanced,
  };

  if (platform !== 'web') options.distanceInterval = profile.distanceInterval;
  if (platform === 'android') options.timeInterval = profile.androidTimeInterval;

  return options;
}

export const expoLocationAdapter: LocationAdapter = {
  async getPermission() {
    if (!hasGeolocationApi()) return 'unavailable';
    const result = await Location.getForegroundPermissionsAsync();
    return normalizePermission(result.status);
  },
  async requestPermission() {
    if (!hasGeolocationApi()) return 'unavailable';
    const result = await Location.requestForegroundPermissionsAsync();
    return normalizePermission(result.status);
  },
  hasServices: () => Location.hasServicesEnabledAsync(),
  async getCurrentLocation(mode) {
    return toSample(await Location.getCurrentPositionAsync(buildLocationOptions(mode)));
  },
  async watchLocation(mode, onLocation, onError) {
    return Location.watchPositionAsync(
      buildLocationOptions(mode),
      (location) => onLocation(toSample(location)),
      (reason) => onError(new Error(reason))
    );
  },
};
