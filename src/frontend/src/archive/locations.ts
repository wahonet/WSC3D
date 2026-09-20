import groups from '../data/location-groups.json';

/** Shared with /api/stats; leaf locations retain their precise physical position. */
export const LOCATION_GROUPS: { key: string; locs?: string[]; children?: string[] }[] = groups;
export function locationKeys(location: string): string[] {
  for (const group of LOCATION_GROUPS) {
    if (group.children?.includes(location)) return [group.key, location];
    if (group.locs?.includes(location)) return [group.key];
  }
  return [location];
}
export function locLabel(location: string | undefined | null): string {
  return location ? locationKeys(location).join(' · ') : '全景';
}
