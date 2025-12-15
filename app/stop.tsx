import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
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
// 引入新版 Service
import { BusPlannerService } from '../components/busPlanner';
import { compareArrivals } from '../utils/routeSorter';

interface UIArrival {
  route: string;
  direction?: string;
  estimatedTime: string;
  key: string;
  rawTime?: number; // 原始到站秒數，用於排序
}

export default function StopDetailScreen() {
  const router = useRouter();
  const { name } = useLocalSearchParams<{ name?: string }>();
  const stopName = name || '捷運公館站';

  const [arrivals, setArrivals] = useState<UIArrival[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<number>(0);
  
  // 刷新冷卻時間（毫秒）
  const REFRESH_COOLDOWN = 3000; // 3 秒
  
  // 注意：因為 fetchBusesAtSid 不回傳方向，暫時移除 Tabs 的過濾功能
  // const [selectedTab, setSelectedTab] = useState<'去' | '回'>('去');
  
  const plannerRef = useRef(new BusPlannerService());
  const [serviceReady, setServiceReady] = useState(false);
  const intervalRef = useRef<any>(null);

  useEffect(() => {
    const initService = async () => {
      // 新版 BusPlannerService 不需要 initialize，constructor 已同步載入資料
      setServiceReady(true);
    };
    initService();
  }, []);

  const fetchBusData = async (isAutoRefresh = false) => {
    try {
      if (!serviceReady) return;
      
      const sids = plannerRef.current.getRepresentativeSids(stopName);
      if (sids.length === 0) {
        setArrivals([]);
        setLastUpdate('無法識別站牌名稱');
        setLoading(false);
        return;
      }

      // 抓取所有 SID 的公車資料（包含所有方向）
      const allResults = await Promise.all(
        sids.map(sid => plannerRef.current.fetchBusesAtSid(sid))
      );
      const allBuses = allResults.flat().flat();
      
      // 去重：使用 Map 以 rid+route+rawTime 為 key（不含 direction，因為同一 RID 同一時間不應有不同方向）
      const uniqueBusesMap = new Map();
      allBuses.forEach(bus => {
        const uniqueKey = `${bus.rid}-${bus.route}-${bus.rawTime}`;
        const existing = uniqueBusesMap.get(uniqueKey);
        
        // 如果已存在，優先保留有明確方向資訊的（非"去程"/"返程"的）
        if (!existing) {
          uniqueBusesMap.set(uniqueKey, bus);
        } else if (existing.direction && (existing.direction === '去程' || existing.direction === '返程') &&
                   bus.direction && bus.direction !== '去程' && bus.direction !== '返程') {
          // 新的有更詳細的方向資訊，替換舊的
          uniqueBusesMap.set(uniqueKey, bus);
        }
      });
      const uniqueBuses = Array.from(uniqueBusesMap.values());

      // 使用函數式更新來獲取最新的 arrivals 狀態
      setArrivals(prev => {
        if (isAutoRefresh && prev.length > 0) {

          // 自動更新模式：合併新/舊資料，避免臨時的未發車/更新中覆蓋已存在的有效時間
          const TIME_NOT_DEPARTED = 99999;
          const TIME_UNKNOWN = 88888;

          // 建立 rid+route 到舊資料的映射（包含 direction, rawTime, estimatedTime）
          const existingDataMap = new Map<string, { direction?: string; rawTime?: number; estimatedTime?: string }>();
          prev.forEach(item => {
            const parts = item.key.split('-');
            if (parts.length >= 2) {
              const lookupKey = `${parts[0]}-${parts[1]}`; // rid-route
              existingDataMap.set(lookupKey, {
                direction: item.direction,
                rawTime: typeof item.rawTime === 'number' ? item.rawTime : undefined,
                estimatedTime: item.estimatedTime
              });
            }
          });

          // 若沒有任何新資料，保留舊資料
          if (!uniqueBuses || uniqueBuses.length === 0) return prev;

          // 用新資料建立陣列，僅在新資料為有效數值或比舊資料更合理時才覆蓋舊資料
          const updated = uniqueBuses.map((bus, index) => {
            const lookupKey = `${bus.rid}-${bus.route}`;
            const saved = existingDataMap.get(lookupKey);

            const newRaw = (typeof bus.rawTime === 'number') ? bus.rawTime : (typeof bus.raw_time === 'number' ? bus.raw_time : TIME_NOT_DEPARTED);
            const newText = bus.timeText || bus.time_text || '';

            const newIsTerminal = newRaw === TIME_NOT_DEPARTED || /未發車|末班|今日未營運|今日未|未營運|交管|交管不停/.test(String(newText));
            const newIsUnknown = newRaw === TIME_UNKNOWN;

            if (saved && typeof saved.rawTime === 'number' && saved.rawTime < TIME_NOT_DEPARTED && (newIsTerminal || newIsUnknown)) {
              // 保留舊的有效時間與文字
              return {
                route: bus.route,
                direction: saved.direction || bus.direction || '',
                estimatedTime: saved.estimatedTime || (newText || '更新中'),
                key: `${bus.rid}-${bus.route}-${saved.rawTime}-${index}`,
                rawTime: saved.rawTime,
              };
            }

            // 否則使用新的資料（包含 direction）
            return {
              route: bus.route,
              direction: saved?.direction || bus.direction || '',
              estimatedTime: newText || '更新中',
              key: `${bus.rid}-${bus.route}-${newRaw}-${index}`,
              rawTime: newRaw,
            };
          });

          // 使用統一的比較器排序
          return updated.sort((a, b) => compareArrivals(a as any, b as any));
        } else {
          // 初始載入模式：先顯示路線名稱和時間，方向欄位暫時為空
          // 注意：新版 BusPlanner 使用 time_text (下劃線格式) 和 direction 欄位
          const initialData = uniqueBuses.map((bus, index) => ({
            route: bus.route,
            direction: bus.direction || '', // 新版已包含方向資訊
            estimatedTime: bus.time_text || bus.timeText || '更新中', // 相容新舊格式
            key: `${bus.rid}-${bus.route}-${bus.direction || ''}-${bus.rawTime}-${index}`, // 加入 index 確保唯一
            rawTime: bus.rawTime, // 保留原始時間用於排序
          }));
          
          // 使用統一的排序邏輯（到站優先）
          return initialData.sort((a, b) => compareArrivals(a as any, b as any));
        }
      });

      setLastUpdate(new Date().toLocaleTimeString());

      // 初始載入時，立即設定終點站資訊（不使用背景更新）
      if (!isAutoRefresh) {
        // 先批次獲取所有需要的路線結構
        const ridSet = new Set(uniqueBuses.map(bus => bus.rid));
        const routeStructures = new Map();
        
        for (const rid of ridSet) {
          const structure = plannerRef.current.getRouteStructure(rid);
          if (structure) {
            routeStructures.set(rid, structure);
          }
        }
        
        // 同步更新所有公車的終點站資訊，並進一步去重相同路線和終點站的項目
        setArrivals(prev => {
          const withDirections = prev.map((item, idx) => {
            // 從 uniqueBuses 找到對應的公車資訊
            const bus = uniqueBuses[idx];
            if (!bus) return item;
            
            const structure = routeStructures.get(bus.rid);
            if (!structure) return item;
            
            // getRouteStructure 回傳的結構中，goStops 和 backStops 只有一個會有資料
            // 取有資料的那個
            const stops = structure.goStops?.length > 0 ? structure.goStops : structure.backStops;
            
            // 取最後一個站點作為終點站
            if (stops && stops.length > 0) {
              const endStation = stops[stops.length - 1].name;
              
              // 調試：顯示羅斯福路幹線的詳細資訊
              if (bus.route.includes('羅斯福路幹線')) {
                console.log(`🔍 [羅斯福路幹線] RID: ${bus.rid}, 原始方向: ${bus.direction}, 終點站: ${endStation}, 時間: ${bus.timeText}`);
              }
              
              return {
                ...item,
                direction: `往 ${endStation}`
              };
            }
            
            return item;
          });
          
          // 檢查是否有同一路線指向相同終點站的情況
          const routeEndStationCount = new Map<string, Set<string>>();
          withDirections.forEach(item => {
            const key = `${item.route}-${item.direction}`;
            if (!routeEndStationCount.has(item.route)) {
              routeEndStationCount.set(item.route, new Set());
            }
            routeEndStationCount.get(item.route)!.add(item.direction || '');
          });
          
          // 如果某路線有多個項目指向同一終點站，改用原始方向區分
          const needsOriginalDirection = new Set<string>();
          routeEndStationCount.forEach((directions, route) => {
            if (directions.size === 1) {
              // 檢查這個路線-終點站組合是否有多個項目
              const count = withDirections.filter(item => 
                item.route === route && item.direction === Array.from(directions)[0]
              ).length;
              if (count > 1) {
                needsOriginalDirection.add(route);
                console.log(`⚠️ [${route}] 發現多個公車指向相同終點站，將使用原始方向標示`);
              }
            }
          });
          
          // 重新處理需要使用原始方向的路線
          const finalWithDirections = withDirections.map((item, idx) => {
            const bus = uniqueBuses[idx];
            if (bus && needsOriginalDirection.has(item.route)) {
              // 使用原始方向（去程/返程）而非終點站
              return {
                ...item,
                direction: bus.direction || item.direction
              };
            }
            return item;
          });
          
          // 最終去重：用 route-direction-rawTime 確保不重複
          const finalDeduped = new Map<string, UIArrival>();
          finalWithDirections.forEach(item => {
            const dedupKey = `${item.route}-${item.direction}-${item.rawTime}`;
            if (!finalDeduped.has(dedupKey)) {
              finalDeduped.set(dedupKey, item);
            }
          });
          
          // 轉換回陣列並使用統一的排序邏輯（到站優先）
          return Array.from(finalDeduped.values()).sort((a, b) => compareArrivals(a as any, b as any));
        });
      }

    } catch (error) {
      console.error('🚨 Failed to fetch bus data:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (serviceReady) {
      fetchBusData(false); // 初始載入
      intervalRef.current = setInterval(() => {
        fetchBusData(true);
      }, 30000); // 自動更新傳 true
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [stopName, serviceReady]);

  const onRefresh = () => {
    const now = Date.now();
    const timeSinceLastRefresh = now - lastRefreshTime;
    
    // 如果距離上次刷新少於冷卻時間，則忽略
    if (timeSinceLastRefresh < REFRESH_COOLDOWN) {
      console.log(`請稍候 ${Math.ceil((REFRESH_COOLDOWN - timeSinceLastRefresh) / 1000)} 秒後再刷新`);
      return;
    }
    
    setLastRefreshTime(now);
    setRefreshing(true);
    fetchBusData(false); // 手動刷新重新載入所有資料
  };

  const renderBusItem = ({ item }: { item: UIArrival }) => {
    const timeText = item.estimatedTime || '未發車';
    let badgeColor = '#7f8686';
    if (timeText.includes('將到') || timeText.includes('進站')) badgeColor = '#E74C3C';
    else if (timeText.includes('分')) badgeColor = '#6F73F8';

    return (
      <View style={styles.row}>
        <View style={styles.routeInfo}>
          <Text style={styles.route}>{item.route}</Text>
          {item.direction && (
            <Text style={styles.direction}>{item.direction || ''}</Text>
          )}
        </View>
        <View style={[styles.badge, { backgroundColor: badgeColor }]}>
          <Text style={styles.badgeText}>{timeText}</Text>
        </View>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      {/* 上方標題 */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => setTimeout(() => router.back(), 100)}>
          <Text style={styles.backArrow}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{stopName}</Text>
      </View>

      {/* NOTE: 因為新 API fetchBusesAtSid 暫時不提供方向資訊，
        這裡隱藏了原本的「去/回」Tabs，改為顯示所有經過的公車。
      */}
      <View style={styles.subHeader}>
        <Text style={styles.subHeaderText}>所有經過路線</Text>
      </View>

      {/* 列表 */}
      {loading ? (
        <View style={styles.loading}>
          <ActivityIndicator size="large" color="#6F73F8" />
          <Text style={{ color: '#999', marginTop: 8 }}>載入中...</Text>
        </View>
      ) : (
        <FlatList
          data={arrivals}
          renderItem={renderBusItem}
          keyExtractor={(item) => item.key}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyText}>
                {lastUpdate === '無法識別站牌名稱'
                  ? '查無此站牌，請確認名稱'
                  : '目前無公車資訊'}
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
    paddingTop: Platform.OS === 'ios' ? 50 : 28 
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