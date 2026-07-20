import {
  acceptLocationSample,
  createLatestThrottle,
  getLocationRetryDelay,
} from '../../components/locationPolicy';
import type { LocationSnapshot, UserLocationSample } from '../../components/locationTypes';

const sample = (
  timestamp: number,
  accuracy: number | null,
  lat = 25.013,
  lon = 121.535
): UserLocationSample => ({ lat, lon, accuracy, timestamp });

describe('acceptLocationSample', () => {
  const empty: LocationSnapshot = { location: null, hasReliableLocation: false };

  it('accepts a reliable sample', () => {
    expect(acceptLocationSample(empty, sample(1000, 20))).toEqual({
      accepted: true,
      quality: 'reliable',
      snapshot: { location: sample(1000, 20), hasReliableLocation: true },
    });
  });

  it('rejects stale and accuracy-over-200 samples', () => {
    const current: LocationSnapshot = {
      location: sample(2000, 30),
      hasReliableLocation: true,
    };

    expect(acceptLocationSample(current, sample(2000, 20)).accepted).toBe(false);
    expect(acceptLocationSample(current, sample(3000, 201)).accepted).toBe(false);
  });

  it('does not replace a reliable sample with degraded accuracy', () => {
    const current: LocationSnapshot = {
      location: sample(2000, 30),
      hasReliableLocation: true,
    };

    expect(acceptLocationSample(current, sample(3000, 150))).toEqual({
      accepted: false,
      quality: 'degraded',
      snapshot: current,
    });
  });

  it('temporarily accepts degraded accuracy before any reliable sample', () => {
    const result = acceptLocationSample(empty, sample(1000, null));

    expect(result.accepted).toBe(true);
    expect(result.quality).toBe('degraded');
    expect(result.snapshot.hasReliableLocation).toBe(false);
  });
});

describe('createLatestThrottle', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('emits the first value immediately and only the latest queued value at 3 seconds', () => {
    const emitted: number[] = [];
    const throttle = createLatestThrottle<number>(3000, value => emitted.push(value));

    throttle.push(1);
    throttle.push(2);
    throttle.push(3);
    expect(emitted).toEqual([1]);

    jest.advanceTimersByTime(2999);
    expect(emitted).toEqual([1]);
    jest.advanceTimersByTime(1);
    expect(emitted).toEqual([1, 3]);
    throttle.dispose();
  });

  it('drops the queued value when disposed', () => {
    const emit = jest.fn();
    const throttle = createLatestThrottle(3000, emit);

    throttle.push(1);
    throttle.push(2);
    throttle.dispose();
    jest.advanceTimersByTime(3000);

    expect(emit).toHaveBeenCalledTimes(1);
  });
});

describe('getLocationRetryDelay', () => {
  it('uses the shared 1s, 2s, 5s fast ramp', () => {
    expect([0, 1, 2].map(attempt =>
      getLocationRetryDelay(attempt, 'standard')
    )).toEqual([1000, 2000, 5000]);
  });

  it('caps trip retries at 15 seconds', () => {
    expect(getLocationRetryDelay(3, 'trip')).toBe(15_000);
    expect(getLocationRetryDelay(99, 'trip')).toBe(15_000);
  });

  it('caps standard retries at 30 seconds', () => {
    expect(getLocationRetryDelay(3, 'standard')).toBe(30_000);
    expect(getLocationRetryDelay(99, 'standard')).toBe(30_000);
  });
});
