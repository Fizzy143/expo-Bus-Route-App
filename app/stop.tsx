import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { BusPlannerService } from '../components/busPlanner';
import { compareArrivals } from '../utils/routeSorter';

interface UIArrival {
  rid?: string;
  route: string;
  direction?: string;
  preferredDirection?: string;
  estimatedTime: string;
  key: string;
  rawTime?: number;
}

const DEFAULT_STOP_NAME = '捷運公館站';

export default function StopDetailScreen() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string | string[] }>();
  const stopName = Array.isArray(name) ? name[0] : name;
  const AUTO_REFRESH_MS = 10000;
  const REFRESH_COOLDOWN = 3000;

  const [resolvedStopName, setResolvedStopName] = useState<string>(DEFAULT_STOP_NAME);
  const [arrivals, setArrivals] = useState<UIArrival[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);

  const plannerRef = useRef(new BusPlannerService());
  const [serviceReady, setServiceReady] = useState(false);
  const intervalRef = useRef<any>(null);

  useEffect(() => {
    const initService = async () => {
      setServiceReady(true);
    };

    initService();
  }, []);

  useEffect(() => {
    setResolvedStopName(stopName || DEFAULT_STOP_NAME);
  }, [stopName]);

  const fetchBusData = useCallback(async (isAutoRefresh = false) => {
    try {
      if (!serviceReady) return;

      const sids = plannerRef.current.getRepresentativeSids(resolvedStopName);
      if (sids.length === 0) {
        setArrivals([]);
        setLastUpdate('無法識別站牌名稱');
        setLoading(false);
        return;
      }

      const allResults = await Promise.all(
        sids.map(sid => plannerRef.current.fetchBusesAtSid(sid))
      );
      const allBuses = allResults.flat().flat();

      const getArrivalLookupKey = (
        route: string,
        rid?: string,
        directionHint?: string
      ) => `${rid || ''}-${route}-${(directionHint || '').trim()}`;

      const getDisplayDirection = (
        item: Pick<UIArrival, 'route' | 'rid' | 'preferredDirection' | 'direction'>
      ) =>
        plannerRef.current.getRouteDisplayDirection(
          item.route,
          item.rid,
          item.preferredDirection || item.direction
        );

      const uniqueBusesMap = new Map<string, any>();
      allBuses.forEach(bus => {
        const normalizedRawTime =
          typeof bus.rawTime === 'number'
            ? bus.rawTime
            : typeof bus.raw_time === 'number'
              ? bus.raw_time
              : '';
        const uniqueKey = `${bus.rid}-${bus.route}-${bus.direction || ''}-${normalizedRawTime}`;
        const existing = uniqueBusesMap.get(uniqueKey);

        if (!existing) {
          uniqueBusesMap.set(uniqueKey, bus);
        } else if (
          existing.direction &&
          (existing.direction === '去程' || existing.direction === '返程') &&
          bus.direction &&
          bus.direction !== '去程' &&
          bus.direction !== '返程'
        ) {
          uniqueBusesMap.set(uniqueKey, bus);
        }
      });
      const uniqueBuses = Array.from(uniqueBusesMap.values());

      setArrivals(prev => {
        if (isAutoRefresh && prev.length > 0) {
          const TIME_NOT_DEPARTED = 99999;
          const TIME_UNKNOWN = 88888;

          const existingDataMap = new Map<
            string,
            {
              direction?: string;
              preferredDirection?: string;
              rawTime?: number;
              estimatedTime?: string;
            }
          >();

          prev.forEach(item => {
            const lookupKey = getArrivalLookupKey(
              item.route,
              item.rid,
              item.preferredDirection || item.direction
            );
            existingDataMap.set(lookupKey, {
              direction: item.direction,
              preferredDirection: item.preferredDirection,
              rawTime: typeof item.rawTime === 'number' ? item.rawTime : undefined,
              estimatedTime: item.estimatedTime,
            });
          });

          if (!uniqueBuses || uniqueBuses.length === 0) return prev;

          const updated = uniqueBuses.map((bus, index) => {
            const lookupKey = getArrivalLookupKey(bus.route, bus.rid, bus.direction || '');
            const saved = existingDataMap.get(lookupKey);

            const newRaw =
              typeof bus.rawTime === 'number'
                ? bus.rawTime
                : typeof bus.raw_time === 'number'
                  ? bus.raw_time
                  : TIME_NOT_DEPARTED;
            const newText = bus.timeText || bus.time_text || '';
            const resolvedPreferredDirection = saved?.preferredDirection || bus.direction || '';
            const displayDirection = getDisplayDirection({
              route: bus.route,
              rid: bus.rid,
              preferredDirection: resolvedPreferredDirection,
              direction: saved?.direction || bus.direction || '',
            });

            const newIsTerminal =
              newRaw === TIME_NOT_DEPARTED ||
              /未發車|末班|今日未營運|今日未|未營運|交管|交管不停/.test(String(newText));
            const newIsUnknown = newRaw === TIME_UNKNOWN;

            if (
              saved &&
              typeof saved.rawTime === 'number' &&
              saved.rawTime < TIME_NOT_DEPARTED &&
              (newIsTerminal || newIsUnknown)
            ) {
              return {
                rid: bus.rid,
                route: bus.route,
                direction: displayDirection || saved.direction || bus.direction || '',
                preferredDirection: resolvedPreferredDirection,
                estimatedTime: saved.estimatedTime || (newText || '更新中'),
                key: `${bus.rid}-${bus.route}-${resolvedPreferredDirection}-${saved.rawTime}-${index}`,
                rawTime: saved.rawTime,
              };
            }

            return {
              rid: bus.rid,
              route: bus.route,
              direction: displayDirection || saved?.direction || bus.direction || '',
              preferredDirection: resolvedPreferredDirection,
              estimatedTime: newText || '更新中',
              key: `${bus.rid}-${bus.route}-${resolvedPreferredDirection}-${newRaw}-${index}`,
              rawTime: newRaw,
            };
          });

          return updated.sort((a, b) => compareArrivals(a as any, b as any));
        }

        const initialData = uniqueBuses.map((bus, index) => {
          const rawTime =
            typeof bus.rawTime === 'number'
              ? bus.rawTime
              : typeof bus.raw_time === 'number'
                ? bus.raw_time
                : undefined;
          const preferredDirection = bus.direction || '';
          const direction =
            getDisplayDirection({
              route: bus.route,
              rid: bus.rid,
              preferredDirection,
              direction: preferredDirection,
            }) || preferredDirection;

          return {
            rid: bus.rid,
            route: bus.route,
            preferredDirection,
            direction,
            estimatedTime: bus.time_text || bus.timeText || '更新中',
            key: `${bus.rid}-${bus.route}-${preferredDirection}-${rawTime}-${index}`,
            rawTime,
          };
        });

        return initialData.sort((a, b) => compareArrivals(a as any, b as any));
      });

      setLastUpdate(new Date().toLocaleTimeString());

      if (!isAutoRefresh) {
        setArrivals(prev => {
          const finalDeduped = new Map<string, UIArrival>();

          prev.forEach(item => {
            const displayDirection = getDisplayDirection(item);
            const nextItem = displayDirection ? { ...item, direction: displayDirection } : item;
            const dedupKey = `${nextItem.route}-${nextItem.direction}-${nextItem.rawTime}`;

            if (!finalDeduped.has(dedupKey)) {
              finalDeduped.set(dedupKey, nextItem);
            }
          });

          return Array.from(finalDeduped.values()).sort((a, b) =>
            compareArrivals(a as any, b as any)
          );
        });
      }
    } catch (error) {
      console.error('Failed to fetch bus data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [resolvedStopName, serviceReady]);

  useEffect(() => {
    if (serviceReady) {
      fetchBusData(false);
      intervalRef.current = setInterval(() => {
        fetchBusData(true);
      }, AUTO_REFRESH_MS);
    }

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [resolvedStopName, serviceReady, fetchBusData]);

  const onRefresh = () => {
    const now = Date.now();
    const timeSinceLastRefresh = now - lastRefreshTime;

    if (timeSinceLastRefresh < REFRESH_COOLDOWN) {
      console.log(`請稍候 ${Math.ceil((REFRESH_COOLDOWN - timeSinceLastRefresh) / 1000)} 秒後再刷新`);
      return;
    }

    setLastRefreshTime(now);
    setRefreshing(true);
    fetchBusData(false);
  };

  const openRouteDetails = (item: UIArrival) => {
    const routeName = item.route?.trim();
    if (!routeName) {
      return;
    }

    router.push({
      pathname: '/bus-route' as any,
      params: {
        routeName,
        preferredRid: item.rid?.trim() || undefined,
        preferredDirection: item.preferredDirection?.trim() || undefined,
      },
    });
  };

  const renderBusItem = ({ item }: { item: UIArrival }) => {
    const timeText = item.estimatedTime || '未發車';
    let badgeColor = '#7f8686';
    if (timeText.includes('將到') || timeText.includes('進站')) badgeColor = '#E74C3C';
    else if (timeText.includes('分')) badgeColor = '#6F73F8';

    return (
      <TouchableOpacity style={styles.row} onPress={() => openRouteDetails(item)} activeOpacity={0.72}>
        <View style={styles.routeInfo}>
          <Text style={styles.route}>{item.route}</Text>
          {item.direction && <Text style={styles.direction}>{item.direction}</Text>}
        </View>
        <View style={[styles.badge, { backgroundColor: badgeColor }]}>
          <Text style={styles.badgeText}>{timeText}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setTimeout(() => router.back(), 100)}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{resolvedStopName}</Text>
      </View>

      <View style={styles.subHeader}>
        <Text style={styles.subHeaderText}>所有經過路線</Text>
      </View>

      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#6F73F8" />
          <Text style={{ color: '#999', marginTop: 8 }}>載入中...</Text>
        </View>
      ) : (
        <FlatList
          data={arrivals}
          renderItem={renderBusItem}
          keyExtractor={item => item.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {lastUpdate === '無法識別站牌名稱' ? '查無此站牌，請確認名稱' : '目前無公車資訊'}
              </Text>
            </View>
          }
        />
      )}
    </View>
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
    paddingHorizontal: 20,
    marginBottom: 10,
  },
  backArrow: { color: '#fff', fontSize: 30, marginRight: 10 },
  title: { color: '#fff', fontSize: 28, fontWeight: '700' },

  subHeader: {
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomColor: '#2b3435',
    borderBottomWidth: 1,
  },
  subHeaderText: { color: '#aaa', fontSize: 16 },

  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#263133',
  },
  routeInfo: {
    flexDirection: 'column',
    flex: 1,
  },
  route: { color: '#fff', fontSize: 22, fontWeight: '700' },
  direction: {
    color: '#aaa',
    fontSize: 14,
    marginTop: 3,
  },
  badge: {
    borderRadius: 18,
    minWidth: 68,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  badgeText: { color: '#fff', fontWeight: '700', fontSize: 17 },

  loading: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  empty: { marginTop: 40, alignItems: 'center' },
  emptyText: { color: '#9aa6a6', fontSize: 20, fontWeight: '700' },
});
