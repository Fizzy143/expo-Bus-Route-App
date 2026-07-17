import {
  advanceStableNearest,
  initialStableNearestState,
  rankNearestCandidates,
  type RankedStopCandidate,
} from '../../components/nearestStop';
import { renderHook, waitFor } from '@testing-library/react-native';
import { useStableNearestStop } from '../../hooks/useStableNearestStop';
import { useMemo } from 'react';

const ranked = (aDistance: number, bDistance: number) => [
  { key: 'A', name: 'A', index: 0, lat: 0, lon: 0, distance: aDistance },
  { key: 'B', name: 'B', index: 1, lat: 0, lon: 0, distance: bDistance },
].sort((a, b) => a.distance - b.distance);

describe('advanceStableNearest', () => {
  it('uses the first nearest candidate immediately', () => {
    expect(advanceStableNearest(initialStableNearestState, ranked(20, 80)).currentKey).toBe('A');
  });

  it('switches immediately when the new candidate is at least 30m closer', () => {
    const current = { currentKey: 'A', pendingKey: null, pendingCount: 0 };

    expect(advanceStableNearest(current, ranked(80, 20)).currentKey).toBe('B');
  });

  it('requires two consecutive samples when the advantage is below 30m', () => {
    const current = { currentKey: 'A', pendingKey: null, pendingCount: 0 };
    const once = advanceStableNearest(current, ranked(55, 30));

    expect(once.currentKey).toBe('A');
    expect(advanceStableNearest(once, ranked(54, 29)).currentKey).toBe('B');
  });

  it('resets the pending candidate when the current stop becomes nearest again', () => {
    const once = advanceStableNearest(
      { currentKey: 'A', pendingKey: null, pendingCount: 0 },
      ranked(55, 30)
    );

    expect(advanceStableNearest(once, ranked(20, 60))).toEqual({
      currentKey: 'A',
      pendingKey: null,
      pendingCount: 0,
    });
  });
});

describe('rankNearestCandidates', () => {
  it('deduplicates by key after choosing the closest physical candidate', () => {
    const result = rankNearestCandidates(
      { lat: 0, lon: 0, accuracy: 10, timestamp: 1 },
      [
        { key: 'same', name: 'same', index: 0, lat: 0, lon: 0.002 },
        { key: 'same', name: 'same', index: 1, lat: 0, lon: 0.001 },
      ]
    );

    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(1);
  });
});

describe('useStableNearestStop', () => {
  it('resets pending stability when the candidate scope changes', async () => {
    const candidates = [
      { key: 'A', name: 'A', index: 0, lat: 0, lon: 0 },
      { key: 'B', name: 'B', index: 1, lat: 0, lon: 0.0005 },
    ];
    const { result, rerender } = await renderHook<
      RankedStopCandidate | null,
      { lon: number; scopeKey: string }
    >(
      ({ lon, scopeKey }) => {
        const location = useMemo(
          () => ({ lat: 0, lon, accuracy: 10, timestamp: lon === 0 ? 1 : 2 }),
          [lon]
        );
        return useStableNearestStop(location, candidates, scopeKey);
      },
      { initialProps: { lon: 0, scopeKey: 'direction-a' } }
    );

    await waitFor(() => expect(result.current?.key).toBe('A'));
    await rerender({ lon: 0.0003, scopeKey: 'direction-a' });
    await waitFor(() => expect(result.current?.key).toBe('A'));

    await rerender({ lon: 0.0003, scopeKey: 'direction-b' });
    await waitFor(() => expect(result.current?.key).toBe('B'));
  });
});
