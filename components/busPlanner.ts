/**
 * BusPlannerService.ts
 * Refactored from the original busPlanner.py flow.
 * Environment: React Native (Expo SDK 54+) / Node 20+
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as cheerio from 'cheerio';
import { ungzip } from 'pako';

// Local static datasets are bundled with the app so route topology can be
// resolved without fetching extra files at runtime.
import routeDataRaw from '../databases/metro_bus_routes.json';
import stopDataRaw from '../databases/stop_id_map_v3.json';
import { compareArrivals } from '../utils/routeSorter';

// ========== Shared types ==========

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
  sid: string; // stop id
  arrivalTimeText: string;
  rawTime: number; // normalized ETA in seconds
  directionText: string;
  stopCount: number;
  estimatedDuration?: number; // rough duration estimate in minutes
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

// Static route candidate matched from local route topology.
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


// ========== Runtime config ==========

const CONFIG = {
  // Legacy Taipei e-bus proxy endpoints used for the MQS fallback path.
  BASE_URL: "https://api.codetabs.com/v1/proxy?quest=https://pda5284.gov.taipei/MQS",
  TAIPEI_ESTIMATE_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetEstimateTime.gz',
  TAIPEI_ROUTE_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetRoute.gz',
  TAIPEI_STOP_URL: 'https://tcgbusfs.blob.core.windows.net/blobbus/GetStop.gz',
  NEW_TAIPEI_ESTIMATE_URL: 'https://data.ntpc.gov.tw/api/datasets/07f7ccb3-ed00-43c4-966d-08e9dab24e95/json',
  USER_AGENT: "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
  TIMEOUT_MS: 15000,
  ROUTE_DETAIL_FALLBACK_TIMEOUT_MS: 7000,
  DIRECT_ESTIMATE_MIN_MATCH_RATIO: 0.15,
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
    if (seconds <= 30) return BusStatus.ARRIVING;
    if (seconds < 60) return '\u5c07\u5230\u7ad9';

    return `${Math.ceil(seconds / 60)}\u5206`;
  }
}

// ========== Core service ==========

export class BusPlannerService {
  // stop_id_map_v3.json structure:
  private stopDb: {
    g: number[][]; // Geo Pool
    n: Record<string, string[]>; // Name Index
    s: Record<string, [string, string, number]>; // SID -> [Name, SLID, GeoIndex]
  };

  private routeDb: any[]; // metro_bus_routes.json
  private static routeStopArrivalsCache = new Map<string, { expiresAt: number; data: RouteDirectionDetails }>();
  private static routeStopArrivalsInFlight = new Map<string, Promise<RouteDirectionDetails | undefined>>();
  private realtimeCache = new Map<string, { expiresAt: number; data: any[] }>();
  private realtimeInFlight = new Map<string, Promise<any[]>>();
  private staticStopRoutesCache = new Map<string, any[]>();
  private routeDynaCache = new Map<string, { expiresAt: number; data: any }>();
  private routeDynaInFlight = new Map<string, Promise<any>>();
  private routeDynaUnavailableKeys = new Set<string>();
  private taipeiEstimateCache: { expiresAt: number; data: TaipeiEstimateRow[] } | null = null;
  private taipeiEstimateInFlight: Promise<TaipeiEstimateRow[]> | null = null;
  private taipeiRouteCache: { expiresAt: number; data: TaipeiRouteRow[] } | null = null;
  private taipeiRouteInFlight: Promise<TaipeiRouteRow[]> | null = null;
  private taipeiStopCache: { expiresAt: number; data: TaipeiStopRow[] } | null = null;
  private taipeiStopInFlight: Promise<TaipeiStopRow[]> | null = null;
  private newTaipeiEstimateCache = new Map<string, { expiresAt: number; data: TaipeiEstimateRow[] }>();
  private newTaipeiEstimateInFlight = new Map<string, Promise<TaipeiEstimateRow[]>>();
  private taipeiRouteStopMappingWarmups = new Set<string>();

  constructor() {
    // Route and stop datasets are imported at build time.
    // The service only keeps references to those in-memory datasets here.
    this.stopDb = stopDataRaw as any;
    this.routeDb = routeDataRaw as any[];
  }

  private getRealtimeCacheKey(slid: string, repSid: string): string {
    return `${slid}:${repSid}`;
  }

  private getRouteStopArrivalsCacheKey(routeName: string, direction: number): string {
    return `${routeName}:${direction}`;
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
    return typeof fetch === 'function';
  }

  private async decompressGzipToText(buffer: ArrayBuffer): Promise<string> {
    if (typeof DecompressionStream !== 'undefined' && typeof Response !== 'undefined') {
      const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text();
    }

    const text = ungzip(new Uint8Array(buffer), { to: 'string' });
    return typeof text === 'string' ? text : new TextDecoder('utf-8').decode(text);
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

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    fallback: T,
    timeoutMessage: string
  ): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<T>(resolve => {
      timeoutId = setTimeout(() => {
        console.warn(timeoutMessage);
        resolve(fallback);
      }, timeoutMs);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async fetchWithTimeout(url: string, timeoutMs: number = CONFIG.TIMEOUT_MS): Promise<Response> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<Response>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller?.abort();
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
      }, timeoutMs);
    });

    try {
      return await Promise.race([
        fetch(url, controller ? { signal: controller.signal } : undefined),
        timeout,
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
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

    const request = this.fetchWithTimeout(CONFIG.TAIPEI_ESTIMATE_URL)
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
    const response = await this.fetchWithTimeout(url);
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

  private async fetchNewTaipeiEstimateDataset(routeId: string | number): Promise<TaipeiEstimateRow[]> {
    if (typeof window !== 'undefined') {
      return [];
    }

    const cacheKey = String(routeId);
    const now = Date.now();
    const cached = this.newTaipeiEstimateCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const existingRequest = this.newTaipeiEstimateInFlight.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }

    const url = `${CONFIG.NEW_TAIPEI_ESTIMATE_URL}?routeid=${encodeURIComponent(cacheKey)}`;
    const request = this.fetchWithTimeout(url)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`New Taipei ETA request failed: ${response.status}`);
        }

        const parsed = await response.json();
        const data = Array.isArray(parsed) ? (parsed as TaipeiEstimateRow[]) : [];
        this.newTaipeiEstimateCache.set(cacheKey, {
          expiresAt: Date.now() + CONFIG.REALTIME_CACHE_TTL_MS,
          data,
        });
        return data;
      })
      .catch(error => {
        console.warn('[BusPlanner] New Taipei ETA source unavailable.', error);
        return [];
      })
      .finally(() => {
        this.newTaipeiEstimateInFlight.delete(cacheKey);
      });

    this.newTaipeiEstimateInFlight.set(cacheKey, request);
    return request;
  }

  private async fetchRouteDynaByRouteIdCached(routeId: string | number): Promise<any | null> {
    const cacheKey = String(routeId);
    const now = Date.now();
    const cached = this.routeDynaCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const existingRequest = this.routeDynaInFlight.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }

    const url = `${CONFIG.BASE_URL}/RouteDyna?routeid=${encodeURIComponent(cacheKey)}`;
    const request = this.fetchWithTimeout(url)
      .then(async response => {
        if (!response.ok) {
          throw new Error(`RouteDyna request failed: ${response.status}`);
        }

        const data = await response.json();
        this.routeDynaCache.set(cacheKey, {
          expiresAt: Date.now() + CONFIG.REALTIME_CACHE_TTL_MS,
          data,
        });
        this.routeDynaUnavailableKeys.delete(cacheKey);
        return data;
      })
      .catch(error => {
        if (!this.routeDynaUnavailableKeys.has(cacheKey)) {
          console.warn(
            `[BusPlanner] RouteDyna source unavailable for route ${cacheKey}; using fallback sources.`,
            error
          );
          this.routeDynaUnavailableKeys.add(cacheKey);
        }
        return null;
      })
      .finally(() => {
        this.routeDynaInFlight.delete(cacheKey);
      });

    this.routeDynaInFlight.set(cacheKey, request);
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
    if (seconds < 60) {
      return { etaText: '\u5c07\u5230\u7ad9', rawTime: seconds };
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
    if (eta.etaText === '\u5c07\u5230\u7ad9') return 5;
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
    localStops: { sid: string; name: string }[],
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
    const cachedMapping = await this.readCachedTaipeiRouteStopMapping(route);
    if (cachedMapping) {
      return cachedMapping;
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
      const cacheKey = this.getTaipeiRouteStopMappingCacheKey(route.route_name, route.direction);
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

  private async readCachedTaipeiRouteStopMapping(route: any): Promise<{
    officialRouteId: string;
    estimateRouteId?: string;
    stopIdByLocalSid: Map<string, string>;
  } | undefined> {
    const cacheKey = this.getTaipeiRouteStopMappingCacheKey(route.route_name, route.direction);

    try {
      const cached = await AsyncStorage.getItem(cacheKey);
      if (!cached) {
        return undefined;
      }

      const parsed = JSON.parse(cached) as CachedTaipeiRouteStopMapping;
      return {
        officialRouteId: parsed.officialRouteId,
        estimateRouteId: parsed.estimateRouteId,
        stopIdByLocalSid: new Map(Object.entries(parsed.stopIdByLocalSid)),
      };
    } catch (error) {
      console.warn('[BusPlanner] Failed to read Taipei route-stop mapping cache.', error);
      return undefined;
    }
  }

  private warmTaipeiRouteStopMapping(route: any): void {
    const cacheKey = this.getTaipeiRouteStopMappingCacheKey(route.route_name, route.direction);
    if (this.taipeiRouteStopMappingWarmups.has(cacheKey)) {
      return;
    }

    this.taipeiRouteStopMappingWarmups.add(cacheKey);
    this.getTaipeiRouteStopMapping(route)
      .catch(error => {
        console.warn('[BusPlanner] Failed to warm Taipei route-stop mapping.', error);
      })
      .finally(() => {
        this.taipeiRouteStopMappingWarmups.delete(cacheKey);
      });
  }

  private getEstimateRowsForRoute(
    dataset: TaipeiEstimateRow[],
    routeId: string | number | undefined,
    direction: number
  ): TaipeiEstimateRow[] {
    if (routeId === undefined || routeId === null || routeId === '') {
      return [];
    }

    const routeRows = dataset.filter(
      item => String(this.getEstimateField(item, ['RouteID', 'routeId', 'RouteId']) ?? '') === String(routeId)
    );
    const directionRows = routeRows.filter(row => {
      const goBack = this.getEstimateField(row, ['GoBack', 'goBack']);
      return goBack !== undefined && goBack !== null && String(goBack) === String(direction);
    });

    return directionRows.length > 0 ? directionRows : routeRows;
  }

  private getAllEstimateRowsForRoute(
    dataset: TaipeiEstimateRow[],
    routeId: string | number | undefined
  ): TaipeiEstimateRow[] {
    if (routeId === undefined || routeId === null || routeId === '') {
      return [];
    }

    return dataset.filter(
      item => String(this.getEstimateField(item, ['RouteID', 'routeId', 'RouteId']) ?? '') === String(routeId)
    );
  }

  private buildRouteStopArrivalsFromEstimateRows(
    route: any,
    rows: TaipeiEstimateRow[],
    stopIdByLocalSid: Map<string, string>
  ): { data: RouteDirectionDetails; matchedCount: number } | undefined {
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

    let matchedCount = 0;
    const stops = (route.stops_sid as string[]).map((sid: string) => {
      const info = this.getStopInfo(sid);
      const officialStopId = stopIdByLocalSid.get(String(sid));
      const realtime = officialStopId ? bestByStopId.get(officialStopId) : undefined;

      if (realtime) {
        matchedCount += 1;
      }

      return {
        sid,
        slid: info?.slid,
        name: info?.name || 'Unknown',
        etaText: realtime?.etaText || '\u66ab\u7121\u8cc7\u6599',
        rawTime: realtime?.rawTime ?? CONFIG.TIME_NOT_DEPARTED,
      };
    });

    return {
      matchedCount,
      data: {
        routeName: route.route_name,
        rid: route.rid,
        direction: route.direction,
        directionText: this.getDirectionText(route.direction),
        stops,
      },
    };
  }

  private isDirectEstimateResultUseful(matchedCount: number, stopCount: number): boolean {
    if (matchedCount === 0) {
      return false;
    }

    return matchedCount / Math.max(stopCount, 1) >= CONFIG.DIRECT_ESTIMATE_MIN_MATCH_RATIO;
  }

  private async getRouteStopArrivalsFromTaipeiOpenData(
    route: any
  ): Promise<RouteDirectionDetails | undefined> {
    const dataset = await this.fetchTaipeiEstimateDataset();
    if (dataset.length === 0) {
      return undefined;
    }

    const directStopIds = new Map(
      (route.stops_sid as string[]).map((sid: string) => [String(sid), String(sid)])
    );
    const directRows = this.getEstimateRowsForRoute(dataset, route.rid, route.direction);
    const directResult = this.buildRouteStopArrivalsFromEstimateRows(route, directRows, directStopIds);

    const mappedMapping = await this.getTaipeiRouteStopMapping(route);
    const mappedResult = mappedMapping
      ? this.buildRouteStopArrivalsFromEstimateRows(
          route,
          this.getAllEstimateRowsForRoute(
            dataset,
            mappedMapping.estimateRouteId || mappedMapping.officialRouteId
          ),
          mappedMapping.stopIdByLocalSid
        )
      : undefined;

    if (
      mappedResult &&
      (!directResult || mappedResult.matchedCount >= directResult.matchedCount)
    ) {
      return mappedResult.data;
    }

    if (
      directResult &&
      this.isDirectEstimateResultUseful(directResult.matchedCount, route.stops_sid.length)
    ) {
      return directResult.data;
    }

    return directResult?.matchedCount ? directResult.data : undefined;
  }

  private async getRouteStopArrivalsFromNewTaipeiOpenData(
    route: any
  ): Promise<RouteDirectionDetails | undefined> {
    const dataset = await this.fetchNewTaipeiEstimateDataset(route.rid);
    if (dataset.length === 0) {
      return undefined;
    }

    const directStopIds = new Map(
      (route.stops_sid as string[]).map((sid: string) => [String(sid), String(sid)])
    );
    const rows = this.getEstimateRowsForRoute(dataset, route.rid, route.direction);
    const result = this.buildRouteStopArrivalsFromEstimateRows(route, rows, directStopIds);

    return result?.matchedCount ? result.data : undefined;
  }

  private async getRouteStopArrivalsFromRouteDyna(
    route: any
  ): Promise<RouteDirectionDetails | undefined> {
    const payload = await this.fetchRouteDynaByRouteIdCached(route.rid);
    const stopRows = Array.isArray(payload?.Stop) ? payload.Stop : [];

    if (stopRows.length === 0) {
      return undefined;
    }

    const rows: TaipeiEstimateRow[] = [];
    for (const stopRow of stopRows) {
      const values = String(stopRow?.n1 || '').split(',');
      if (values.length < 8) {
        continue;
      }

      rows.push({
        RouteID: values[2],
        StopID: values[1],
        EstimateTime: values[7],
      });
    }

    const directStopIds = new Map(
      (route.stops_sid as string[]).map((sid: string) => [String(sid), String(sid)])
    );
    const result = this.buildRouteStopArrivalsFromEstimateRows(route, rows, directStopIds);

    return result?.matchedCount ? result.data : undefined;
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

  private normalizeDirectionHint(directionHint: string): string {
    return directionHint.replace(/^往\s*/, '').trim();
  }

  private getRouteTerminalStopNameFromRoute(route: any): string | undefined {
    const stopSids = Array.isArray(route.stops_sid) ? (route.stops_sid as string[]) : [];
    const lastSid = stopSids[stopSids.length - 1];
    if (!lastSid) return undefined;

    const info = this.getStopInfo(lastSid);
    return info?.name?.trim() || undefined;
  }

  private getRoutesForDisplay(routeName: string, rid?: string): any[] {
    const routesByName = this.routeDb.filter(route => route.route_name === routeName);
    if (!rid) {
      return routesByName;
    }

    const routesByNameAndRid = routesByName.filter(route => route.rid === rid);
    return routesByNameAndRid.length > 0 ? routesByNameAndRid : routesByName;
  }

  public resolveRouteDirection(
    routeName: string,
    rid?: string,
    directionHint?: number | string
  ): number | undefined {
    const candidates = this.getRoutesForDisplay(routeName, rid);
    if (candidates.length === 0) {
      return undefined;
    }

    if (typeof directionHint === 'number') {
      const exactDirection = candidates.find(route => route.direction === directionHint);
      if (exactDirection) {
        return exactDirection.direction;
      }
    }

    if (typeof directionHint === 'string') {
      const normalizedHint = this.normalizeDirectionHint(directionHint);

      if (normalizedHint === this.getDirectionText(0)) {
        return candidates.some(route => route.direction === 0) ? 0 : undefined;
      }

      if (normalizedHint === this.getDirectionText(1)) {
        return candidates.some(route => route.direction === 1) ? 1 : undefined;
      }

      if (normalizedHint) {
        const terminalMatches = candidates.filter(route => {
          const terminalStopName = this.getRouteTerminalStopNameFromRoute(route);
          return terminalStopName && this.normalizeDirectionHint(terminalStopName) === normalizedHint;
        });

        if (terminalMatches.length === 1) {
          return terminalMatches[0].direction;
        }

        const stopMatches = candidates.filter(route =>
          (route.stops_sid as string[]).some((sid: string) => {
            const stopName = this.getStopInfo(sid)?.name?.trim();
            return stopName && this.normalizeDirectionHint(stopName) === normalizedHint;
          })
        );

        if (stopMatches.length === 1) {
          return stopMatches[0].direction;
        }
      }
    }

    if (candidates.length === 1) {
      return candidates[0].direction;
    }

    return undefined;
  }

  public getRouteTerminalStopName(
    routeName: string,
    rid?: string,
    directionHint?: number | string
  ): string | undefined {
    const candidates = this.getRoutesForDisplay(routeName, rid);
    if (candidates.length === 0) {
      return undefined;
    }

    const resolvedDirection = this.resolveRouteDirection(routeName, rid, directionHint);
    const route =
      candidates.find(candidate => candidate.direction === resolvedDirection) ?? candidates[0];

    return this.getRouteTerminalStopNameFromRoute(route);
  }

  public getRouteDisplayDirection(
    routeName: string,
    rid?: string,
    directionHint?: number | string
  ): string {
    const terminalStopName = this.getRouteTerminalStopName(routeName, rid, directionHint);
    if (terminalStopName) {
      return `\u5f80 ${terminalStopName}`;
    }

    if (typeof directionHint === 'number') {
      return this.getDirectionText(directionHint);
    }

    if (typeof directionHint === 'string') {
      return directionHint.trim();
    }

    return '';
  }

  private shouldHydrateRouteStopArrival(bus: BusInfo): boolean {
    const currentText = String(bus.arrivalTimeText || '').trim();
    if (!currentText) {
      return true;
    }

    return (
      bus.rawTime >= CONFIG.TIME_NOT_DEPARTED ||
      currentText === BusStatus.NOT_DEPARTED ||
      currentText === BusStatus.UNKNOWN
    );
  }

  private isUsefulRouteStopArrival(etaText: string, rawTime: number): boolean {
    const text = etaText.trim();
    if (!text) {
      return false;
    }

    if (text === BusStatus.UNKNOWN) {
      return false;
    }

    return rawTime < CONFIG.TIME_NOT_DEPARTED || text !== BusStatus.NOT_DEPARTED;
  }

  private async findUsefulRouteStopArrival(
    routeName: string,
    rid: string | undefined,
    directionHint: number | string | undefined,
    sid: string
  ): Promise<{ etaText: string; rawTime: number } | undefined> {
    const resolvedDirection = this.resolveRouteDirection(routeName, rid, directionHint);
    if (resolvedDirection === undefined) {
      return undefined;
    }

    try {
      const directionDetails = await this.getRouteStopArrivals(routeName, resolvedDirection);
      const currentStopInfo = this.getStopInfo(sid);
      const matchedStop =
        directionDetails?.stops.find(stop => stop.sid === sid) ||
        (currentStopInfo?.slid
          ? directionDetails?.stops.find(stop => stop.slid === currentStopInfo.slid)
          : undefined) ||
        (currentStopInfo?.name
          ? directionDetails?.stops.find(stop => stop.name === currentStopInfo.name)
          : undefined);
      if (!matchedStop) {
        return undefined;
      }

      const etaText = String(matchedStop.etaText || '').trim();
      const rawTime =
        typeof matchedStop.rawTime === 'number' ? matchedStop.rawTime : CONFIG.TIME_NOT_DEPARTED;

      if (!this.isUsefulRouteStopArrival(etaText, rawTime)) {
        return undefined;
      }

      return { etaText, rawTime };
    } catch (error) {
      console.warn(
        `[BusPlanner] Failed to hydrate route-stop realtime for ${routeName} (${rid || 'unknown'}).`,
        error
      );
      return undefined;
    }
  }

  private async hydrateBusArrivalFromRouteStop(bus: BusInfo): Promise<BusInfo> {
    if (!this.shouldHydrateRouteStopArrival(bus)) {
      return bus;
    }

    const routeStopArrival = await this.findUsefulRouteStopArrival(
      bus.routeName,
      bus.rid,
      bus.directionText,
      bus.sid
    );

    if (!routeStopArrival) {
      return bus;
    }

    return {
      ...bus,
      arrivalTimeText: routeStopArrival.etaText,
      rawTime: routeStopArrival.rawTime,
    };
  }

  private async hydrateBusesFromRouteStops(buses: BusInfo[]): Promise<BusInfo[]> {
    if (buses.length === 0) {
      return buses;
    }

    return Promise.all(buses.map(bus => this.hydrateBusArrivalFromRouteStop(bus)));
  }

  private shouldHydrateRealtimeBusArrival(bus: any): boolean {
    const currentText = String(bus.time_text || bus.timeText || '').trim();
    const rawTime =
      typeof bus.raw_time === 'number'
        ? bus.raw_time
        : typeof bus.rawTime === 'number'
          ? bus.rawTime
          : CONFIG.TIME_NOT_DEPARTED;

    if (!currentText) {
      return true;
    }

    return (
      rawTime >= CONFIG.TIME_NOT_DEPARTED ||
      currentText === BusStatus.NOT_DEPARTED ||
      currentText === BusStatus.UNKNOWN
    );
  }

  private async hydrateRealtimeBusFromRouteStop(bus: any): Promise<any> {
    if (!this.shouldHydrateRealtimeBusArrival(bus)) {
      return bus;
    }

    const routeStopArrival = await this.findUsefulRouteStopArrival(
      String(bus.route || ''),
      typeof bus.rid === 'string' ? bus.rid : undefined,
      bus.direction,
      String(bus.sid || '')
    );

    if (!routeStopArrival) {
      return bus;
    }

    return {
      ...bus,
      time_text: routeStopArrival.etaText,
      timeText: routeStopArrival.etaText,
      raw_time: routeStopArrival.rawTime,
      rawTime: routeStopArrival.rawTime,
    };
  }

  private async hydrateRealtimeBusesFromRouteStops(buses: any[]): Promise<any[]> {
    if (buses.length === 0) {
      return buses;
    }

    return Promise.all(buses.map(bus => this.hydrateRealtimeBusFromRouteStop(bus)));
  }


  // --- Public API Methods ---

  /**
   * Resolve geo coordinates for a stop SID.
   * @param sid stop id
   * @returns coordinates or undefined
   */
  public getGeoBySid(sid: string): GeoLocation | undefined {
    const info = this.getStopInfo(sid);
    return info?.geo;
  }

  /**
   * Return every stop name known to the local stop database.
   */
  public getAllStopNames(): string[] {
    return Object.keys(this.stopDb.n);
  }

  /**
   * Get representative SIDs for a stop name.
   * Multiple SIDs may map to the same SLID, so this method deduplicates
   * by SLID to reduce duplicate realtime requests.
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
   * Find the nearest stop name from a user location.
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
   * Calculate straight-line distance with the Haversine formula.
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // earth radius in km
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
   * Return the static structure for a route RID.
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
   * Build static route-detail data for a route name.
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
  private async fetchRouteStopArrivalsUncached(
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

    const routeDynaRealtime = await this.getRouteStopArrivalsFromRouteDyna(route);
    if (routeDynaRealtime) {
      return routeDynaRealtime;
    }

    const newTaipeiRealtime = await this.getRouteStopArrivalsFromNewTaipeiOpenData(route);
    if (newTaipeiRealtime) {
      return newTaipeiRealtime;
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

    const realtimeResults = await this.withTimeout(
      this.batchProcess(
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
      ),
      CONFIG.ROUTE_DETAIL_FALLBACK_TIMEOUT_MS,
      [],
      `[BusPlanner] Route detail fallback timed out for ${routeName} ${direction}.`
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

  public async getRouteStopArrivals(
    routeName: string,
    direction: number
  ): Promise<RouteDirectionDetails | undefined> {
    const cacheKey = this.getRouteStopArrivalsCacheKey(routeName, direction);
    const now = Date.now();
    const cached = BusPlannerService.routeStopArrivalsCache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      return cached.data;
    }

    const existingRequest = BusPlannerService.routeStopArrivalsInFlight.get(cacheKey);
    if (existingRequest) {
      return existingRequest;
    }

    const request = this.fetchRouteStopArrivalsUncached(routeName, direction)
      .then(data => {
        if (data) {
          BusPlannerService.routeStopArrivalsCache.set(cacheKey, {
            expiresAt: Date.now() + CONFIG.REALTIME_CACHE_TTL_MS,
            data,
          });
        }

        return data;
      })
      .finally(() => {
        BusPlannerService.routeStopArrivalsInFlight.delete(cacheKey);
      });

    BusPlannerService.routeStopArrivalsInFlight.set(cacheKey, request);
    return request;
  }

  public async prefetchRouteStopArrivals(
    routeName: string,
    rid?: string,
    directionHint?: number | string
  ): Promise<RouteDirectionDetails | undefined> {
    const direction = this.resolveRouteDirection(routeName, rid, directionHint);
    if (direction === undefined) {
      return undefined;
    }

    return this.getRouteStopArrivals(routeName, direction);
  }

  public async fetchBusesAtSid(sid: string): Promise<any[]> {
    const info = this.getStopInfo(sid);
    if (!info) return [];

    const slid = info.slid;

    if (!slid) {
      console.warn(`[BusPlanner] SID ${sid} is missing a usable SLID`);
      return [];
    }

    // Reuse the stop SLID directly when the caller already resolved it.
    return this.getArrivalsBySlid(slid, sid);
  }

  private findStaticRoutes(startName: string, endName: string): StaticRouteMatch[] {
    const startSids = new Set(this.getSidsByName(startName));
    const endSids = new Set(this.getSidsByName(endName));

    if (startSids.size === 0 || endSids.size === 0) {
        console.warn(`[BusPlanner] Could not resolve stop pair: ${startName} -> ${endName}`);
        return [];
    }

    const candidates: StaticRouteMatch[] = [];

    // Scan every static route for valid start/end index pairs.
    for (const route of this.routeDb) {
        const stops: string[] = route.stops_sid;
        
        // 1. Collect every index where the route passes the start stop.
        const startIndices = stops
            .map((sid, idx) => startSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);
            
        // 2. Collect every index where the route passes the end stop.
        const endIndices = stops
            .map((sid, idx) => endSids.has(sid) ? idx : -1)
            .filter(i => i !== -1);

        if (startIndices.length === 0 || endIndices.length === 0) continue;

        // 3. Keep only forward-moving matches, equivalent to the old Python logic.
        for (const sIdx of startIndices) {
            // Use the first end index that appears after the start index.
            const firstValidEnd = endIndices.find(eIdx => eIdx > sIdx);
            
            if (firstValidEnd !== undefined) {
                candidates.push({
                    route_name: route.route_name,
                    rid: route.rid,
                    direction: route.direction,
                    stops_sid: route.stops_sid,
                    match_range: [sIdx, firstValidEnd]
                });
                // We keep scanning because the same route may have multiple valid
                // stop-pair matches across different shared stop variants.
            }
        }
    }
    return candidates;
  }

  // --- Network Logic ---

  /**
   * Run async work in bounded batches to avoid overloading upstream APIs.
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

  private shouldUseStaticStopRouteLookup(): boolean {
    return typeof window !== 'undefined' && CONFIG.BASE_URL.includes('api.codetabs.com');
  }

  private getStaticRealtimeRoutesForStop(repSid: string): any[] {
    const repInfo = this.getStopInfo(repSid);
    if (!repInfo) {
      return [];
    }

    const cacheKey = `${repInfo.slid || ''}:${repInfo.name}`;
    const cached = this.staticStopRoutesCache.get(cacheKey);
    if (cached) {
      return cached.map(item => ({ ...item }));
    }

    const seen = new Set<string>();
    const targetSlid = repInfo.slid;
    const targetName = repInfo.name;
    const candidates: any[] = [];

    for (const route of this.routeDb) {
      const matchedSid = (route.stops_sid as string[]).find((sid: string) => {
        const info = this.getStopInfo(sid);
        if (!info) {
          return false;
        }

        if (targetSlid && info.slid === targetSlid) {
          return true;
        }

        return info.name === targetName;
      });

      if (!matchedSid) {
        continue;
      }

      const uniqueKey = `${route.rid}:${route.direction}`;
      if (seen.has(uniqueKey)) {
        continue;
      }
      seen.add(uniqueKey);

      candidates.push({
        route: route.route_name,
        rid: route.rid,
        sid: matchedSid,
        direction: this.getRouteDisplayDirection(route.route_name, route.rid, route.direction),
        time_text: BusStatus.NOT_DEPARTED,
        raw_time: CONFIG.TIME_NOT_DEPARTED,
      });
    }

    candidates.sort((a, b) => compareArrivals(a, b));
    this.staticStopRoutesCache.set(cacheKey, candidates);
    return candidates.map(item => ({ ...item }));
  }

  private async fetchRealtimeBySlid(slid: string, repSid: string): Promise<any[]> {
    if (this.shouldUseStaticStopRouteLookup()) {
      const staticRoutes = this.getStaticRealtimeRoutesForStop(repSid);
      if (staticRoutes.length > 0) {
        return staticRoutes;
      }
    }

    const urlHtml = `${CONFIG.BASE_URL}/stoplocation.jsp?slid=${slid}`;
    const urlJson = `${CONFIG.BASE_URL}/StopLocationDyna?stoplocationid=${slid}`;

    try {
        const [resHtml, resJson] = await Promise.all([
            this.fetchWithTimeout(urlHtml).then(r => (r.ok ? r.text() : "")).catch(() => ""),
            this.fetchWithTimeout(urlJson).then(r => (r.ok ? r.json() : null)).catch(() => null)
        ]);

        if (!resHtml) return [];

        const $ = cheerio.load(resHtml);
        const routeMap: Record<string, { route: string; rid: string; direction: string }> = {};

        // Parse route id + direction metadata from the stop HTML.
        $('tr').each((_, row) => {
            const $row = $(row);
            const cols = $row.find('td');
            
            // Ignore rows without the expected route / direction columns.
            if (cols.length < 3) return;
            
            const link = $row.find('a[href*="route.jsp"]').first();
            if (!link.length) return;

            const href = link.attr('href') || "";
            const ridMatch = href.match(/rid=(\d+)/);
            const rid = ridMatch ? ridMatch[1] : "";
            
            // Direction text is rendered in the third column.
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

        // Merge the realtime JSON payload with the parsed route metadata.
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
                        direction: info.direction,
                        time_text: timeText,
                        raw_time: TimeParser.parseTextToSeconds(timeText)
                    });
                }
            }
        }

        // Keep missing realtime entries as "?芰頠? so the UI can still show the line.
        for (const k in routeMap) {
            buses.push({
                route: routeMap[k].route,
                rid: routeMap[k].rid,
                sid: repSid,
                direction: routeMap[k].direction,
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
    console.log(`[BusPlanner] Planning: ${startName} -> ${endName}`);

    // 0. Cache check
    const cacheKey = `${CONFIG.CACHE_KEY_PREFIX}${startName}|${endName}`;
    try {
        const cached = await AsyncStorage.getItem(cacheKey);
        if (cached) {
            const cachedBuses: BusInfo[] = JSON.parse(cached);
            console.log('[BusPlanner] Using cached route plan, refreshing realtime data...');
            return await this.updateCachedBuses(cachedBuses);
        }
    } catch { /* ignore */ }

    // 1. Find candidate routes from local topology.
    const matchedRoutes = this.findStaticRoutes(startName, endName);
    if (matchedRoutes.length === 0) return [];
    
    console.log(`Found ${matchedRoutes.length} static candidates.`);

    // 2. Prepare realtime fetches by unique SLID.
    const slidMap = new Map<string, string>(); // slid -> representative sid
    
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

    // 3. Fetch realtime batches.
    const nestedResults = await this.batchProcess(
        tasks,
        (task) => this.fetchRealtimeBySlidCached(task.slid, task.sid)
    );
    const allRealtimeBuses = nestedResults.flat();

    // Re-index realtime buses as SLID -> realtime bus list.
    const realtimeLookup: Record<string, any[]> = {};
    allRealtimeBuses.forEach(b => {
        // fetchRealtimeBySlid stores the representative sid, so convert it back
        // to the current SLID bucket before matching by rid.
        const info = this.getStopInfo(b.sid);
        if (info && info.slid) {
            if (!realtimeLookup[info.slid]) realtimeLookup[info.slid] = [];
            realtimeLookup[info.slid].push(b);
        }
    });

    // 4. Construct final route-plan results.
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

        // Build the path segment between the selected start and end stops.
        const pathSids = route.stops_sid.slice(startIdx, endIdx + 1);
        const pathStops: StopInfo[] = pathSids.map(sid => {
            const info = this.getStopInfo(sid);
            return {
                name: info?.name || 'Unknown',
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
            estimatedDuration: Math.ceil((pathStops.length - 1) * 2 + 1), // rough estimate
            startGeo: pathStops[0].geo,
            endGeo: pathStops[pathStops.length - 1].geo,
            pathStops: pathStops
        });
    }

    // 5. Sort & cache.
    const hydratedBuses = await this.hydrateBusesFromRouteStops(finalBuses);
    hydratedBuses.sort((a, b) => compareArrivals(a, b));
    
    // Cache without dynamic time
    AsyncStorage.setItem(cacheKey, JSON.stringify(hydratedBuses)).catch(() => {});

    return hydratedBuses;
  }

  public async getArrivalsBySlid(slid: string, repSid: string): Promise<any[]> {
    console.log(`[BusPlanner] Using direct SLID: ${slid}`);

    const buses = await this.fetchRealtimeBySlidCached(slid, repSid);
    const hydratedBuses = await this.hydrateRealtimeBusesFromRouteStops(buses);

    // Sort with the shared arrival comparator so urgent arrivals stay first.
    return hydratedBuses.sort((a, b) => compareArrivals(a, b));
  }

  public async getStopArrivals(stopName: string): Promise<any[]> {
    // 1. Guard against an uninitialized service.
    if (!this.stopDb) {
      console.warn("Service not initialized, loading DB...");
      // Constructor eagerly loads the JSON bundles, so this is mostly defensive.
    }

    // 2. Resolve every SID for this stop name.
    const sids = this.getSidsByName(stopName);
    if (sids.length === 0) return [];

    // 3. Deduplicate by SLID so repeated stop positions only fetch once.
    const slidMap = new Map<string, string>(); // slid -> representative sid
    
    for (const sid of sids) {
      const info = this.getStopInfo(sid);
      if (info && info.slid) {
        if (!slidMap.has(info.slid)) {
          slidMap.set(info.slid, sid);
        }
      }
    }

    // 4. Fetch realtime data in batches.
    const tasks = Array.from(slidMap.entries()).map(([slid, sid]) => ({ slid, sid }));
    
    const nestedResults = await this.batchProcess(
      tasks,
      (task) => this.fetchRealtimeBySlidCached(task.slid, task.sid)
    );

    // 5. Flatten and sort the final realtime bus list.
    const allBuses = nestedResults.flat();
    const hydratedBuses = await this.hydrateRealtimeBusesFromRouteStops(allBuses);
    return hydratedBuses.sort((a, b) => compareArrivals(a, b));
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

    const result = await this.hydrateBusesFromRouteStops(updatedArrays.flat());
    result.sort((a, b) => compareArrivals(a, b));
    return result;
  }
}

