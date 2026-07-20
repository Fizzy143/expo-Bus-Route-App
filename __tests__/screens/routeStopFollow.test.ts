import {
  initialRouteFollowState,
  pauseRouteFollow,
  resumeRouteFollow,
  routeFollowNearestChanged,
} from '../../components/routeStopFollow';

describe('route stop follow', () => {
  it('scrolls to the first known nearest index', () => {
    expect(routeFollowNearestChanged(initialRouteFollowState, 3, 'A')).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 3, scopeKey: 'A' },
      shouldScroll: true,
    });
  });

  it('does not scroll repeatedly for the same index in the same scope', () => {
    expect(routeFollowNearestChanged(
      { pausedAtIndex: null, lastNearestIndex: 3, scopeKey: 'A' },
      3,
      'A'
    ).shouldScroll).toBe(false);
  });

  it('pauses after manual scroll but keeps the marker index updating', () => {
    const paused = pauseRouteFollow(
      { pausedAtIndex: null, lastNearestIndex: 3, scopeKey: 'A' },
      3
    );
    const sameStop = routeFollowNearestChanged(paused, 3, 'A');

    expect(sameStop.shouldScroll).toBe(false);
    expect(sameStop.state).toEqual({
      pausedAtIndex: 3,
      lastNearestIndex: 3,
      scopeKey: 'A',
    });
  });

  it('resumes when the nearest stop advances inside the same scope', () => {
    expect(routeFollowNearestChanged(
      { pausedAtIndex: 3, lastNearestIndex: 3, scopeKey: 'A' },
      4,
      'A'
    )).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 4, scopeKey: 'A' },
      shouldScroll: true,
    });
  });

  it('explicitly resumes on focus or visibility reset', () => {
    expect(resumeRouteFollow({
      pausedAtIndex: 3,
      lastNearestIndex: 3,
      scopeKey: 'A',
    })).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 3, scopeKey: 'A' },
      shouldScroll: true,
    });
  });

  it('scrolls when direction scope changes even if the numeric index is equal', () => {
    expect(routeFollowNearestChanged(
      { pausedAtIndex: null, lastNearestIndex: 2, scopeKey: 'A' },
      2,
      'B'
    )).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: 2, scopeKey: 'B' },
      shouldScroll: true,
    });
  });

  it('does not consume a scope change while the new direction has no candidate', () => {
    const afterNull = routeFollowNearestChanged(
      { pausedAtIndex: null, lastNearestIndex: 2, scopeKey: 'A' },
      null,
      'B'
    );

    expect(afterNull).toEqual({
      state: { pausedAtIndex: null, lastNearestIndex: null, scopeKey: 'A' },
      shouldScroll: false,
    });
    expect(routeFollowNearestChanged(afterNull.state, 2, 'B').shouldScroll).toBe(true);
  });
});
