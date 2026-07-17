import {
  initialRouteFollowState,
  pauseRouteFollow,
  resumeRouteFollow,
  routeFollowNearestChanged,
} from '../../components/routeStopFollow';

describe('route stop follow', () => {
  it('scrolls to the first known nearest index', () => {
    expect(routeFollowNearestChanged(initialRouteFollowState, 3)).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 3 },
      shouldScroll: true,
    });
  });

  it('does not scroll repeatedly while the nearest index is unchanged', () => {
    expect(routeFollowNearestChanged(
      { pausedAtIndex: null, lastNearestIndex: 3 },
      3
    ).shouldScroll).toBe(false);
  });

  it('pauses after manual scroll but keeps the marker index updating', () => {
    const paused = pauseRouteFollow(
      { pausedAtIndex: null, lastNearestIndex: 3 },
      3
    );
    const sameStop = routeFollowNearestChanged(paused, 3);

    expect(sameStop.shouldScroll).toBe(false);
    expect(sameStop.state.lastNearestIndex).toBe(3);
  });

  it('resumes and scrolls when location advances to another stop', () => {
    const paused = { pausedAtIndex: 3, lastNearestIndex: 3 };
    expect(routeFollowNearestChanged(paused, 4)).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 4 },
      shouldScroll: true,
    });
  });

  it('explicitly resumes on direction, focus, or visibility reset', () => {
    expect(resumeRouteFollow({ pausedAtIndex: 3, lastNearestIndex: 3 })).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 3 },
      shouldScroll: true,
    });
  });
});
