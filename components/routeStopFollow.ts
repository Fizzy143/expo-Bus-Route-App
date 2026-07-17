export interface RouteFollowState {
  pausedAtIndex: number | null;
  lastNearestIndex: number | null;
}

export interface RouteFollowResult {
  state: RouteFollowState;
  shouldScroll: boolean;
}

export const initialRouteFollowState: RouteFollowState = {
  pausedAtIndex: null,
  lastNearestIndex: null,
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
  nearestIndex: number | null
): RouteFollowResult {
  if (nearestIndex === null) {
    return { state: { ...state, lastNearestIndex: null }, shouldScroll: false };
  }

  const movedToAnotherStop =
    state.pausedAtIndex !== null && nearestIndex !== state.pausedAtIndex;
  const followingAndChanged =
    state.pausedAtIndex === null && nearestIndex !== state.lastNearestIndex;

  return {
    state: {
      pausedAtIndex: movedToAnotherStop ? null : state.pausedAtIndex,
      lastNearestIndex: nearestIndex,
    },
    shouldScroll: movedToAnotherStop || followingAndChanged,
  };
}
