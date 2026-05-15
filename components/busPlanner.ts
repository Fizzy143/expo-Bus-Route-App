/**
 * BusPlannerService.ts
 * 蝘餅???busPlanner.py (Refactored Version)
 * Environment: React Native (Expo SDK 54+) / Node 20+
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as cheerio from 'cheerio';

// ?身???JSON 瑼?雿撠?蝯?銝剜迤蝣箇?雿蔭
// ?亙 Expo 銝哨?隢Ⅱ靽?瑼?銝??之撠 Bundle 憭望?嚗???寧 expo-file-system 銝?
import routeDataRaw from '../databases/metro_bus_routes.json';
import stopDataRaw from '../databases/stop_id_map_v3.json';
import { compareArrivals } from '../utils/routeSorter';

// ========== 憿?摰儔 (? busPlanner.ts) ==========

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
  sid: string; // ????函?蝡? ID
  arrivalTimeText: string;
  rawTime: number; // ?冽??
  directionText: string;
  stopCount: number;
  estimatedDuration?: number; // ?摯?凋???嚗???
  startGeo?: GeoLocation;
  endGeo?: GeoLocation;
  pathStops: StopInfo[];
}

export interface RouteStopArrival {
  sid: string;
  slid?: string;
  name: string;
  etaText: string;
  rawTime: number;
}

export interface RouteDirectionDetails {
  routeName: string;
  rid: string;
  direction: number;
  directionText: string;
  stops: RouteStopArrival[];
}

export interface RouteDetails {
  routeName: string;
  directions: RouteDirectionDetails[];
}

// ?冽??頝舐??寥??葉隞?瑽?
interface StaticRouteMatch {
  route_name: string;
  rid: string;
  direction: number;
  stops_sid: string[];
  match_range: [number, number]; // [startIndex, endIndex]
}

interface TaipeiEstimateRow {
  RouteID?: string | number;
  StopID?: string | number;
  EstimateTime?: string | number | null;
  GoBack?: string | number | null;
  [key: string]: string | number | null | undefined;
}

interface TaipeiRouteRow {
  Id?: string | number;
  nameZh?: string;
  aliasName?: string;
  pathAttributeName?: string;
  departureZh?: string;
  destinationZh?: string;
  [key: string]: string | number | null | undefined;
}

interface TaipeiStopRow {
  Id?: string | number;
  routeId?: string | number;
  nameZh?: string;
  seqNo?: string | number;
  goBack?: string | number;
  stopLocationId?: string | number;
  [key: string]: string | number | null | undefined;
}

interface CachedTaipeiRouteStopMapping {
  officialRouteId: string;
  stopIdByLocalSid: Record<string, string>;
  estimateRouteId?: string;
}


// ========== ?蔭?虜??==========

const CONFIG = {
  // 雿輻 Python ?? Proxy 閮剖?
  BASE_URL: "https://api.codetabs.com/v1/proxy?quest=https://pda5284.gov.taipei/MQS",
  TAIPEI_ESTIMATE_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz',
  TAIPEI_ROUTE_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz',
  TAIPEI_STOP_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz',
  USER_AGENT: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  TIMEOUT_MS: 15000,
  MAX_CONCURRENT_REQUESTS: 10,
  CACHE_KEY_PREFIX: "BUS_ROUTE_CACHE_V2_",
  TAIPEI_ROUTE_STOP_MAPPING_CACHE_PREFIX: 'TAIPEI_ROUTE_STOP_MAPPING_V3_',
  REALTIME_CACHE_TTL_MS: 15000,
  STATIC_CACHE_TTL_MS: 12 * 60 * 60 * 1000,
  
  // Magic Numbers
  TIME_NEAREST: -1,
  TIME_ARRIVING: 0,
  TIME_NOT_DEPARTED: 99999,
  TIME_UNKNOWN: 88888,
};

enum BusStatus {
  ARRIVING = '\u9032\u7ad9\u4e2d',
  NOT_DEPARTED = '\u672a\u767c\u8eca',
  TRAFFIC_CONTROL = '\u4ea4\u901a\u7ba1\u5236',
  LAST_PASSED = '\u672b\u73ed\u5df2\u904e',
  NOT_OPERATING = '\u672a\u71df\u904b',
  UNKNOWN = '\u66ab\u7121\u8cc7\u6599'
}

class TimeParser {
  static parseTextToSeconds(text: string): number {
    const t = text.trim();
    if (!t) return CONFIG.TIME_NOT_DEPARTED;
    if (t.includes(BusStatus.ARRIVING) || t.includes('\u5373\u5c07\u5230\u7ad9')) {
      return CONFIG.TIME_NEAREST;
    }
    if (
      t.includes(BusStatus.NOT_DEPARTED) ||
      t.includes(BusStatus.LAST_PASSED) ||
      t.includes(BusStatus.NOT_OPERATING)
    ) {
      return CONFIG.TIME_NOT_DEPARTED;
    }
    if (t.includes(':')) return CONFIG.TIME_UNKNOWN;

    const digits = t.replace(/\D/g, '');
    if (!digits) return CONFIG.TIME_NOT_DEPARTED;

    const value = parseInt(digits, 10);
    return t.includes('\u5206') ? value * 60 : value;
  }

  static formatStatusCode(code: string): string {
    const codeStr = String(code).trim();
    const mapping: Record<string, string> = {
      '0': BusStatus.ARRIVING,
      '': BusStatus.NOT_DEPARTED,
      '-1': BusStatus.NOT_DEPARTED,
      '-2': BusStatus.TRAFFIC_CONTROL,
      '-3': BusStatus.LAST_PASSED,
      '-4': BusStatus.NOT_OPERATING,
    };

    if (mapping[codeStr]) return mapping[codeStr];

    if (codeStr.includes(':') || Object.values(BusStatus).includes(codeStr as any)) {
      return codeStr;
    }

    const seconds = parseInt(codeStr, 10);
    if (isNaN(seconds)) return BusStatus.UNKNOWN;
    if (seconds < 0) return BusStatus.NOT_DEPARTED;
    if (seconds < 180) return '\u5373\u5c07\u5230\u7ad9';

    return `${Math.floor(seconds / 60)}\u5206`;
  }
}

// ========== ?詨??? ==========

export class BusPlannerService {
  // 鞈?摨怎?瑽?撠?stop_id_map_v3.json
  private stopDb: {
    g: number[][]; // Geo Pool
    n: Record<string, string[]>; // Name Index
    s: Record<string, [string, string, number]>; // SID -> [Name, SLID, GeoIndex]
  };

  private routeDb: any[]; // metro_bus_routes.json
  private realtimeCache = new Map<string, { expiresAt: number; data: any[] }>();
  private realtimeInFlight = new Map<string, Promise<any[]>>();
  private taipeiEstimateCache: { expiresAt: number; data: TaipeiEstimateRow[] } | null = null;
  private taipeiEstimateInFlight: Promise<TaipeiEstimateRow[]> | null = null;
  private taipeiRouteCache: { expiresAt: number; data: TaipeiRouteRow[] } | null = null;
  private taipeiRouteInFlight: Promise<TaipeiRouteRow[]> | null = null;
  private taipeiStopCache: { expiresAt: number; data: TaipeiStopRow[] } | null = null;
  private taipeiStopInFlight: Promise<TaipeiStopRow[]> | null = null;

  constructor() {
    // ??React Native 銝哨?JSON import ?臬?甇亦?嚗???甇亙?憪?
    // 憿??瑁?隞亦泵????瑽?
    this.stopDb = stopDataRaw as any;
    this.routeDb = routeDataRaw as any[];
  }

  private getRealtimeCacheKey(slid: string, repSid: string): string {
    return `${slid}:${repSid}`;
  }

  private async fetchRealtimeBySlidCached(slid: string, repSid: string): Promise<any[]> {
    const cacheKey = this.getRealtimeCacheKey(slid, repSid);
    const now = Date.now();
    const cached = this.realtimeCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const existingRequest = this.realtimeInFlight.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.fetchRealtimeBySlid(slid, repSid)
      .then(data => {
        this.realtimeCache.set(cacheKey, {
          expiresAt: Date.now() + CONFIG.REALTIME_CACHE_TTL_MS,
          data,
        });
        return data;
      })
      .finally(() => {
        this.realtimeInFlight.delete(cacheKey);
      });

    this.realtimeInFlight.set(cacheKey, request);
    return request;
  }

  private isWebEstimateSourceAvailable(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof DecompressionStream !== 'undefined' &&
      typeof Response !== 'undefined'
    );
  }

  private async decompressGzipToText(buffer: ArrayBuffer): Promise<string> {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }

  private parseTaipeiEstimatePayload(text: string): TaipeiEstimateRow[] {
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as TaipeiEstimateRow[];
    }

    if (Array.isArray(parsed?.BusInfo)) {
      return parsed.BusInfo as TaipeiEstimateRow[];
    }

    if (Array.isArray(parsed?.data)) {
      return parsed.data as TaipeiEstimateRow[];
    }

    return [];
  }

  private getEstimateField(
    row: TaipeiEstimateRow,
    candidates: string[]
  ): string | number | null | undefined {
    for (const candidate of candidates) {
      if (candidate in row) {
        return row[candidate];
      }

      const matchedKey = Object.keys(row).find(key => key.toLowerCase() === candidate.toLowerCase());
      if (matchedKey) {
        return row[matchedKey];
      }
    }

    return undefined;
  }

  private getTaipeiRouteStopMappingCacheKey(routeName: string, direction: number): string {
    return `${CONFIG.TAIPEI_ROUTE_STOP_MAPPING_CACHE_PREFIX}${routeName}:${direction}`;
  }

  private async fetchTaipeiEstimateDataset(): Promise<TaipeiEstimateRow[]> {
    if (!this.isWebEstimateSourceAvailable()) {
      return [];
    }

    const now = Date.now();
    if (this.taipeiEstimateCache && this.taipeiEstimateCache.expiresAt > now) {
      return this.taipeiEstimateCache.data;
    }

    if (this.taipeiEstimateInFlight) {
      return this.taipeiEstimateInFlight;
    }

    const request = fetch(CONFIG.TAIPEI_ESTIMATE_URL)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`Taipei ETA request failed: ${response.status}`);
        }

        const text = await this.decompressGzipToText(await response.arrayBuffer());
        const data = this.parseTaipeiEstimatePayload(text);
        this.taipeiEstimateCache = {
          expiresAt: Date.now() + CONFIG.REALTIME_CACHE_TTL_MS,
          data,
        };
        return data;
      })
      .finally(() => {
        this.taipeiEstimateInFlight = null;
      });

    this.taipeiEstimateInFlight = request;
    return request;
  }

  private async fetchTaipeiJsonDataset<T extends Record<string, unknown>>(
    url: string
  ): Promise<T[]> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Taipei dataset request failed: ${response.status}`);
    }

    const text = await this.decompressGzipToText(await response.arrayBuffer());
    const trimmed = text.replace(/^\uFEFF/, '').trim();
    if (!trimmed) {
      return [];
    }

    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed as T[];
    }
    if (Array.isArray(parsed?.data)) {
      return parsed.data as T[];
    }
    if (Array.isArray(parsed?.BusInfo)) {
      return parsed.BusInfo as T[];
    }

    return [];
  }

  private async fetchTaipeiRouteDataset(): Promise<TaipeiRouteRow[]> {
    if (!this.isWebEstimateSourceAvailable()) {
      return [];
    }

    const now = Date.now();
    if (this.taipeiRouteCache && this.taipeiRouteCache.expiresAt > now) {
      return this.taipeiRouteCache.data;
    }
    if (this.taipeiRouteInFlight) {
      return this.taipeiRouteInFlight;
    }

    const request = this.fetchTaipeiJsonDataset<TaipeiRouteRow>(CONFIG.TAIPEI_ROUTE_URL)
      .then(data => {
        this.taipeiRouteCache = {
          expiresAt: Date.now() + CONFIG.STATIC_CACHE_TTL_MS,
          data,
        };
        return data;
      })
      .finally(() => {
        this.taipeiRouteInFlight = null;
      });

    this.taipeiRouteInFlight = request;
    return request;
  }

  private async fetchTaipeiStopDataset(): Promise<TaipeiStopRow[]> {
    if (!this.isWebEstimateSourceAvailable()) {
      return [];
    }

    const now = Date.now();
    if (this.taipeiStopCache && this.taipeiStopCache.expiresAt > now) {
      return this.taipeiStopCache.data;
    }
    if (this.taipeiStopInFlight) {
      return this.taipeiStopInFlight;
    }

    const request = this.fetchTaipeiJsonDataset<TaipeiStopRow>(CONFIG.TAIPEI_STOP_URL)
      .then(data => {
        this.taipeiStopCache = {
          expiresAt: Date.now() + CONFIG.STATIC_CACHE_TTL_MS,
          data,
        };
        return data;
      })
      .finally(() => {
        this.taipeiStopInFlight = null;
      });

    this.taipeiStopInFlight = request;
    return request;
  }

  private formatTaipeiEstimateTime(value: string | number | null | undefined): {
    etaText: string;
    rawTime: number;
  } {
    if (value === null || value === undefined || value === '') {
      return { etaText: BusStatus.UNKNOWN, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }

    const seconds = typeof value === 'number' ? value : parseInt(String(value), 10);
    if (isNaN(seconds)) {
      return { etaText: BusStatus.UNKNOWN, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }

    if (seconds === -1) {
      return { etaText: BusStatus.NOT_DEPARTED, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }
    if (seconds === -2) {
      return { etaText: BusStatus.TRAFFIC_CONTROL, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }
    if (seconds === -3) {
      return { etaText: BusStatus.LAST_PASSED, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }
    if (seconds === -4) {
      return { etaText: BusStatus.NOT_OPERATING, rawTime: CONFIG.TIME_NOT_DEPARTED };
    }
    if (seconds <= 30) {
      return { etaText: BusStatus.ARRIVING, rawTime: 0 };
    }
    if (seconds < 180) {
      return { etaText: '\u5373\u5c07\u5230\u7ad9', rawTime: seconds };
    }

    return {
      etaText: `${Math.ceil(seconds / 60)}\u5206`,
      rawTime: seconds,
    };
  }

  private getTaipeiEtaPriority(eta: { etaText: string; rawTime: number }): number {
    if (eta.etaText === BusStatus.UNKNOWN) return 0;
    if (eta.etaText === BusStatus.NOT_OPERATING) return 1;
    if (eta.etaText === BusStatus.LAST_PASSED) return 2;
    if (eta.etaText === BusStatus.TRAFFIC_CONTROL) return 3;
    if (eta.etaText === BusStatus.NOT_DEPARTED) return 4;
    if (eta.etaText === BusStatus.ARRIVING) return 6;
    if (eta.etaText === '\u5373\u5c07\u5230\u7ad9') return 5;
    return 5;
  }

  private shouldReplaceTaipeiEta(
    previous: { etaText: string; rawTime: number } | undefined,
    next: { etaText: string; rawTime: number }
  ): boolean {
    if (!previous) {
      return true;
    }

    const previousPriority = this.getTaipeiEtaPriority(previous);
    const nextPriority = this.getTaipeiEtaPriority(next);

    if (nextPriority !== previousPriority) {
      return nextPriority > previousPriority;
    }

    return next.rawTime < previous.rawTime;
  }

  private normalizeText(value: string | null | undefined): string {
    return (value || '').replace(/\s+/g, '').trim().toUpperCase();
  }

  private getRouteField(
    row: TaipeiRouteRow,
    candidates: string[]
  ): string | number | null | undefined {
    return this.getEstimateField(row as TaipeiEstimateRow, candidates);
  }

  private getStopField(
    row: TaipeiStopRow,
    candidates: string[]
  ): string | number | null | undefined {
    return this.getEstimateField(row as TaipeiEstimateRow, candidates);
  }

  private getTaipeiStopMatchKey(row: TaipeiStopRow): string | undefined {
    const value = this.getStopField(row, [
      'Id',
      'id',
      'StopID',
      'stopId',
      'stopLocationId',
      'StopLocationId',
      'stopLocationID',
      'StopLocationID',
    ]);

    if (value === undefined || value === null || value === '') {
      return undefined;
    }

    return String(value);
  }

  private scoreStopSequenceMatch(
    localStops: Array<{ sid: string; name: string }>,
    officialStops: TaipeiStopRow[]
  ): { score: number; stopIdByLocalSid: Map<string, string> } {
    const stopIdByLocalSid = new Map<string, string>();
    const officialNames = officialStops.map(stop =>
      this.normalizeText(String(this.getStopField(stop, ['nameZh', 'NameZh', 'name']) ?? ''))
    );
    const localNames = localStops.map(stop => this.normalizeText(stop.name));

    let indexMatches = 0;
    const pairLength = Math.min(localStops.length, officialStops.length);
    for (let index = 0; index < pairLength; index += 1) {
      if (!localNames[index] || !officialNames[index]) {
        continue;
      }

      if (localNames[index] === officialNames[index]) {
        indexMatches += 1;
      }
    }

    const officialNameSet = new Set(officialNames.filter(Boolean));
    const setMatches = localNames.filter(name => officialNameSet.has(name)).length;

    if (indexMatches >= Math.floor(pairLength * 0.6) && pairLength > 0) {
      for (let index = 0; index < pairLength; index += 1) {
        const stopId = this.getTaipeiStopMatchKey(officialStops[index]);
        if (stopId) {
          stopIdByLocalSid.set(localStops[index].sid, stopId);
        }
      }
    } else {
      let officialIndex = 0;
      for (const localStop of localStops) {
        const localName = this.normalizeText(localStop.name);
        while (officialIndex < officialStops.length) {
          const officialStop = officialStops[officialIndex];
          const officialName = this.normalizeText(
            String(this.getStopField(officialStop, ['nameZh', 'NameZh', 'name']) ?? '')
          );
          const stopId = this.getTaipeiStopMatchKey(officialStop);
          officialIndex += 1;

          if (localName && officialName === localName && stopId) {
            stopIdByLocalSid.set(localStop.sid, stopId);
            break;
          }
        }
      }
    }

    const mappedCount = stopIdByLocalSid.size;
    const score = indexMatches * 3 + setMatches + mappedCount * 2 - Math.abs(localStops.length - officialStops.length);

    return { score, stopIdByLocalSid };
  }

  private async getTaipeiRouteStopMapping(route: any): Promise<{
    officialRouteId: string;
    estimateRouteId?: string;
    stopIdByLocalSid: Map<string, string>;
  } | undefined> {
    const cacheKey = this.getTaipeiRouteStopMappingCacheKey(route.route_name, route.direction);

    try {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached) as CachedTaipeiRouteStopMapping;
        return {
          officialRouteId: parsed.officialRouteId,
          estimateRouteId: parsed.estimateRouteId,
          stopIdByLocalSid: new Map(Object.entries(parsed.stopIdByLocalSid)),
        };
      }
    } catch (error) {
      console.warn('[BusPlanner] Failed to read Taipei route-stop mapping cache.', error);
    }

    const [routeRows, stopRows] = await Promise.all([
      this.fetchTaipeiRouteDataset(),
      this.fetchTaipeiStopDataset(),
    ]);

    if (routeRows.length === 0 || stopRows.length === 0) {
      return undefined;
    }

    const localRouteName = this.normalizeText(route.route_name);
    const localStops = (route.stops_sid as string[]).map((sid: string) => ({
      sid,
      name: this.getStopInfo(sid)?.name || '',
    }));

    const candidateRoutes = routeRows.filter(routeRow => {
      const names = [
        this.getRouteField(routeRow, ['nameZh', 'NameZh']),
        this.getRouteField(routeRow, ['aliasName', 'AliasName']),
        this.getRouteField(routeRow, ['pathAttributeName', 'PathAttributeName']),
      ];

      return names.some(name => this.normalizeText(String(name ?? '')) === localRouteName);
    });

    let bestMatch:
      | { officialRouteId: string; stopIdByLocalSid: Map<string, string>; score: number }
      | undefined;

    for (const candidateRoute of candidateRoutes) {
      const officialRouteId = this.getRouteField(candidateRoute, ['Id', 'id', 'RouteID', 'routeId']);
      if (officialRouteId === undefined || officialRouteId === null) {
        continue;
      }

      const officialStops = stopRows
        .filter(stopRow => {
          const routeId = this.getStopField(stopRow, ['routeId', 'RouteID', 'RouteId']);
          const goBack = this.getStopField(stopRow, ['goBack', 'GoBack']);
          return (
            String(routeId ?? '') === String(officialRouteId) &&
            String(goBack ?? '') === String(route.direction)
          );
        })
        .sort((a, b) => {
          const seqA = Number(this.getStopField(a, ['seqNo', 'SeqNo']) ?? 0);
          const seqB = Number(this.getStopField(b, ['seqNo', 'SeqNo']) ?? 0);
          return seqA - seqB;
        });

      if (officialStops.length === 0) {
        continue;
      }

      const scored = this.scoreStopSequenceMatch(localStops, officialStops);
      if (!bestMatch || scored.score > bestMatch.score) {
        bestMatch = {
          officialRouteId: String(officialRouteId),
          stopIdByLocalSid: scored.stopIdByLocalSid,
          score: scored.score,
        };
      }
    }

    if (!bestMatch || bestMatch.stopIdByLocalSid.size === 0) {
      return undefined;
    }

    try {
      const cacheValue: CachedTaipeiRouteStopMapping = {
        officialRouteId: bestMatch.officialRouteId,
        estimateRouteId: bestMatch.officialRouteId,
        stopIdByLocalSid: Object.fromEntries(bestMatch.stopIdByLocalSid),
      };
      await AsyncStorage.setItem(cacheKey, JSON.stringify(cacheValue));
    } catch (error) {
      console.warn('[BusPlanner] Failed to persist Taipei route-stop mapping cache.', error);
    }

    return {
      officialRouteId: bestMatch.officialRouteId,
      estimateRouteId: bestMatch.officialRouteId,
      stopIdByLocalSid: bestMatch.stopIdByLocalSid,
    };
  }

  private async getRouteStopArrivalsFromTaipeiOpenData(
    route: any
  ): Promise<RouteDirectionDetails | undefined> {
    const dataset = await this.fetchTaipeiEstimateDataset();
    if (dataset.length === 0) {
      return undefined;
    }

    const mapping = await this.getTaipeiRouteStopMapping(route);
    if (!mapping) {
      return undefined;
    }

    let routeId = mapping.estimateRouteId || mapping.officialRouteId;
    let rows = dataset.filter(
      item => String(this.getEstimateField(item, ['RouteID', 'routeId', 'RouteId']) ?? '') === routeId
    );

    if (rows.length === 0) {
      const localStopIds = new Set(Array.from(mapping.stopIdByLocalSid.values()));
      const routeIdScores = new Map<string, number>();

      for (const item of dataset) {
        const stopId = String(
          this.getEstimateField(item, ['StopID', 'stopId', 'StopId']) ?? ''
        );
        if (!localStopIds.has(stopId)) {
          continue;
        }

        const candidateRouteId = String(
          this.getEstimateField(item, ['RouteID', 'routeId', 'RouteId']) ?? ''
        );
        if (!candidateRouteId) {
          continue;
        }

        routeIdScores.set(candidateRouteId, (routeIdScores.get(candidateRouteId) || 0) + 1);
      }

      const bestCandidate = Array.from(routeIdScores.entries()).sort((a, b) => b[1] - a[1])[0];
      if (bestCandidate) {
        routeId = bestCandidate[0];
        rows = dataset.filter(
          item => String(this.getEstimateField(item, ['RouteID', 'routeId', 'RouteId']) ?? '') === routeId
        );

        try {
          const cacheKey = this.getTaipeiRouteStopMappingCacheKey(route.route_name, route.direction);
          const cacheValue: CachedTaipeiRouteStopMapping = {
            officialRouteId: mapping.officialRouteId,
            estimateRouteId: routeId,
            stopIdByLocalSid: Object.fromEntries(mapping.stopIdByLocalSid),
          };
          await AsyncStorage.setItem(cacheKey, JSON.stringify(cacheValue));
          mapping.estimateRouteId = routeId;
        } catch (error) {
          console.warn('[BusPlanner] Failed to persist inferred estimate RouteID.', error);
        }
      }
    }

    if (rows.length === 0) {
      return undefined;
    }

    const bestByStopId = new Map<string, { etaText: string; rawTime: number }>();

    for (const row of rows) {
      const stopId = String(
        this.getEstimateField(row, ['StopID', 'stopId', 'StopId']) ?? ''
      );
      if (!stopId) {
        continue;
      }

      const formatted = this.formatTaipeiEstimateTime(
        this.getEstimateField(row, ['EstimateTime', 'estimateTime'])
      );
      const previous = bestByStopId.get(stopId);

      if (this.shouldReplaceTaipeiEta(previous, formatted)) {
        bestByStopId.set(stopId, formatted);
      }
    }

    return {
      routeName: route.route_name,
      rid: route.rid,
      direction: route.direction,
      directionText: this.getDirectionText(route.direction),
      stops: (route.stops_sid as string[]).map((sid: string) => {
        const info = this.getStopInfo(sid);
        const officialStopId = mapping.stopIdByLocalSid.get(String(sid));
        const realtime = officialStopId ? bestByStopId.get(officialStopId) : undefined;

        return {
          sid,
          slid: info?.slid,
          name: info?.name || 'Unknown',
          etaText: realtime?.etaText || '\u66ab\u7121\u8cc7\u6599',
          rawTime: realtime?.rawTime ?? CONFIG.TIME_NOT_DEPARTED,
        };
      }),
    };
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

  private getDirectionText(direction: number): string {
    return direction === 0 ? '\u53bb\u7a0b' : '\u8fd4\u7a0b';
  }

  // --- Public API Methods (鋆? Vercel ?蝻箏??瘜? ---

  /**
   * ???? SID ???蝵?
   * @param sid 蝡? ID
   * @returns ?啁?雿蔭??undefined
   */
  public getGeoBySid(sid: string): GeoLocation | undefined {
    const info = this.getStopInfo(sid);
    return info?.geo;
  }

  /**
   * ???????銵?
   * @returns 蝡????
   */
  public getAllStopNames(): string[] {
    return Object.keys(this.stopDb.n);
  }

  /**
   * ??隞?”?抒? SID ?”嚗?日?銴? SLID嚗?
   * @param name 蝡?
   * @returns 隞?”??SID ???
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
   * 撠?餈?蝡?
   * @param userLat 雿輻?楝摨?
   * @param userLon 雿輻??摨?
   * @returns ?餈??? null
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
   * 閮??拚????ｇ?Haversine ?砍?嚗?
   * @private
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // ?啁???嚗??
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
   * ??頝舐?蝯?鞈?
   * @param rid 頝舐? ID
   * @returns 頝舐?蝯???undefined
   */
  public getRouteStructure(rid: string): any {
    const route = this.routeDb.find(r => r.rid === rid);
    if (!route) return undefined;

    return {
      routeName: route.route_name,
      rid: route.rid,
      direction: route.direction === 0 ? '\u53bb\u7a0b' : '\u8fd4\u7a0b',
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
   * ???孵? SID ?頠????詨捆?? API嚗?
   * @param sid 蝡? ID
   * @returns ?祈?鞈????
   */
  public getRouteByName(routeName: string): RouteDetails | undefined {
    const routes = this.routeDb
      .filter(route => route.route_name === routeName)
      .sort((a, b) => a.direction - b.direction);

    if (routes.length === 0) return undefined;

    return {
      routeName,
      directions: routes.map(route => ({
        routeName: route.route_name,
        rid: route.rid,
        direction: route.direction,
        directionText: this.getDirectionText(route.direction),
        stops: (route.stops_sid as string[]).map((sid: string) => {
          const info = this.getStopInfo(sid);
          return {
            sid,
            slid: info?.slid,
            name: info?.name || 'Unknown',
            etaText: '\u8f09\u5165\u4e2d',
            rawTime: CONFIG.TIME_NOT_DEPARTED,
          };
        }),
      })),
    };
  }

  public async getRouteStopArrivals(
    routeName: string,
    direction: number
  ): Promise<RouteDirectionDetails | undefined> {
    const route = this.routeDb.find(
      item => item.route_name === routeName && item.direction === direction
    );

    if (!route) return undefined;

    try {
      const taipeiRealtime = await this.getRouteStopArrivalsFromTaipeiOpenData(route);
      if (taipeiRealtime) {
        return taipeiRealtime;
      }
    } catch (error) {
      console.warn('[BusPlanner] Taipei ETA source unavailable, falling back.', error);
    }

    const stops = (route.stops_sid as string[]).map((sid: string) => {
      const info = this.getStopInfo(sid);
      return {
        sid,
        slid: info?.slid,
        name: info?.name || 'Unknown',
      };
    });

    const stopsWithSlid = stops.filter(
      (stop): stop is { sid: string; slid: string; name: string } => Boolean(stop.slid)
    );

    const realtimeResults = await this.batchProcess(
      stopsWithSlid,
      async stop => {
        const buses = await this.fetchRealtimeBySlidCached(stop.slid, stop.sid);
        const match = buses.find((bus: any) => bus.rid === route.rid && bus.route === routeName);

        return {
          sid: stop.sid,
          etaText: match?.time_text || '\u66ab\u7121\u8cc7\u6599',
          rawTime: typeof match?.raw_time === 'number' ? match.raw_time : CONFIG.TIME_NOT_DEPARTED,
        };
      }
    );

    const realtimeMap = new Map(realtimeResults.map(item => [item.sid, item]));

    const fallbackResult = {
      routeName: route.route_name,
      rid: route.rid,
      direction: route.direction,
      directionText: this.getDirectionText(route.direction),
      stops: stops.map(stop => {
        const realtime = realtimeMap.get(stop.sid);
        return {
          sid: stop.sid,
          slid: stop.slid,
          name: stop.name,
          etaText: realtime?.etaText || '\u66ab\u7121\u8cc7\u6599',
          rawTime: realtime?.rawTime ?? CONFIG.TIME_NOT_DEPARTED,
        };
      }),
    };

    return fallbackResult;
  }

  public async fetchBusesAtSid(sid: string): Promise<any[]> {
    const info = this.getStopInfo(sid);
    if (!info) return [];

    const stopName = info.name;
    const slid = info.slid;

    if (!slid) {
      console.warn(`[BusPlanner] SID ${sid} 瘝?撠???SLID`);
      return [];
    }

    // 雿輻?啁???SLID ?亥岷?寞?
    return this.getArrivalsBySlid(slid, stopName);
  }

  private findStaticRoutes(startName: string, endName: string): StaticRouteMatch[] {
    const startSids = new Set(this.getSidsByName(startName));
    const endSids = new Set(this.getSidsByName(endName));

    if (startSids.size === 0 || endSids.size === 0) {
        console.warn(`[BusPlanner] ?曆??啁?暺? ${startName} ??${endName}`);
        return [];
    }

    const candidates: StaticRouteMatch[] = [];

    // ?風??楝蝺?
    for (const route of this.routeDb) {
        const stops: string[] = route.stops_sid;
        
        // 1. ?曉頝舐?銝剜??泵?絲暺?蝔晞?雿蔭蝝Ｗ?
        const startIndices = stops
            .map((sid, idx) => startSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);
            
        // 2. ?曉頝舐?銝剜??泵??暺?蝔晞?雿蔭蝝Ｗ?
        const endIndices = stops
            .map((sid, idx) => endSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);

        if (startIndices.length === 0 || endIndices.length === 0) continue;

        // 3. ???摩 (??Python _match_single_route 撠?)
        for (const sIdx of startIndices) {
            // ?曉閰脰絲暺?敺??餈?銝??暺?
            const firstValidEnd = endIndices.find(eIdx => eIdx > sIdx);
            
            if (firstValidEnd !== undefined) {
                candidates.push({
                    route_name: route.route_name,
                    rid: route.rid,
                    direction: route.direction,
                    stops_sid: route.stops_sid,
                    match_range: [sIdx, firstValidEnd]
                });
                // 靽格迤嚗宏??break嚗匱蝥炎?乩?銝??startIndices
                // 靘?嚗?頝舐??函洵 5 蝡?蝚?20 蝡蝬??楚瘞氬??抵?航?臬?瘜?銝?暺?
            }
        }
    }
    return candidates;
  }

  // --- Network Logic ---

  /**
   * ?寞活??隢?隞交?嗡蔥?潮? (璅⊥ Python ??asyncio + batch logic)
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

        // 閫?? HTML 銵冽撱箇? rid 撠銵剁???孵?鞈?嚗?
        $('tr').each((_, row) => {
            const $row = $(row);
            const cols = $row.find('td');
            
            // ?閬撠?3 ??雿?頝舐????????
            if (cols.length < 3) return;
            
            const link = $row.find('a[href*="route.jsp"]').first();
            if (!link.length) return;

            const href = link.attr('href') || "";
            const ridMatch = href.match(/rid=(\d+)/);
            const rid = ridMatch ? ridMatch[1] : "";
            
            // ???孵?鞈?嚗洵 3 ??雿?
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

        // ?游? JSON ??鞈?
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
                        direction: info.direction, // ??孵?鞈?
                        time_text: timeText,
                        raw_time: TimeParser.parseTextToSeconds(timeText)
                    });
                }
            }
        }

        // ???拚?? (?芰頠??∪???
        for (const k in routeMap) {
            buses.push({
                route: routeMap[k].route,
                rid: routeMap[k].rid,
                sid: repSid,
                direction: routeMap[k].direction, // ??孵?鞈?
                time_text: '\u672a\u767c\u8eca',
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
    console.log(`?? [BusPlanner] Planning: ${startName} -> ${endName}`);

    // 0. Cache Check (?舫)
    const cacheKey = `${CONFIG.CACHE_KEY_PREFIX}${startName}|${endName}`;
    try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
            const cachedBuses: BusInfo[] = JSON.parse(cached);
            console.log("?賭葉敹怠?嚗?唳??葉...");
            return await this.updateCachedBuses(cachedBuses);
        }
    } catch (e) { /* ignore */ }

    // 1. Static Route Matching (Python logic Step 1)
    const matchedRoutes = this.findStaticRoutes(startName, endName);
    if (matchedRoutes.length === 0) return [];
    
    console.log(`Found ${matchedRoutes.length} static candidates.`);

    // 2. Prepare for Realtime Fetching
    // ?曉???閬閰Ｙ? SLID (?駁?)
    const slidMap = new Map<string, string>(); // slid -> repSid (隞?”SID)
    
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
        (task) => this.fetchRealtimeBySlidCached(task.slid, task.sid)
    );
    const allRealtimeBuses = nestedResults.flat();

    // 撱箇?敹恍?曇”: SLID -> Array of RealtimeData
    const realtimeLookup: Record<string, any[]> = {};
    allRealtimeBuses.forEach(b => {
        // ? realtime data ?芣? rid ??time嚗???閬??撅祆?芸?SLID
        // ?ㄐ蝔凝 trick嚗?? fetchRealtimeBySlid 鋆∪??乩? sid嚗???sid -> slid
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

        const arrivalText = matchBus ? matchBus.time_text : '\u672a\u767c\u8eca';
        const rawTime = matchBus ? matchBus.raw_time : CONFIG.TIME_NOT_DEPARTED;

        // Build Path
        const pathSids = route.stops_sid.slice(startIdx, endIdx + 1);
        const pathStops: StopInfo[] = pathSids.map(sid => {
            const info = this.getStopInfo(sid);
            return {
                name: info?.name || "?芰",
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
            directionText: route.direction === 0 ? '\u53bb\u7a0b' : '\u8fd4\u7a0b',
            stopCount: pathStops.length - 1,
            estimatedDuration: Math.ceil((pathStops.length - 1) * 2 + 1), // 隡啁?嚗?蝡???+蝺抵?1??
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

    const buses = await this.fetchRealtimeBySlidCached(slid, stopName); // ??slid

    // ???嚗蝙?典?冽?頛嚗?港???雿??
    return buses.sort((a, b) => compareArrivals(a, b));
  }

  public async getStopArrivals(stopName: string): Promise<any[]> {
    // 1. 蝣箔?????
    if (!this.stopDb) {
      console.warn("Service not initialized, loading DB...");
      // ?交??constructor ?臬?甇亥???JSON嚗ㄐ?臬蕭?伐??交??甇伐??蝣箔? init
    }

    // 2. ??閰脩????????SID
    const sids = this.getSidsByName(stopName);
    if (sids.length === 0) return [];

    // 3. ?曉銝?銴? SLID (Stop Location ID) 隞仿??銴?瘙?
    // ?摩嚗?銝????賣?憭???(SID)嚗?摰?賢鈭怠?銝????皞?(SLID)
    const slidMap = new Map<string, string>(); // slid -> representative_sid
    
    for (const sid of sids) {
      const info = this.getStopInfo(sid);
      if (info && info.slid) {
        if (!slidMap.has(info.slid)) {
          slidMap.set(info.slid, sid);
        }
      }
    }

    // 4. ?寞活銝西??? (雿輻?Ｘ???batchProcess 璈)
    const tasks = Array.from(slidMap.entries()).map(([slid, sid]) => ({ slid, sid }));
    
    const nestedResults = await this.batchProcess(
      tasks,
      (task) => this.fetchRealtimeBySlidCached(task.slid, task.sid)
    );

    // 5. ?文像蝯?銝行?摨?雿輻?梁瘥??剁?
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
        const realtimes = await this.fetchRealtimeBySlidCached(slid, repSid);
        const rtMap = new Map(realtimes.map(r => [r.rid, r]));

        return buses.map(b => {
            const rt = rtMap.get(b.rid);
            return {
                ...b,
                arrivalTimeText: rt ? rt.time_text : '\u672a\u767c\u8eca',
                rawTime: rt ? rt.raw_time : CONFIG.TIME_NOT_DEPARTED
            };
        });
    });

    const result = updatedArrays.flat();
    result.sort((a, b) => compareArrivals(a, b));
    return result;
  }
}
