import {
  calculateNearbyPhysicalStops,
  calculateNearbyStops,
  loadAllStops,
} from '../../components/locationService';

describe('locationService stop cache', () => {
  it('returns the same parsed array after the first load', () => {
    expect(loadAllStops()).toBe(loadAllStops());
  });

  it('returns nearby names once and ordered by distance', () => {
    const stops = calculateNearbyStops({ lat: 25.013, lon: 121.535 }, 800, 50);

    expect(stops.length).toBeGreaterThan(0);
    expect(new Set(stops.map(stop => stop.name)).size).toBe(stops.length);
    expect(stops).toEqual([...stops].sort((a, b) => a.distance - b.distance));
  });

  it('keeps physical stop entries available for the native map', () => {
    const stops = calculateNearbyPhysicalStops({ lat: 25.013, lon: 121.535 }, 800, 200);

    expect(stops.length).toBeGreaterThan(0);
    expect(stops.length).toBeLessThanOrEqual(200);
    expect(stops).toEqual([...stops].sort((a, b) => a.distance - b.distance));
  });
});
