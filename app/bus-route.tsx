import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Location from 'expo-location';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  ListRenderItemInfo,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import PagerView from 'react-native-pager-view';

import {
  BusPlannerService,
  RouteDetails,
  RouteDirectionDetails,
  RouteStopArrival,
} from '../components/busPlanner';
import { haversineMeters, UserLocation } from '../components/locationService';
import WebRouteTransitionView from '../components/WebRouteTransitionView';
import { beginWebRouteTransition } from '../components/web-route-transition';

const DEFAULT_ROUTE_NAME = '606';
const AUTO_REFRESH_MS = 10000;
const LOADING_TEXT = '\u8f09\u5165\u4e2d';
const NO_DATA_TEXT = '\u66ab\u7121\u8cc7\u6599';
const PAGE_TITLE = '\u8def\u7dda\u8a73\u60c5';
const BACK_TEXT = '\u8fd4\u56de';
const REFRESH_TEXT = '\u66f4\u65b0';
const REFRESHING_TEXT = '\u66f4\u65b0\u4e2d';
const RELOAD_TEXT = '\u91cd\u65b0\u8f09\u5165';
const LOAD_FAILED_TEXT = '\u8f09\u5165\u8def\u7dda\u8cc7\u8a0a\u5931\u6557';
const NOT_FOUND_PREFIX = '\u627e\u4e0d\u5230 ';
const NOT_FOUND_SUFFIX = ' \u8def\u7dda\u8cc7\u6599';
const LAST_UPDATED_TEXT = '\u4e0a\u6b21\u66f4\u65b0\uff1a';
const COMING_TEXT = '\u9032\u7ad9\u4e2d';
const SOON_TEXT = '\u5c07\u5230\u7ad9';
const GO_TEXT = '\u53bb\u7a0b';
const BACKWARD_TEXT = '\u8fd4\u7a0b';
const MINUTE_UNIT_TEXT = '\u5206';
const JUST_UPDATED_TEXT = '\u525b\u525b\u66f4\u65b0';
const SOFT_ALERT_MIN_SECONDS = 60;
const SOFT_ALERT_MAX_SECONDS = 180;
const STOP_ROW_HEIGHT = 66;
const NEAREST_STOP_VIEW_POSITION = 0.38;
const CENTER_RETRY_DELAY_MS = 120;
const MAX_CENTER_RETRIES = 4;

function normalizeDirectionText(direction: number, text?: string): string {
  if (text === GO_TEXT || text === BACKWARD_TEXT) {
    return text;
  }

  return direction === 0 ? GO_TEXT : BACKWARD_TEXT;
}

function getDirectionDisplayText(direction: RouteDirectionDetails): string {
  const lastStopName = direction.stops[direction.stops.length - 1]?.name?.trim();
  if (lastStopName) {
    return `往 ${lastStopName}`;
  }

  return normalizeDirectionText(direction.direction, direction.directionText);
}

function formatRelativeUpdateText(lastUpdateAt: number | null, now: number): string {
  if (!lastUpdateAt) {
    return '--';
  }

  const diffSeconds = Math.max(0, Math.floor((now - lastUpdateAt) / 1000));
  if (diffSeconds <= 0) {
    return JUST_UPDATED_TEXT;
  }

  return `${diffSeconds} 秒前更新`;
}

function normalizeEtaText(text: string | undefined, rawTime: number): string {
  if (!text || text === '???' || text === '????' || text === 'No data') {
    return LOADING_TEXT;
  }

  if (text === '\u672a\u767c\u8eca') {
    return text;
  }

  if (text === NO_DATA_TEXT || text === LOADING_TEXT) {
    return text;
  }

  return text;
}

