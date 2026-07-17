import React, { StrictMode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  createLocationPermissionSession,
  LocationProvider,
  useUserLocation,
} from '../../components/LocationProvider';
import { createFakeLocationAdapter, createFakeRuntime } from './locationTestDoubles';

const makeWrapper = (
  adapter: ReturnType<typeof createFakeLocationAdapter>['adapter'],
  runtime: ReturnType<typeof createFakeRuntime>['runtime'],
  strict = false
) => {
  const permissionSession = createLocationPermissionSession();

  return function Wrapper({ children }: React.PropsWithChildren) {
    const tree = (
      <LocationProvider
        adapter={adapter}
        runtime={runtime}
        permissionSession={permissionSession}
      >
        {children}
      </LocationProvider>
    );

    return strict ? <StrictMode>{tree}</StrictMode> : tree;
  };
};

describe('LocationProvider', () => {
  afterEach(() => jest.useRealTimers());

  it('requests an undetermined permission only once under StrictMode', async () => {
    const fake = createFakeLocationAdapter({
      permission: 'undetermined',
      requestPermission: 'granted',
    });
    const runtime = createFakeRuntime();
    await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime, true),
    });

    await waitFor(() => expect(fake.adapter.watchLocation).toHaveBeenCalled());
    expect(fake.adapter.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('replaces standard with trip without leaving two active watches', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(fake.watches).toHaveLength(1));
    expect(fake.watches[0].mode).toBe('standard');

    await act(() => result.current.setTrackingMode('trip'));
    await waitFor(() => expect(fake.watches).toHaveLength(2));
    expect(fake.watches[0].removed).toBe(true);
    expect(fake.watches[1]).toMatchObject({ mode: 'trip', removed: false });
  });

  it('removes the watch while hidden and gets a fresh position on resume', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(fake.watches).toHaveLength(1));

    await act(() => runtime.setVisible(false));
    await waitFor(() => expect(result.current.status).toBe('paused'));
    expect(fake.watches[0].removed).toBe(true);

    fake.setSample({ lat: 25.02, lon: 121.54, accuracy: 15, timestamp: 2000 });
    await act(() => runtime.setVisible(true));
    await waitFor(() => expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(fake.watches).toHaveLength(2));
    expect(result.current.location?.timestamp).toBe(2000);
  });

  it('pauses native tracking when the app becomes inactive', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(fake.watches).toHaveLength(1));

    await act(() => runtime.setActive(false));
    await waitFor(() => expect(result.current.status).toBe('paused'));
    expect(fake.watches[0].removed).toBe(true);
  });

  it('ignores a delayed callback from a removed generation', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(fake.watches).toHaveLength(1));
    await act(() => result.current.setTrackingMode('trip'));
    await waitFor(() => expect(fake.watches).toHaveLength(2));

    await act(() => fake.watches[0].onLocation({
      lat: 99,
      lon: 99,
      accuracy: 10,
      timestamp: 9000,
    }));

    expect(result.current.location?.lat).not.toBe(99);
  });

  it('keeps the last reliable position when a degraded sample arrives', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(result.current.location?.timestamp).toBe(1000));

    await act(() => fake.watches[0].onLocation({
      lat: 25.5,
      lon: 121.5,
      accuracy: 150,
      timestamp: 2000,
    }));

    expect(result.current.location?.timestamp).toBe(1000);
  });

  it('does not watch or retry when permission is denied', async () => {
    const fake = createFakeLocationAdapter({ permission: 'denied' });
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await waitFor(() => expect(result.current.status).toBe('denied'));
    expect(fake.adapter.requestPermission).not.toHaveBeenCalled();
    expect(fake.adapter.watchLocation).not.toHaveBeenCalled();
  });

  it('reports unavailable services without requesting a position', async () => {
    const fake = createFakeLocationAdapter({ services: false });
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
    expect(fake.adapter.getCurrentLocation).not.toHaveBeenCalled();
    expect(fake.adapter.watchLocation).not.toHaveBeenCalled();
  });

  it('retries transient startup failures after 1s, 2s, and 5s only', async () => {
    jest.useFakeTimers();
    const fake = createFakeLocationAdapter();
    (fake.adapter.getCurrentLocation as jest.Mock).mockRejectedValue(new Error('temporary'));
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('degraded');

    for (const [delay, attempts] of [[1000, 2], [2000, 3], [5000, 4]] as const) {
      await act(async () => {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(attempts);
    }

    await act(async () => { jest.advanceTimersByTime(30_000); });
    expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(4);
  });

  it('removes the active watch on unmount', async () => {
    const fake = createFakeLocationAdapter();
    const runtime = createFakeRuntime();
    const { unmount } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await waitFor(() => expect(fake.watches).toHaveLength(1));

    await unmount();
    expect(fake.watches[0].removed).toBe(true);
  });
});
