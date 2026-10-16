import assert from 'node:assert/strict';
import { buildSchoolDateRange } from '../src/services/school-date-range.js';

const lagosDay = buildSchoolDateRange({ startDate: '2026-10-15', endDate: '2026-10-15', timeZone: 'Africa/Lagos' });
assert.ok(lagosDay);
assert.equal(lagosDay.start?.toISOString(), '2026-10-14T23:00:00.000Z');
assert.equal(lagosDay.endExclusive?.toISOString(), '2026-10-15T23:00:00.000Z');

const utcDay = buildSchoolDateRange({ startDate: '2026-02-28', endDate: '2026-03-01', timeZone: 'UTC' });
assert.ok(utcDay);
assert.equal(utcDay.start?.toISOString(), '2026-02-28T00:00:00.000Z');
assert.equal(utcDay.endExclusive?.toISOString(), '2026-03-02T00:00:00.000Z');

assert.equal(buildSchoolDateRange({ startDate: '2026-02-30', timeZone: 'UTC' }), null);
assert.equal(buildSchoolDateRange({ startDate: '2026-10-16', endDate: '2026-10-15', timeZone: 'UTC' }), null);
assert.equal(buildSchoolDateRange({ startDate: '2026-10-15', timeZone: 'Invalid/Zone' }), null);

console.log('School date range tests passed');