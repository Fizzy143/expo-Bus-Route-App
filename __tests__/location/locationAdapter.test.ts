import * as Location from 'expo-location';

import {
  buildLocationOptions,
  ensureLocationEmitterCompatibility,
} from '../../components/locationAdapter';

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
