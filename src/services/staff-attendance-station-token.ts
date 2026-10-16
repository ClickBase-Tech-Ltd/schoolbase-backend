import { randomUUID } from 'node:crypto';
import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

export const ATTENDANCE_STATION_TOKEN_ISSUER = 'schoolbase-attendance-station';
export const ATTENDANCE_STATION_TOKEN_AUDIENCE = 'staff-attendance-scan';
export const ATTENDANCE_STATION_TOKEN_TTL_SECONDS = 60;

export interface AttendanceStationTokenPayload extends JWTPayload {
  schoolId: string;
  stationId: string;
  tokenVersion: number;
}

export async function issueAttendanceStationToken(input: {
  schoolId: string;
  stationId: string;
  tokenVersion: number;
  secret: Uint8Array;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const issuedAt = Math.floor(now.getTime() / 1000);
  const expiresAt = issuedAt + ATTENDANCE_STATION_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    schoolId: input.schoolId,
    stationId: input.stationId,
    tokenVersion: input.tokenVersion,
    purpose: 'STAFF_ATTENDANCE_STATION',
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ATTENDANCE_STATION_TOKEN_ISSUER)
    .setAudience(ATTENDANCE_STATION_TOKEN_AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .setJti(randomUUID())
    .sign(input.secret);

  return { token, expiresAt: new Date(expiresAt * 1000) };
}

export async function verifyAttendanceStationToken(token: string, secret: Uint8Array, now = new Date()) {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: ATTENDANCE_STATION_TOKEN_ISSUER,
      audience: ATTENDANCE_STATION_TOKEN_AUDIENCE,
      currentDate: now,
      maxTokenAge: `${ATTENDANCE_STATION_TOKEN_TTL_SECONDS}s`,
    });
    if (payload.purpose !== 'STAFF_ATTENDANCE_STATION'
      || typeof payload.schoolId !== 'string'
      || typeof payload.stationId !== 'string'
      || typeof payload.tokenVersion !== 'number'
      || typeof payload.jti !== 'string') {
      throw new Error('Invalid attendance station token');
    }
    return payload as AttendanceStationTokenPayload & { jti: string };
  } catch {
    throw Object.assign(new Error('Attendance station code is invalid or expired.'), { statusCode: 400 });
  }
}
