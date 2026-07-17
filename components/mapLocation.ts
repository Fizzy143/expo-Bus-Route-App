import type { UserLocationSample } from './locationTypes';

export interface MapRegion {
  latitude: number;
  longitude: number;
  latitudeDelta: number;
  longitudeDelta: number;
}

export const regionFromLocation = (
  location: UserLocationSample,
  latitudeDelta = 0.012,
  longitudeDelta = 0.012
): MapRegion => ({
  latitude: location.lat,
  longitude: location.lon,
  latitudeDelta,
  longitudeDelta,
});

export const shouldInitializeRegion = (
  region: MapRegion | null,
  location: UserLocationSample | null
) => region === null && location !== null;
