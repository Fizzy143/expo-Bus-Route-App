import * as Location from 'expo-location';

import {
  buildLocationOptions,
  buildWebPositionOptions,
  ensureLocationEmitterCompatibility,
  getBrowserCurrentLocation,
  watchBrowserLocation,
} from '../../components/locationAdapter';

const browserPosition = (
  latitude: number,
  longitude: number,
  accuracy: number,
  timestamp: number
) => ({
  coords: { latitude, longitude, accuracy },
  timestamp,
}) as GeolocationPosition;

const createFakeBrowserGeolocation = () => {
  let currentSuccess: PositionCallback | undefined;
  let watchSuccess: PositionCallback | undefined;
  let watchError: PositionErrorCallback | undefined;
  const watchId = 37;
  const getCurrentPosition = jest.fn((success: PositionCallback) => {
    currentSuccess = success;
  });
  const watchPosition = jest.fn((
    success: PositionCallback,
    error?: PositionErrorCallback | null
  ) => {
    watchSuccess = success;
    watchError = error ?? undefined;
    return watchId;
  });
  const clearWatch = jest.fn();

  return {
    geolocation: {
      getCurrentPosition,
      watchPosition,
      clearWatch,
    } as unknown as Geolocation,
    getCurrentPosition,
    watchPosition,
    clearWatch,
    watchId,
    emitCurrent(position: GeolocationPosition) {
      currentSuccess?.(position);
    },
    emitWatch(position: GeolocationPosition) {
      watchSuccess?.(position);
    },
    emitError(message: string) {
      watchError?.({ message } as GeolocationPositionError);
    },
  };
};

describe('buildLocationOptions', () => {
  it('uses balanced 50m plus a 15s Android hint for standard mode', () => {
    expect(buildLocationOptions('standard', 'android')).toEqual({
      accuracy: Location.Accuracy.Balanced,
      distanceInterval: 50,
      timeInterval: 15_000,
    });
  });

  it('uses high 10m without an iOS time guarantee for trip mode', () => {
    expect(buildLocationOptions('trip', 'ios')).toEqual({
      accuracy: Location.Accuracy.High,
      distanceInterval: 10,
    });
  });

  it('does not pass native interval hints to web', () => {
    expect(buildLocationOptions('trip', 'web')).toEqual({
      accuracy: Location.Accuracy.High,
    });
  });
});

describe('ensureLocationEmitterCompatibility', () => {
  it('removes through the subscription when the native emitter lacks the legacy method', () => {
    const emitter: {
      removeSubscription?: (subscription: { remove(): void }) => void;
    } = {};
    const subscription = { remove: jest.fn() };

    expect(ensureLocationEmitterCompatibility).toEqual(expect.any(Function));
    ensureLocationEmitterCompatibility(emitter);
    emitter.removeSubscription!(subscription);

    expect(subscription.remove).toHaveBeenCalledTimes(1);
  });
});

describe('browser geolocation adapter', () => {
  it('uses fresh high-accuracy positions in trip mode', () => {
    expect(buildWebPositionOptions('trip')).toEqual({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 15_000,
    });
  });

  it('allows only a bounded cache in standard mode', () => {
    expect(buildWebPositionOptions('standard')).toEqual({
      enableHighAccuracy: false,
      maximumAge: 15_000,
      timeout: 15_000,
    });
  });

  it('normalizes a browser one-shot position', async () => {
    const fake = createFakeBrowserGeolocation();
    const pending = getBrowserCurrentLocation(fake.geolocation, 'trip');

    expect(fake.getCurrentPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      buildWebPositionOptions('trip')
    );
    fake.emitCurrent(browserPosition(25.02, 121.54, 30, 2000));

    await expect(pending).resolves.toEqual({
      lat: 25.02,
      lon: 121.54,
      accuracy: 30,
      timestamp: 2000,
    });
  });

  it('forwards watch samples and errors and clears the browser watch', () => {
    const fake = createFakeBrowserGeolocation();
    const onLocation = jest.fn();
    const onError = jest.fn();
    const subscription = watchBrowserLocation(
      fake.geolocation,
      'trip',
      onLocation,
      onError
    );

    expect(fake.watchPosition).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      buildWebPositionOptions('trip')
    );
    fake.emitWatch(browserPosition(25.03, 121.55, 40, 3000));
    expect(onLocation).toHaveBeenCalledWith({
      lat: 25.03,
      lon: 121.55,
      accuracy: 40,
      timestamp: 3000,
    });

    fake.emitError('temporarily unavailable');
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'temporarily unavailable' })
    );

    subscription.remove();
    expect(fake.clearWatch).toHaveBeenCalledWith(fake.watchId);
  });
});