function mergeStops(
  previousStops: RouteStopArrival[] | undefined,
  nextStops: RouteStopArrival[],
  preservePrevious: boolean
): RouteStopArrival[] {
  if (!previousStops || previousStops.length === 0) {
    return nextStops;
  }

  const previousBySid = new Map(previousStops.map(stop => [stop.sid, stop]));

  return nextStops.map(stop => {
    const previous = previousBySid.get(stop.sid);

    if (!previous || !preservePrevious) {
      return stop;
    }

    const nextLooksEmpty =
      normalizeEtaText(stop.etaText, stop.rawTime) === NO_DATA_TEXT ||
      normalizeEtaText(stop.etaText, stop.rawTime) === LOADING_TEXT ||
      stop.rawTime >= 99999;

    const previousHasUsefulEta =
      normalizeEtaText(previous.etaText, previous.rawTime) !== LOADING_TEXT &&
      normalizeEtaText(previous.etaText, previous.rawTime) !== NO_DATA_TEXT;

    if (nextLooksEmpty && previousHasUsefulEta) {
      return previous;
    }

    return stop;
  });
}

function hasDirectionLoaded(direction: RouteDirectionDetails | undefined): boolean {
  if (!direction) {
    return false;
  }

  return direction.stops.some(stop => {
    const text = normalizeEtaText(stop.etaText, stop.rawTime);
    return text !== LOADING_TEXT;
  });
}

