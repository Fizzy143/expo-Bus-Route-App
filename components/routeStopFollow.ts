export interface RouteFollowState {
  pausedAtIndex: number | null;
  lastNearestIndex: number | null;
  scopeKey: string | null;
}

export interface RouteFollowResult {
  state: RouteFollowState;
  shouldScroll: boolean;
}

export const initialRouteFollowState: RouteFollowState = {
  pausedAtIndex: null,
  lastNearestIndex: null,
  scopeKey: null,
};

export function pauseRouteFollow(
  state: RouteFollowState,
  currentNearestIndex: number | null
): RouteFollowState {
  return { ...state, pausedAtIndex: currentNearestIndex };
}

export function resumeRouteFollow(state: RouteFollowState): RouteFollowResult {
  return {
    state: { ...state, pausedAtIndex: null },
    shouldScroll: state.lastNearestIndex !== null,
  };
}

export function routeFollowNearestChanged(
  state: RouteFollowState,
  nearestIndex: number | null,
  scopeKey: string
): RouteFollowResult {
  if (nearestIndex === null) {
    return { state: { ...state, lastNearestIndex: null }, shouldScroll: false };
  }

  if (state.scopeKey !== scopeKey) {
    return {
      state: { pausedAtIndex: null, lastNearestIndex: nearestIndex, scopeKey },
      shouldScroll: true,
    };
  }

  const movedToAnotherStop =
    state.pausedAtIndex !== null && nearestIndex !== state.pausedAtIndex;
  const followingAndChanged =
    state.pausedAtIndex === null && nearestIndex !== state.lastNearestIndex;

  return {
    state: {
      pausedAtIndex: movedToAnotherStop ? null : state.pausedAtIndex,
      lastNearestIndex: nearestIndex,
      scopeKey,
    },
    shouldScroll: movedToAnotherStop || followingAndChanged,
  };
}
