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

  it('retries the permission request after a transient rejection', async () => {
    const fake = createFakeLocationAdapter({
      permission: 'undetermined',
      requestPermission: 'granted',
    });
    (fake.adapter.requestPermission as jest.Mock).mockRejectedValueOnce(
      new Error('transient auth error')
    );
    const runtime = createFakeRuntime();

    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await waitFor(() => expect(result.current.status).toBe('degraded'));
    expect(fake.adapter.requestPermission).toHaveBeenCalledTimes(1);

    await act(() => result.current.refresh());

    await waitFor(() =>
      expect(fake.adapter.requestPermission).toHaveBeenCalledTimes(2)
    );
    await waitFor(() =>
      expect(fake.adapter.watchLocation).toHaveBeenCalledTimes(1)
    );
    expect(result.current.permissionStatus).toBe('granted');
    expect(result.current.status).toBe('tracking');
  });

  it('deduplicates concurrent in-flight permission requests', async () => {
    const fake = createFakeLocationAdapter({
      permission: 'undetermined',
      requestPermission: 'granted',
    });
    let resolveRequest!: (status: 'granted') => void;
    (fake.adapter.requestPermission as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<'granted'>((resolve) => {
          resolveRequest = resolve;
        })
    );
    const session = createLocationPermissionSession();

    const first = session.resolve(fake.adapter);
    const second = session.resolve(fake.adapter);

    await waitFor(() =>
      expect(fake.adapter.requestPermission).toHaveBeenCalledTimes(1)
    );
    resolveRequest('granted');

    await expect(Promise.all([first, second])).resolves.toEqual([
      'granted',
      'granted',
    ]);
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

  it('advances to a newer usable degraded watcher sample without recreating the watch', async () => {
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

    expect(result.current.location).toMatchObject({
      lat: 25.5,
      lon: 121.5,
      accuracy: 150,
      timestamp: 2000,
    });
    expect(result.current.status).toBe('degraded');
    expect(fake.watches).toHaveLength(1);
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

  it('continues standard retries every 30s after the fast ramp', async () => {
    jest.useFakeTimers();
    const fake = createFakeLocationAdapter();
    (fake.adapter.getCurrentLocation as jest.Mock).mockRejectedValue(new Error('temporary'));
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.status).toBe('degraded');

    for (const [delay, attempts] of [
      [1000, 2],
      [2000, 3],
      [5000, 4],
      [30_000, 5],
      [30_000, 6],
    ] as const) {
      await act(async () => {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(attempts);
    }
  });

  it('recovers after the capped retry and resets a later watcher error to 1s', async () => {
    jest.useFakeTimers();
    const fake = createFakeLocationAdapter();
    (fake.adapter.getCurrentLocation as jest.Mock)
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'))
      .mockRejectedValueOnce(new Error('temporary'));
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await act(async () => { await Promise.resolve(); });
    for (const delay of [1000, 2000, 5000, 30_000]) {
      await act(async () => {
        jest.advanceTimersByTime(delay);
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(result.current.status).toBe('tracking');
    expect(fake.watches).toHaveLength(1);

    await act(async () => fake.watches[0].onError(new Error('later')));
    await act(async () => { jest.advanceTimersByTime(999); });
    expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(5);
    await act(async () => {
      jest.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(6);
  });

  it('cancels a pending retry while hidden', async () => {
    jest.useFakeTimers();
    const fake = createFakeLocationAdapter();
    (fake.adapter.getCurrentLocation as jest.Mock).mockRejectedValue(new Error('temporary'));
    const runtime = createFakeRuntime();
    const { result } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await act(async () => { await Promise.resolve(); });
    await act(async () => runtime.setVisible(false));
    await waitFor(() => expect(result.current.status).toBe('paused'));
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry on unmount', async () => {
    jest.useFakeTimers();
    const fake = createFakeLocationAdapter();
    (fake.adapter.getCurrentLocation as jest.Mock).mockRejectedValue(new Error('temporary'));
    const runtime = createFakeRuntime();
    const { unmount } = await renderHook(() => useUserLocation(), {
      wrapper: makeWrapper(fake.adapter, runtime.runtime),
    });

    await act(async () => { await Promise.resolve(); });
    await unmount();
    await act(async () => { jest.advanceTimersByTime(60_000); });
    expect(fake.adapter.getCurrentLocation).toHaveBeenCalledTimes(1);
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