export default function BusRouteDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    routeName?: string | string[];
    preferredRid?: string | string[];
    preferredDirection?: string | string[];
  }>();
  const pageTransitionRef = useRef<HTMLElement | null>(null);
  const plannerRef = useRef(new BusPlannerService());
  const pagerRef = useRef<PagerView>(null);
  const selectedDirectionRef = useRef(0);
  const directionListRefs = useRef<Record<number, FlatList<RouteStopArrival> | null>>({});
  const pendingCenterDirectionRef = useRef<number | null>(null);
  const pendingPagerDirectionIndexRef = useRef<number | null>(null);
  const hasAutoCenteredInitialRef = useRef(false);

  const routeName = useMemo(() => {
    if (Array.isArray(params.routeName)) {
      return params.routeName[0] || DEFAULT_ROUTE_NAME;
    }
    return params.routeName || DEFAULT_ROUTE_NAME;
  }, [params.routeName]);

  const preferredDirectionHint = useMemo(() => {
    const rawDirection = Array.isArray(params.preferredDirection)
      ? params.preferredDirection[0]
      : params.preferredDirection;

    if (!rawDirection) {
      return null;
    }

    return rawDirection.trim() || null;
  }, [params.preferredDirection]);

  const preferredRid = useMemo(() => {
    const rawRid = Array.isArray(params.preferredRid) ? params.preferredRid[0] : params.preferredRid;
    return rawRid?.trim() || null;
  }, [params.preferredRid]);

  const [routeDetails, setRouteDetails] = useState<RouteDetails | null>(null);
  const [directionData, setDirectionData] = useState<RouteDirectionDetails[]>([]);
  const [selectedDirection, setSelectedDirection] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [relativeNow, setRelativeNow] = useState(() => Date.now());
  const [userLocation, setUserLocation] = useState<UserLocation | null>(null);
  const [locationReady, setLocationReady] = useState(false);
  const [nearestStopIndexByDirection, setNearestStopIndexByDirection] = useState<Record<number, number>>(
    {}
  );

  const syncPagerToIndex = useCallback((index: number) => {
    const pager = pagerRef.current as
      | (PagerView & {
          setPageWithoutAnimation?: (page: number) => void;
          setPage?: (page: number) => void;
        })
      | null;

    if (!pager) {
      return;
    }

    if (typeof pager.setPageWithoutAnimation === 'function') {
      pager.setPageWithoutAnimation(index);
      return;
    }

    if (typeof pager.setPage === 'function') {
      pager.setPage(index);
    }
  }, []);

  const queueCenterDirection = useCallback((direction: number) => {
    if (Platform.OS !== 'web') {
      return;
    }

    pendingCenterDirectionRef.current = direction;
  }, []);

  const centerNearestStop = useCallback(
    (direction: number, retryCount = 0) => {
      if (Platform.OS !== 'web') {
        return;
      }

      const nearestIndex = nearestStopIndexByDirection[direction];
      if (nearestIndex === undefined) {
        return;
      }

      const list = directionListRefs.current[direction];
      if (!list) {
        if (retryCount < MAX_CENTER_RETRIES) {
          setTimeout(() => centerNearestStop(direction, retryCount + 1), CENTER_RETRY_DELAY_MS);
        }
        return;
      }

      try {
        list.scrollToIndex({
          animated: true,
          index: nearestIndex,
          viewPosition: NEAREST_STOP_VIEW_POSITION,
        });
        if (pendingCenterDirectionRef.current === direction) {
          pendingCenterDirectionRef.current = null;
        }
      } catch {
        if (retryCount < MAX_CENTER_RETRIES) {
          setTimeout(() => centerNearestStop(direction, retryCount + 1), CENTER_RETRY_DELAY_MS);
        } else if (pendingCenterDirectionRef.current === direction) {
          pendingCenterDirectionRef.current = null;
        }
      }
    },
    [nearestStopIndexByDirection]
  );

  const handleScrollToIndexFailed = useCallback(
    (direction: number, averageItemLength?: number, index?: number) => {
      const list = directionListRefs.current[direction];
      if (!list || index === undefined) {
        return;
      }

      list.scrollToOffset({
        animated: true,
        offset: Math.max((averageItemLength || STOP_ROW_HEIGHT) * index, 0),
      });

      setTimeout(() => centerNearestStop(direction, 1), CENTER_RETRY_DELAY_MS);
    },
    [centerNearestStop]
  );

  const handleBackPress = () => {
    beginWebRouteTransition(pageTransitionRef.current, '/', 'back');
    if (Platform.OS === 'web' && typeof window !== 'undefined' && window.history.length <= 1) {
      router.replace('/');
      return;
    }

    router.back();
  };

  const updateSelectedDirection = (index: number) => {
    selectedDirectionRef.current = index;
    setSelectedDirection(index);
  };

  const applyRealtimeDirection = (
    realtimeDirection: RouteDirectionDetails,
    preservePrevious: boolean
  ) => {
    setDirectionData(prev => {
      const previousDirection = prev.find(item => item.direction === realtimeDirection.direction);
      const mergedDirection: RouteDirectionDetails = {
        ...realtimeDirection,
        stops: mergeStops(previousDirection?.stops, realtimeDirection.stops, preservePrevious),
      };

      if (prev.length === 0) {
        return [mergedDirection];
      }

      return prev.map(item =>
        item.direction === mergedDirection.direction ? mergedDirection : item
      );
    });
  };

  const loadSingleDirection = useCallback(
    async (direction: RouteDirectionDetails, preservePrevious: boolean) => {
      const realtimeDirection = await plannerRef.current.getRouteStopArrivals(
        routeName,
        direction.direction
      );

      if (realtimeDirection) {
        applyRealtimeDirection(realtimeDirection, preservePrevious);
        setLastUpdateAt(Date.now());
      }
    },
    [routeName]
  );

  const loadRouteDetails = useCallback(
    async (isRefresh = false) => {
      try {
        if (!isRefresh) {
          setLoading(true);
        }
        setErrorText('');

        const baseDetails = plannerRef.current.getRouteByName(routeName);
        if (!baseDetails) {
          setRouteDetails(null);
          setDirectionData([]);
          setErrorText(`${NOT_FOUND_PREFIX}${routeName}${NOT_FOUND_SUFFIX}`);
          return;
        }

        const resolvedPreferredDirection =
          preferredDirectionHint === null
            ? null
            : plannerRef.current.resolveRouteDirection(
                routeName,
                preferredRid || undefined,
                preferredDirectionHint
              );

        const preferredIndex = (() => {
          if (resolvedPreferredDirection !== null) {
            const exactDirectionMatchIndex = baseDetails.directions.findIndex(
              direction =>
                direction.direction === resolvedPreferredDirection &&
                (!preferredRid || direction.rid === preferredRid)
            );
            if (exactDirectionMatchIndex >= 0) {
              return exactDirectionMatchIndex;
            }

            const directionMatchIndex = baseDetails.directions.findIndex(
              direction => direction.direction === resolvedPreferredDirection
            );
            if (directionMatchIndex >= 0) {
              return directionMatchIndex;
            }
          }

          if (preferredRid) {
            const ridMatchIndex = baseDetails.directions.findIndex(
              direction => direction.rid === preferredRid
            );
            if (ridMatchIndex >= 0) {
              return ridMatchIndex;
            }
          }

          return -1;
        })();

        const orderedDirections =
          preferredIndex > 0
            ? [
                baseDetails.directions[preferredIndex],
                ...baseDetails.directions.filter((_, index) => index !== preferredIndex),
              ]
            : baseDetails.directions;
        const normalizedBaseDetails =
          orderedDirections === baseDetails.directions
            ? baseDetails
            : { ...baseDetails, directions: orderedDirections };

        setRouteDetails(normalizedBaseDetails);
        setDirectionData(prev => (prev.length > 0 ? prev : normalizedBaseDetails.directions));
        setLoading(false);

        if (preferredIndex >= 0) {
          selectedDirectionRef.current = 0;
          setSelectedDirection(0);
          pendingPagerDirectionIndexRef.current = 0;
          queueCenterDirection(normalizedBaseDetails.directions[0].direction);
        }

        const activeIndex = Math.min(
          selectedDirectionRef.current,
          normalizedBaseDetails.directions.length - 1
        );
        const activeDirection =
          normalizedBaseDetails.directions[activeIndex] || normalizedBaseDetails.directions[0];
        await loadSingleDirection(activeDirection, isRefresh);
      } catch (error) {
        console.error('Failed to load route details:', error);
        setErrorText(LOAD_FAILED_TEXT);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [loadSingleDirection, preferredDirectionHint, preferredRid, queueCenterDirection, routeName]
  );

  const ensureDirectionLoaded = useCallback(
    async (index: number) => {
      const direction = directionData[index];
      if (!direction || hasDirectionLoaded(direction)) {
        return;
      }

      try {
        await loadSingleDirection(direction, true);
      } catch (error) {
        console.error('Failed to load selected direction:', error);
      }
    },
    [directionData, loadSingleDirection]
  );

  useEffect(() => {
    const interval = setInterval(() => {
      setRelativeNow(Date.now());
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    selectedDirectionRef.current = 0;
    setSelectedDirection(0);
    setRouteDetails(null);
    setDirectionData([]);
    setUserLocation(null);
    setLocationReady(false);
    setNearestStopIndexByDirection({});
    directionListRefs.current = {};
    pendingCenterDirectionRef.current = null;
    pendingPagerDirectionIndexRef.current = null;
    hasAutoCenteredInitialRef.current = false;
    setLastUpdateAt(null);
    loadRouteDetails();

    const interval = setInterval(() => {
      loadRouteDetails(true);
    }, AUTO_REFRESH_MS);

    return () => clearInterval(interval);
  }, [loadRouteDetails]);

  useEffect(() => {
    if (Platform.OS !== 'web') {
      return;
    }

    let cancelled = false;

    const loadUserLocation = async () => {
      try {
        const permission = await Location.getForegroundPermissionsAsync();
        if (permission.status !== 'granted') {
          if (!cancelled) {
            setLocationReady(true);
          }
          return;
        }

        const location = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Balanced,
        });

        if (!cancelled) {
          setUserLocation({
            lat: location.coords.latitude,
            lon: location.coords.longitude,
          });
        }
      } catch (error) {
        console.warn('Failed to resolve bus-route location:', error);
      } finally {
        if (!cancelled) {
          setLocationReady(true);
        }
      }
    };

    void loadUserLocation();

    return () => {
      cancelled = true;
    };
  }, [routeName]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !locationReady || !userLocation || directionData.length === 0) {
      return;
    }

    const nextNearest: Record<number, number> = {};

    directionData.forEach(direction => {
      let nearestIndex = -1;
      let nearestDistance = Number.POSITIVE_INFINITY;

      direction.stops.forEach((stop, index) => {
        const geo = plannerRef.current.getGeoBySid(stop.sid);
        if (!geo) {
          return;
        }

        const distance = haversineMeters(userLocation.lat, userLocation.lon, geo.lat, geo.lon);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });

      if (nearestIndex >= 0) {
        nextNearest[direction.direction] = nearestIndex;
      }
    });

    setNearestStopIndexByDirection(nextNearest);
  }, [directionData, locationReady, userLocation]);

  useEffect(() => {
    if (Platform.OS !== 'web' || !locationReady) {
      return;
    }

    if (!hasAutoCenteredInitialRef.current && nearestStopIndexByDirection[selectedDirection] !== undefined) {
      queueCenterDirection(selectedDirection);
      hasAutoCenteredInitialRef.current = true;
    }

    if (pendingCenterDirectionRef.current === selectedDirection) {
      centerNearestStop(selectedDirection);
    }
  }, [
    centerNearestStop,
    locationReady,
    nearestStopIndexByDirection,
    queueCenterDirection,
    selectedDirection,
  ]);

  useEffect(() => {
    const pendingIndex = pendingPagerDirectionIndexRef.current;
    if (pendingIndex === null) {
      return;
    }

    if (!directionData[pendingIndex]) {
      return;
    }

    syncPagerToIndex(pendingIndex);
    queueCenterDirection(directionData[pendingIndex].direction);
    void ensureDirectionLoaded(pendingIndex);
    pendingPagerDirectionIndexRef.current = null;
  }, [directionData, ensureDirectionLoaded, queueCenterDirection, syncPagerToIndex]);

  const onRefresh = () => {
    setRefreshing(true);
    loadRouteDetails(true);
  };

  const handleDirectionChange = (index: number) => {
    updateSelectedDirection(index);
    queueCenterDirection(index);
    void ensureDirectionLoaded(index);
  };

  const handleDirectionTabPress = (index: number) => {
    if (index === selectedDirection) {
      queueCenterDirection(index);
      centerNearestStop(index);
      return;
    }

    pagerRef.current?.setPage(index);
  };

  const renderBadge = (stop: RouteStopArrival) => {
    const text = normalizeEtaText(stop.etaText, stop.rawTime);
    let badgeStyle = styles.badgeGray;
    let isSoftRedMinutes = false;

    if (stop.rawTime <= 0 || text.includes(COMING_TEXT) || text.includes(SOON_TEXT)) {
      badgeStyle = styles.badgeRed;
    } else if (
      stop.rawTime > SOFT_ALERT_MIN_SECONDS &&
      stop.rawTime <= SOFT_ALERT_MAX_SECONDS &&
      /\d/.test(text)
    ) {
      badgeStyle = styles.badgeSoftRed;
      isSoftRedMinutes = /^\d+\s*\D*$/.test(text);
    } else if (text === LOADING_TEXT) {
      badgeStyle = styles.badgeGray;
    } else if (/\d/.test(text)) {
      badgeStyle = styles.badgeBlue;
    }

    if (isSoftRedMinutes) {
      const matched = text.match(/^(\d+)/);
      const minuteValue = matched?.[1] ?? text;

      return (
        <View style={[styles.badgeBase, styles.badgeSoftRed, styles.badgeSoftRedWide]}>
          <Text style={styles.badgeSoftRedText}>
            <Text style={styles.badgeSoftRedNumber}>{minuteValue}</Text>
            <Text style={styles.badgeSoftRedUnit}> {MINUTE_UNIT_TEXT}</Text>
          </Text>
        </View>
      );
    }

    return (
      <View style={[styles.badgeBase, badgeStyle]}>
        <Text style={styles.badgeText}>{text}</Text>
      </View>
    );
  };

  const renderStopItem = (direction: RouteDirectionDetails, item: RouteStopArrival, index: number) => {
    const stopCount = direction.stops.length;
    const isTerminal = index === 0 || index === stopCount - 1;
    const isNearest =
      Platform.OS === 'web' &&
      locationReady &&
      nearestStopIndexByDirection[direction.direction] === index;

    return (
      <View style={[styles.stopRow, isNearest && styles.stopRowNearest]}>
        <View style={styles.stopMarkerColumn}>
          <View
            style={[
              styles.stopMarker,
              isTerminal ? styles.stopMarkerTerminal : styles.stopMarkerNormal,
              isNearest && styles.stopMarkerCurrent,
            ]}
          />
          {index !== stopCount - 1 && <View style={styles.stopConnector} />}
        </View>

        <View style={styles.stopNameColumn}>
          <View style={styles.stopNameInner}>
            {isNearest ? <View style={styles.currentLocationDot} /> : null}
            <Text
              style={[
                styles.stopName,
                isTerminal && styles.stopNameTerminal,
                isNearest && styles.stopNameNearest,
              ]}
            >
              {item.name}
            </Text>
          </View>
        </View>

        <View style={styles.stopEtaColumn}>{renderBadge(item)}</View>
      </View>
    );
  };

  const tabDirections = directionData.length > 0 ? directionData : routeDetails?.directions || [];
  const relativeUpdateText = formatRelativeUpdateText(lastUpdateAt, relativeNow);

  return (
    <WebRouteTransitionView backgroundColor="#152021" containerRef={pageTransitionRef}>
      <View style={styles.container}>
        <View style={styles.header}>
          <TouchableOpacity onPress={handleBackPress} style={styles.headerButton}>
            <Text style={styles.headerButtonText}>{BACK_TEXT}</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <Text style={styles.headerTitle}>{routeName}</Text>
            <Text style={styles.headerSubtitle}>{PAGE_TITLE}</Text>
          </View>

          <TouchableOpacity onPress={onRefresh} style={styles.headerButton} disabled={refreshing}>
            <Text style={styles.headerButtonText}>{refreshing ? REFRESHING_TEXT : REFRESH_TEXT}</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.tabBar}>
          {tabDirections.map((direction, index) => (
            <TouchableOpacity
              key={`${direction.rid}-${direction.direction}`}
              style={[styles.tabButton, selectedDirection === index && styles.tabButtonActive]}
              onPress={() => handleDirectionTabPress(index)}
            >
              <Text
                style={[
                  styles.tabButtonText,
                  selectedDirection === index && styles.tabButtonTextActive,
                ]}
              >
                {getDirectionDisplayText(direction)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#6F73F8" />
            <Text style={styles.loadingText}>{`${LOADING_TEXT} ${routeName}...`}</Text>
          </View>
        ) : errorText ? (
          <View style={styles.emptyContainer}>
            <Text style={styles.emptyTitle}>{errorText}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={() => loadRouteDetails()}>
              <Text style={styles.retryButtonText}>{RELOAD_TEXT}</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <View style={styles.content}>
            <PagerView
              ref={pagerRef}
              style={styles.pager}
              initialPage={0}
              onPageSelected={event => handleDirectionChange(event.nativeEvent.position)}
            >
              {directionData.map(direction => (
                <View key={`${direction.rid}-${direction.direction}`} style={styles.page}>
                  <View style={styles.directionHeader}>
                    <Text style={styles.directionTitle}>
                      {routeName} {getDirectionDisplayText(direction)}
                    </Text>
                    <Text style={styles.directionMeta}>{relativeUpdateText}</Text>
                  </View>

                  <FlatList
                    ref={ref => {
                      directionListRefs.current[direction.direction] = ref;
                    }}
                    data={direction.stops}
                    keyExtractor={item => item.sid}
                    renderItem={({ item, index }: ListRenderItemInfo<RouteStopArrival>) =>
                      renderStopItem(direction, item, index)
                    }
                    contentContainerStyle={styles.listContent}
                    getItemLayout={(_, index) => ({
                      index,
                      length: STOP_ROW_HEIGHT,
                      offset: STOP_ROW_HEIGHT * index,
                    })}
                    onScrollToIndexFailed={info =>
                      handleScrollToIndexFailed(
                        direction.direction,
                        info.averageItemLength,
                        info.index
                      )
                    }
                    refreshControl={
                      Platform.OS !== 'web' ? (
                        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
                      ) : undefined
                    }
                  />
                </View>
              ))}
            </PagerView>
          </View>
        )}

      <View style={styles.footer}>
        <Text style={styles.footerText}>{`${LAST_UPDATED_TEXT}${relativeUpdateText}`}</Text>
      </View>
      </View>
    </WebRouteTransitionView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#152021',
    paddingTop: Platform.OS === 'ios' ? 50 : 28,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  headerButton: {
    minWidth: 60,
    paddingVertical: 10,
  },
  headerButtonText: {
    color: '#8ea1ff',
    fontSize: 14,
    fontWeight: '600',
  },
  headerCenter: {
    alignItems: 'center',
  },
  headerTitle: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '800',
  },
  headerSubtitle: {
    color: '#809090',
    fontSize: 12,
    marginTop: 2,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: 20,
    paddingBottom: 12,
    gap: 10,
  },
  tabButton: {
    flex: 1,
    backgroundColor: '#243033',
    borderRadius: 16,
    paddingVertical: 12,
    alignItems: 'center',
  },
  tabButtonActive: {
    backgroundColor: '#6F73F8',
  },
  tabButtonText: {
    color: '#9cb0b0',
    fontSize: 15,
    fontWeight: '700',
  },
  tabButtonTextActive: {
    color: '#fff',
  },
  content: {
    flex: 1,
  },
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
  directionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#223033',
  },
  directionTitle: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  directionMeta: {
    color: '#7d8a8b',
    fontSize: 13,
    fontWeight: '600',
  },
  listContent: {
    paddingHorizontal: 20,
    paddingBottom: 80,
  },
  stopRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: STOP_ROW_HEIGHT,
    borderRadius: 18,
  },
  stopRowNearest: {
    backgroundColor: 'rgba(111, 115, 248, 0.12)',
  },
  stopMarkerColumn: {
    width: 28,
    alignItems: 'center',
    paddingTop: 20,
  },
  stopMarker: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  stopMarkerNormal: {
    backgroundColor: '#6F73F8',
  },
  stopMarkerTerminal: {
    backgroundColor: '#ff8b5f',
    width: 12,
    height: 12,
    borderRadius: 6,
  },
  stopMarkerCurrent: {
    shadowColor: '#6F73F8',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  stopConnector: {
    width: 2,
    flex: 1,
    backgroundColor: '#304042',
    marginTop: 4,
  },
  stopNameColumn: {
    flex: 1,
    justifyContent: 'center',
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#223033',
  },
  stopNameInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  currentLocationDot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    backgroundColor: '#6F73F8',
    borderWidth: 2,
    borderColor: '#dbe0ff',
    flexShrink: 0,
  },
  stopName: {
    color: '#dde7e7',
    fontSize: 16,
    fontWeight: '500',
  },
  stopNameTerminal: {
    color: '#fff',
    fontWeight: '700',
  },
  stopNameNearest: {
    color: '#ffffff',
  },
  stopEtaColumn: {
    justifyContent: 'center',
    paddingLeft: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#223033',
  },
  badgeBase: {
    minWidth: 76,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  badgeRed: {
    backgroundColor: '#E74C3C',
  },
  badgeSoftRed: {
    backgroundColor: '#dccaca',
  },
  badgeSoftRedWide: {
    minWidth: 76,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  badgeSoftRedText: {
    color: '#D7343A',
    fontSize: 14,
    fontWeight: '800',
  },
  badgeSoftRedNumber: {
    fontSize: 14,
    fontWeight: '800',
  },
  badgeSoftRedUnit: {
    fontSize: 14,
    fontWeight: '800',
  },
  badgeBlue: {
    backgroundColor: '#6F73F8',
  },
  badgeGray: {
    backgroundColor: '#687274',
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    color: '#99a6a8',
    fontSize: 15,
    marginTop: 12,
  },
  emptyContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
  },
  retryButton: {
    marginTop: 16,
    backgroundColor: '#6F73F8',
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 12,
  },
  retryButtonText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '700',
  },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  footerText: {
    color: '#6f7a78',
    fontSize: 12,
  },
});
