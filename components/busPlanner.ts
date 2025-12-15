/**
 * BusPlannerService.ts
 * 移植自 busPlanner.py (Refactored Version)
 * Environment: React Native (Expo SDK 54+) / Node 20+
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as cheerio from 'cheerio';

// 假設這兩個 JSON 檔案位於專案結構中正確的位置
// 若在 Expo 中，請確保這些檔案不會過大導致 Bundle 失敗，否則需改用 expo-file-system 下載
import routeDataRaw from '../databases/metro_bus_routes.json';
import stopDataRaw from '../databases/stop_id_map_v3.json';
import { compareArrivals } from '../utils/routeSorter';

// ========== 類型定義 (參照 busPlanner.ts) ==========

export interface GeoLocation {
  lat: number;
  lon: number;
}

export interface StopInfo {
  name: string;
  sid: string;
  slid?: string;
  geo?: GeoLocation;
}

export interface BusInfo {
  routeName: string;
  rid: string;
  sid: string; // 候車所在的站點 ID
  arrivalTimeText: string;
  rawTime: number; // 用於排序
  directionText: string;
  stopCount: number;
  estimatedDuration?: number; // 預估搭乘時間（分鐘）
  startGeo?: GeoLocation;
  endGeo?: GeoLocation;
  pathStops: StopInfo[];
}

// 用於靜態路線匹配的中介結構
interface StaticRouteMatch {
  route_name: string;
  rid: string;
  direction: number;
  stops_sid: string[];
  match_range: [number, number]; // [startIndex, endIndex]
}

// ========== 配置與常數 ==========

const CONFIG = {
  // 使用 Python 版的 Proxy 設定
  BASE_URL: "https://api.codetabs.com/v1/proxy?quest=https://pda5284.gov.taipei/MQS",
  USER_AGENT: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  TIMEOUT_MS: 15000,
  MAX_CONCURRENT_REQUESTS: 5,
  CACHE_KEY_PREFIX: "BUS_ROUTE_CACHE_V2_",
  
  // Magic Numbers
  TIME_NEAREST: -1,
  TIME_ARRIVING: 0,
  TIME_NOT_DEPARTED: 99999,
  TIME_UNKNOWN: 88888,
};

enum BusStatus {
  ARRIVING = '進站中',
  NOT_DEPARTED = '未發車',
  TRAFFIC_CONTROL = '交管不停',
  LAST_PASSED = '末班已過',
  NOT_OPERATING = '今日未營運',
  UNKNOWN = '未知'
}

// ========== 工具類 ==========

class TimeParser {
  static parseTextToSeconds(text: string): number {
    const t = text.trim();
    if (t.includes("進站") || t.includes("將到")) return CONFIG.TIME_NEAREST;
    if (t.includes("未發車") || t.includes("末班") || t.includes("今日未")) return CONFIG.TIME_NOT_DEPARTED;
    if (t.includes(":")) return CONFIG.TIME_UNKNOWN;

    const digits = t.replace(/\D/g, '');
    if (!digits) return CONFIG.TIME_NOT_DEPARTED;
    
    const val = parseInt(digits, 10);
    return t.includes("分") ? val * 60 : val;
  }

  static formatStatusCode(code: string): string {
    const codeStr = String(code).trim();
    const mapping: Record<string, string> = {
      '0': BusStatus.ARRIVING,
      '': BusStatus.NOT_DEPARTED,
      '-1': BusStatus.NOT_DEPARTED, // Python版邏輯：負數視為未發車或異常，除了特定狀態
      '-2': BusStatus.TRAFFIC_CONTROL,
      '-3': BusStatus.LAST_PASSED,
      '-4': BusStatus.NOT_OPERATING
    };

    if (mapping[codeStr]) return mapping[codeStr];
    
    // 若原本就是 "12:30" 格式
    if (codeStr.includes(':') || Object.values(BusStatus).includes(codeStr as any)) {
        return codeStr;
    }

    try {
      const secs = parseInt(codeStr, 10);
      if (isNaN(secs)) return BusStatus.UNKNOWN;
      if (secs < 0) return BusStatus.NOT_DEPARTED;
      if (secs < 180) return "將到站";
      return `${Math.floor(secs / 60)}分`;
    } catch {
      return BusStatus.NOT_DEPARTED;
    }
  }
}

// ========== 核心服務 ==========

export class BusPlannerService {
  // 資料庫結構映射 stop_id_map_v3.json
  private stopDb: {
    g: number[][]; // Geo Pool
    n: Record<string, string[]>; // Name Index
    s: Record<string, [string, string, number]>; // SID -> [Name, SLID, GeoIndex]
  };

  private routeDb: any[]; // metro_bus_routes.json

  constructor() {
    // 在 React Native 中，JSON import 是同步的，無需非同步初始化
    // 類型斷言以符合資料結構
    this.stopDb = stopDataRaw as any;
    this.routeDb = routeDataRaw as any[];
  }

  // --- Helpers: Repository Logic ---

  private getSidsByName(name: string): string[] {
    return this.stopDb.n[name] || [];
  }

  private getStopInfo(sid: string) {
    const raw = this.stopDb.s[sid];
    if (!raw) return null;
    
    const [name, slid, gIdx] = raw;
    let geo: GeoLocation | undefined = undefined;
    
    if (gIdx >= 0 && gIdx < this.stopDb.g.length) {
        const [lat, lon] = this.stopDb.g[gIdx];
        geo = { lat, lon };
    }

    return { name, slid, sid, geo };
  }

  // --- Public API Methods (補充 Vercel 版本缺少的方法) ---

  /**
   * 取得指定 SID 的地理位置
   * @param sid 站點 ID
   * @returns 地理位置或 undefined
   */
  public getGeoBySid(sid: string): GeoLocation | undefined {
    const info = this.getStopInfo(sid);
    return info?.geo;
  }

  /**
   * 取得所有站名列表
   * @returns 站名陣列
   */
  public getAllStopNames(): string[] {
    return Object.keys(this.stopDb.n);
  }

  /**
   * 取得代表性的 SID 列表（去除重複的 SLID）
   * @param name 站名
   * @returns 代表性 SID 陣列
   */
  public getRepresentativeSids(name: string): string[] {
    const allSids = this.getSidsByName(name);
    const seenSlids = new Set<string>();
    const representatives: string[] = [];

    for (const sid of allSids) {
      const info = this.getStopInfo(sid);
      if (info && info.slid) {
        if (!seenSlids.has(info.slid)) {
          seenSlids.add(info.slid);
          representatives.push(sid);
        }
      } else {
        representatives.push(sid);
      }
    }
    return representatives;
  }

  /**
   * 尋找最近的站牌
   * @param userLat 使用者緯度
   * @param userLon 使用者經度
   * @returns 最近站名或 null
   */
  public findNearestStop(userLat: number, userLon: number): string | null {
    const stopNames = this.getAllStopNames();
    let nearestStop: string | null = null;
    let minDistance = Infinity;

    for (const stopName of stopNames) {
      const sids = this.getRepresentativeSids(stopName);
      if (sids.length === 0) continue;

      const geo = this.getGeoBySid(sids[0]);
      if (!geo) continue;

      const distance = this.calculateDistance(userLat, userLon, geo.lat, geo.lon);
      if (distance < minDistance) {
        minDistance = distance;
        nearestStop = stopName;
      }
    }

    return nearestStop;
  }

  /**
   * 計算兩點間距離（Haversine 公式）
   * @private
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // 地球半徑（公里）
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  /**
   * 取得路線結構資訊
   * @param rid 路線 ID
   * @returns 路線結構或 undefined
   */
  public getRouteStructure(rid: string): any {
    const route = this.routeDb.find(r => r.rid === rid);
    if (!route) return undefined;

    return {
      routeName: route.route_name,
      rid: route.rid,
      direction: route.direction === 0 ? '去程' : '返程',
      goStops: route.direction === 0 
        ? route.stops_sid.map((sid: string) => {
            const info = this.getStopInfo(sid);
            return { name: info?.name || 'Unknown', sid };
          })
        : [],
      backStops: route.direction === 1
        ? route.stops_sid.map((sid: string) => {
            const info = this.getStopInfo(sid);
            return { name: info?.name || 'Unknown', sid };
          })
        : []
    };
  }

  /**
   * 抓取特定 SID 的公車動態（相容舊版 API）
   * @param sid 站點 ID
   * @returns 公車資訊陣列
   */
  public async fetchBusesAtSid(sid: string): Promise<any[]> {
    const info = this.getStopInfo(sid);
    if (!info) return [];

    const stopName = info.name;
    const slid = info.slid;

    if (!slid) {
      console.warn(`[BusPlanner] SID ${sid} 沒有對應的 SLID`);
      return [];
    }

    // 使用新版的 SLID 查詢方法
    return this.getArrivalsBySlid(slid, stopName);
  }

  private findStaticRoutes(startName: string, endName: string): StaticRouteMatch[] {
    const startSids = new Set(this.getSidsByName(startName));
    const endSids = new Set(this.getSidsByName(endName));

    if (startSids.size === 0 || endSids.size === 0) {
        console.warn(`[BusPlanner] 找不到站點: ${startName} 或 ${endName}`);
        return [];
    }

    const candidates: StaticRouteMatch[] = [];

    // 遍歷所有路線
    for (const route of this.routeDb) {
        const stops: string[] = route.stops_sid;
        
        // 1. 找出路線中所有符合「起點名稱」的位置索引
        const startIndices = stops
            .map((sid, idx) => startSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);
            
        // 2. 找出路線中所有符合「終點名稱」的位置索引
        const endIndices = stops
            .map((sid, idx) => endSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);

        if (startIndices.length === 0 || endIndices.length === 0) continue;

        // 3. 配對邏輯 (與 Python _match_single_route 對齊)
        for (const sIdx of startIndices) {
            // 找到該起點之後，最近的一個終點
            const firstValidEnd = endIndices.find(eIdx => eIdx > sIdx);
            
            if (firstValidEnd !== undefined) {
                candidates.push({
                    route_name: route.route_name,
                    rid: route.rid,
                    direction: route.direction,
                    stops_sid: route.stops_sid,
                    match_range: [sIdx, firstValidEnd]
                });
                // 修正：移除 break，繼續檢查下一個 startIndices
                // 例如：某路線在第 5 站和第 20 站都經過「淡水」，兩者都可能是合法的上車點
            }
        }
    }
    return candidates;
  }

  // --- Network Logic ---

  /**
   * 批次處理請求以控制併發量 (模擬 Python 的 asyncio + batch logic)
   */
  private async batchProcess<T, R>(
    items: T[], 
    processor: (item: T) => Promise<R>, 
    batchSize: number = CONFIG.MAX_CONCURRENT_REQUESTS
  ): Promise<R[]> {
    const results: R[] = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(processor));
        results.push(...batchResults);
    }
    return results;
  }

  private async fetchRealtimeBySlid(slid: string, repSid: string): Promise<any[]> {
    const urlHtml = `${CONFIG.BASE_URL}/stoplocation.jsp?slid=${slid}`;
    const urlJson = `${CONFIG.BASE_URL}/StopLocationDyna?stoplocationid=${slid}`;

    try {
        const [resHtml, resJson] = await Promise.all([
            fetch(urlHtml).then(r => r.text()).catch(() => ""),
            fetch(urlJson).then(r => r.json()).catch(() => null)
        ]);

        if (!resHtml) return [];

        const $ = cheerio.load(resHtml);
        const routeMap: Record<string, { route: string; rid: string; direction: string }> = {};

        // 解析 HTML 表格建立 rid 對照表（包含方向資訊）
        $('tr').each((_, row) => {
            const $row = $(row);
            const cols = $row.find('td');
            
            // 需要至少 3 個欄位：路線、站牌、方向、時間
            if (cols.length < 3) return;
            
            const link = $row.find('a[href*="route.jsp"]').first();
            if (!link.length) return;

            const href = link.attr('href') || "";
            const ridMatch = href.match(/rid=(\d+)/);
            const rid = ridMatch ? ridMatch[1] : "";
            
            // 取得方向資訊（第 3 個欄位）
            const direction = $(cols[2]).text().trim();

            const dynIdNode = $row.find('[id^="tte"]');
            const dynIdRaw = dynIdNode.attr('id');
            const dynId = dynIdRaw ? dynIdRaw.replace('tte', '') : "";

            if (dynId && rid) {
                routeMap[dynId] = { 
                    route: link.text().trim(), 
                    rid,
                    direction 
                };
            }
        });

        const buses: any[] = [];

        // 整合 JSON 動態資料
        if (resJson && resJson.Stop) {
            for (const item of resJson.Stop) {
                const vals = (item.n1 || "").split(',');
                if (vals.length < 8) continue;

                const jDynId = vals[1];
                const jTimeCode = vals[7];

                if (routeMap[jDynId]) {
                    const info = routeMap[jDynId];
                    delete routeMap[jDynId]; 

                    const timeText = TimeParser.formatStatusCode(jTimeCode);
                    buses.push({
                        route: info.route,
                        rid: info.rid,
                        sid: repSid,
                        direction: info.direction, // 加入方向資訊
                        time_text: timeText,
                        raw_time: TimeParser.parseTextToSeconds(timeText)
                    });
                }
            }
        }

        // 處理剩餘項目 (未發車/無動態)
        for (const k in routeMap) {
            buses.push({
                route: routeMap[k].route,
                rid: routeMap[k].rid,
                sid: repSid,
                direction: routeMap[k].direction, // 加入方向資訊
                time_text: "更新中", 
                raw_time: CONFIG.TIME_NOT_DEPARTED
            });
        }

        return buses;
    } catch (e) {
        console.warn(`Fetch failed for SLID ${slid}:`, e);
        return [];
    }
  }

  // --- Main Business Logic ---

  public async plan(startName: string, endName: string): Promise<BusInfo[]> {
    console.log(`🚀 [BusPlanner] Planning: ${startName} -> ${endName}`);

    // 0. Cache Check (可選)
    const cacheKey = `${CONFIG.CACHE_KEY_PREFIX}${startName}|${endName}`;
    try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
            const cachedBuses: BusInfo[] = JSON.parse(cached);
            console.log("命中快取，更新時間中...");
            return await this.updateCachedBuses(cachedBuses);
        }
    } catch (e) { /* ignore */ }

    // 1. Static Route Matching (Python logic Step 1)
    const matchedRoutes = this.findStaticRoutes(startName, endName);
    if (matchedRoutes.length === 0) return [];
    
    console.log(`Found ${matchedRoutes.length} static candidates.`);

    // 2. Prepare for Realtime Fetching
    // 找出所有需要查詢的 SLID (去重)
    const slidMap = new Map<string, string>(); // slid -> repSid (代表SID)
    
    matchedRoutes.forEach(r => {
        const startSid = r.stops_sid[r.match_range[0]];
        const info = this.getStopInfo(startSid);
        if (info && info.slid) {
            if (!slidMap.has(info.slid)) {
                slidMap.set(info.slid, startSid);
            }
        }
    });

    const tasks = Array.from(slidMap.entries()).map(([slid, sid]) => ({ slid, sid }));

    // 3. Batch Fetch Realtime Data
    const nestedResults = await this.batchProcess(
        tasks,
        (task) => this.fetchRealtimeBySlid(task.slid, task.sid)
    );
    const allRealtimeBuses = nestedResults.flat();

    // 建立快速查找表: SLID -> Array of RealtimeData
    const realtimeLookup: Record<string, any[]> = {};
    allRealtimeBuses.forEach(b => {
        // 因為 realtime data 只有 rid 和 time，我們需要知道它屬於哪個 SLID
        // 這裡稍微 trick：我們在 fetchRealtimeBySlid 裡塞入了 sid，反查 sid -> slid
        const info = this.getStopInfo(b.sid);
        if (info && info.slid) {
            if (!realtimeLookup[info.slid]) realtimeLookup[info.slid] = [];
            realtimeLookup[info.slid].push(b);
        }
    });

    // 4. Construct Final Objects
    const finalBuses: BusInfo[] = [];

    for (const route of matchedRoutes) {
        const [startIdx, endIdx] = route.match_range;
        const startSid = route.stops_sid[startIdx];
        const sInfo = this.getStopInfo(startSid);

        if (!sInfo || !sInfo.slid) continue;

        // Find realtime data
        const busesAtStop = realtimeLookup[sInfo.slid] || [];
        const matchBus = busesAtStop.find(b => b.rid === route.rid);

        const arrivalText = matchBus ? matchBus.time_text : "未發車";
        const rawTime = matchBus ? matchBus.raw_time : CONFIG.TIME_NOT_DEPARTED;

        // Build Path
        const pathSids = route.stops_sid.slice(startIdx, endIdx + 1);
        const pathStops: StopInfo[] = pathSids.map(sid => {
            const info = this.getStopInfo(sid);
            return {
                name: info?.name || "未知",
                sid: sid,
                slid: info?.slid,
                geo: info?.geo
            };
        });

        finalBuses.push({
            routeName: route.route_name,
            rid: route.rid,
            sid: startSid,
            arrivalTimeText: arrivalText,
            rawTime: rawTime,
            directionText: route.direction === 0 ? "去程" : "返程",
            stopCount: pathStops.length - 1,
            estimatedDuration: Math.ceil((pathStops.length - 1) * 2 + 1), // 估算：每站2分鐘+緩衝1分鐘
            startGeo: pathStops[0].geo,
            endGeo: pathStops[pathStops.length - 1].geo,
            pathStops: pathStops
        });
    }

    // 5. Sort & Cache (use centralized comparator to ensure arriving items prioritized)
    finalBuses.sort((a, b) => compareArrivals(a, b));
    
    // Cache without dynamic time
    AsyncStorage.setItem(cacheKey, JSON.stringify(finalBuses)).catch(() => {});

    return finalBuses;
  }

  public async getArrivalsBySlid(slid: string, stopName: string): Promise<any[]> {
    console.log(`[BusPlanner] Using direct SLID: ${slid}`);

    const buses = await this.fetchRealtimeBySlid(slid, stopName); // 或 slid

    // 排序回傳（使用共用比較器，支援不同欄位命名）
    return buses.sort((a, b) => compareArrivals(a, b));
  }

  public async getStopArrivals(stopName: string): Promise<any[]> {
    // 1. 確保初始化
    if (!this.stopDb) {
      console.warn("Service not initialized, loading DB...");
      // 若您的 constructor 是同步讀取 JSON，這裡可忽略；若是非同步，需確保 init
    }

    // 2. 取得該站名對應的所有 SID
    const sids = this.getSidsByName(stopName);
    if (sids.length === 0) return [];

    // 3. 找出不重複的 SLID (Stop Location ID) 以避免重複請求
    // 邏輯：同一個站名可能有多個站牌 (SID)，但它們可能共享同一個動態來源 (SLID)
    const slidMap = new Map<string, string>(); // slid -> representative_sid
    
    for (const sid of sids) {
      const info = this.getStopInfo(sid);
      if (info && info.slid) {
        if (!slidMap.has(info.slid)) {
          slidMap.set(info.slid, sid);
        }
      }
    }

    // 4. 批次並行抓取 (使用既有的 batchProcess 機制)
    const tasks = Array.from(slidMap.entries()).map(([slid, sid]) => ({ slid, sid }));
    
    const nestedResults = await this.batchProcess(
      tasks,
      (task) => this.fetchRealtimeBySlid(task.slid, task.sid)
    );

    // 5. 攤平結果並排序（使用共用比較器）
    const allBuses = nestedResults.flat();
    return allBuses.sort((a, b) => compareArrivals(a, b));
  }

  public async updateCachedBuses(cachedBuses: BusInfo[]): Promise<BusInfo[]> {
    // Group by SLID
    const slidGroups = new Map<string, BusInfo[]>();
    
    cachedBuses.forEach(b => {
        const info = this.getStopInfo(b.sid);
        if (info && info.slid) {
            const existing = slidGroups.get(info.slid) || [];
            existing.push(b);
            slidGroups.set(info.slid, existing);
        }
    });

    const tasks = Array.from(slidGroups.entries()).map(([slid, buses]) => ({ slid, buses }));

    // Re-fetch only needed SLIDs
    const updatedArrays = await this.batchProcess(tasks, async ({ slid, buses }) => {
        const repSid = buses[0].sid;
        const realtimes = await this.fetchRealtimeBySlid(slid, repSid);
        const rtMap = new Map(realtimes.map(r => [r.rid, r]));

        return buses.map(b => {
            const rt = rtMap.get(b.rid);
            return {
                ...b,
                arrivalTimeText: rt ? rt.time_text : "更新中",
                rawTime: rt ? rt.raw_time : CONFIG.TIME_NOT_DEPARTED
            };
        });
    });

    const result = updatedArrays.flat();
    result.sort((a, b) => compareArrivals(a, b));
    return result;
  }
}