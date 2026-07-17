import { regionFromLocation, shouldInitializeRegion } from '../../components/mapLocation';

const location = { lat: 25.013, lon: 121.535, accuracy: 20, timestamp: 1000 };

it('builds the initial region from shared location', () => {
  expect(regionFromLocation(location)).toEqual({
    latitude: 25.013,
    longitude: 121.535,
    latitudeDelta: 0.012,
    longitudeDelta: 0.012,
  });
});

it('initializes only while the map has no region', () => {
  expect(shouldInitializeRegion(null, location)).toBe(true);
  expect(shouldInitializeRegion(regionFromLocation(location), location)).toBe(false);
  expect(shouldInitializeRegion(null, null)).toBe(false);
});
