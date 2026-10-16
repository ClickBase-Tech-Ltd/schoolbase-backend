import assert from 'node:assert/strict';
import dotenv from 'dotenv';
import { describe, it } from 'node:test';
import { SignJWT } from 'jose';
import { getSessionSecret } from '../src/services/security-config.js';
import {
  ATTENDANCE_STATION_TOKEN_AUDIENCE,
  ATTENDANCE_STATION_TOKEN_ISSUER,
  issueAttendanceStationToken,
  verifyAttendanceStationToken,
} from '../src/services/staff-attendance-station-token.js';

dotenv.config();
const secret = getSessionSecret();
const fixedNow = new Date('2026-10-16T08:00:00.000Z');

describe('attendance station signed tokens', () => {
  it('issues a short-lived token with only station identity and random nonce claims', async () => {
    const issued = await issueAttendanceStationToken({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 3, secret, now: fixedNow });
    const claims = await verifyAttendanceStationToken(issued.token, secret, fixedNow);
    assert.equal(claims.schoolId, 'school-a');
    assert.equal(claims.stationId, 'station-a');
    assert.equal(claims.tokenVersion, 3);
    assert.equal(claims.iss, ATTENDANCE_STATION_TOKEN_ISSUER);
    assert.equal(claims.aud, ATTENDANCE_STATION_TOKEN_AUDIENCE);
    assert.equal(issued.expiresAt.getTime() - fixedNow.getTime(), 60_000);
    assert.equal('employeeId' in claims, false);
    assert.equal('staffNumber' in claims, false);
  });

  it('creates a unique JTI for each rotating code', async () => {
    const first = await issueAttendanceStationToken({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 1, secret, now: fixedNow });
    const second = await issueAttendanceStationToken({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 1, secret, now: fixedNow });
    const firstClaims = await verifyAttendanceStationToken(first.token, secret, fixedNow);
    const secondClaims = await verifyAttendanceStationToken(second.token, secret, fixedNow);
    assert.notEqual(firstClaims.jti, secondClaims.jti);
  });

  it('rejects expired, tampered, wrong-audience, and wrong-purpose codes', async () => {
    const valid = await issueAttendanceStationToken({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 1, secret, now: fixedNow });
    await assert.rejects(verifyAttendanceStationToken(valid.token, secret, new Date(fixedNow.getTime() + 61_000)), /invalid or expired/);
    await assert.rejects(verifyAttendanceStationToken(`${valid.token.slice(0, -1)}x`, secret, fixedNow), /invalid or expired/);

    const wrongAudience = await new SignJWT({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 1, purpose: 'STAFF_ATTENDANCE_STATION' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(ATTENDANCE_STATION_TOKEN_ISSUER).setAudience('wrong-audience')
      .setIssuedAt(Math.floor(fixedNow.getTime() / 1000)).setExpirationTime(Math.floor(fixedNow.getTime() / 1000) + 60).setJti('wrong-audience')
      .sign(secret);
    await assert.rejects(verifyAttendanceStationToken(wrongAudience, secret, fixedNow), /invalid or expired/);

    const wrongPurpose = await new SignJWT({ schoolId: 'school-a', stationId: 'station-a', tokenVersion: 1, purpose: 'OTHER' })
      .setProtectedHeader({ alg: 'HS256' }).setIssuer(ATTENDANCE_STATION_TOKEN_ISSUER).setAudience(ATTENDANCE_STATION_TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(fixedNow.getTime() / 1000)).setExpirationTime(Math.floor(fixedNow.getTime() / 1000) + 60).setJti('wrong-purpose')
      .sign(secret);
    await assert.rejects(verifyAttendanceStationToken(wrongPurpose, secret, fixedNow), /invalid or expired/);
  });
});
