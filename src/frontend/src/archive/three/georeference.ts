/** Provisional horizontal coordinates; model Y is never an absolute survey height. */
export interface Georeference {
  version?: number;
  status?: string;
  sourceType?: string;
  datum: { horizontal: string; vertical: string; calculationEllipsoid?: string; [key: string]: unknown };
  origin: { latitudeDeg: number; longitudeDeg: number; heightM: number; [key: string]: unknown };
  transform: { matrix2x3: readonly (readonly number[])[]; scale?: number; [key: string]: unknown };
  vertical?: { controlHeightM?: number; modelZeroHeightConfirmed?: boolean; [key: string]: unknown };
  quality?: { rmsM: number; maxM: number; isSurveyAccuracy?: boolean; [key: string]: unknown };
  controls?: readonly {
    id: string | number; name: string; latitudeDeg: number; longitudeDeg: number;
    modelWorldXZ: readonly number[]; enu: readonly number[]; fittedEnu: readonly number[];
    residualM: number; [key: string]: unknown;
  }[];
  boundaryWorldXZ?: readonly (readonly number[])[];
  notes?: readonly string[];
  [key: string]: unknown;
}

export interface GeographicPosition {
  latitudeDeg: number;
  longitudeDeg: number;
  modelYMetres: number;
  eastMetres: number;
  northMetres: number;
  status: 'provisional';
  horizontalDatum: string;
  verticalDatum: string;
}

const A = 6378137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const RAD = Math.PI / 180;

function finite(...values: number[]) {
  if (!values.every(Number.isFinite)) throw new RangeError('Coordinates must be finite numbers.');
}

function checkGeographic(latitudeDeg: number, longitudeDeg: number) {
  finite(latitudeDeg, longitudeDeg);
  if (Math.abs(latitudeDeg) > 90 || Math.abs(longitudeDeg) > 180) {
    throw new RangeError('Latitude or longitude is outside its angular range.');
  }
}

function toECEF(latitudeDeg: number, longitudeDeg: number, heightM: number) {
  const latitude = latitudeDeg * RAD, longitude = longitudeDeg * RAD;
  const sinLatitude = Math.sin(latitude), cosLatitude = Math.cos(latitude);
  const n = A / Math.sqrt(1 - E2 * sinLatitude * sinLatitude);
  return [
    (n + heightM) * cosLatitude * Math.cos(longitude),
    (n + heightM) * cosLatitude * Math.sin(longitude),
    (n * (1 - E2) + heightM) * sinLatitude,
  ];
}

function frame(ref: Georeference) {
  const { latitudeDeg, longitudeDeg, heightM } = ref.origin;
  checkGeographic(latitudeDeg, longitudeDeg);
  finite(heightM);
  if (ref.datum.calculationEllipsoid && ref.datum.calculationEllipsoid !== 'WGS84') {
    throw new RangeError('This conversion currently supports the WGS84 calculation ellipsoid.');
  }
  const matrix = ref.transform.matrix2x3;
  if (matrix.length !== 2 || matrix.some(row => row.length !== 3)) {
    throw new RangeError('The horizontal transform must be a 2 by 3 matrix.');
  }
  finite(...matrix[0], ...matrix[1]);
  const latitude = latitudeDeg * RAD, longitude = longitudeDeg * RAD;
  return {
    matrix,
    origin: toECEF(latitudeDeg, longitudeDeg, heightM),
    sinLat: Math.sin(latitude), cosLat: Math.cos(latitude),
    sinLon: Math.sin(longitude), cosLon: Math.cos(longitude),
  };
}

/** Apply the full-scene X/Z registration and project the horizontal ENU plane (U=0). */
export function worldToGeographic(
  ref: Georeference, world: { x: number; y: number; z: number },
): GeographicPosition {
  finite(world.x, world.y, world.z);
  const f = frame(ref), [a, b] = f.matrix;
  const eastMetres = a[0] * world.x + a[1] * world.z + a[2];
  const northMetres = b[0] * world.x + b[1] * world.z + b[2];
  // U is deliberately zero. The model's Y is not added to the recorded control height.
  const x = f.origin[0] - f.sinLon * eastMetres - f.sinLat * f.cosLon * northMetres;
  const y = f.origin[1] + f.cosLon * eastMetres - f.sinLat * f.sinLon * northMetres;
  const z = f.origin[2] + f.cosLat * northMetres;
  const p = Math.hypot(x, y);
  let latitude = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 12; i++) {
    const sinLatitude = Math.sin(latitude);
    const n = A / Math.sqrt(1 - E2 * sinLatitude * sinLatitude);
    const next = Math.atan2(z + E2 * n * sinLatitude, p);
    if (Math.abs(next - latitude) < 1e-15) { latitude = next; break; }
    latitude = next;
  }
  return {
    latitudeDeg: latitude / RAD,
    longitudeDeg: Math.atan2(y, x) / RAD,
    modelYMetres: world.y,
    eastMetres, northMetres,
    status: 'provisional',
    horizontalDatum: ref.datum.horizontal,
    verticalDatum: ref.datum.vertical,
  };
}

/** Project latitude/longitude at the recorded origin height, then invert the X/Z matrix. */
export function geographicToWorldXZ(
  ref: Georeference, latitudeDeg: number, longitudeDeg: number,
): { x: number; z: number } {
  checkGeographic(latitudeDeg, longitudeDeg);
  const f = frame(ref);
  const point = toECEF(latitudeDeg, longitudeDeg, ref.origin.heightM);
  const dx = point[0] - f.origin[0], dy = point[1] - f.origin[1], dz = point[2] - f.origin[2];
  const east = -f.sinLon * dx + f.cosLon * dy;
  const north = -f.sinLat * f.cosLon * dx - f.sinLat * f.sinLon * dy + f.cosLat * dz;
  const [a, b] = f.matrix;
  const determinant = a[0] * b[1] - a[1] * b[0];
  if (Math.abs(determinant) < 1e-12) throw new RangeError('The horizontal transform is singular.');
  const e = east - a[2], n = north - b[2];
  return { x: (b[1] * e - a[1] * n) / determinant, z: (a[0] * n - b[0] * e) / determinant };
}
