import assert from 'node:assert/strict';
import { getUtcReminderWindow } from '../src/jobs/country-follow-up-reminders.js';

const beforeUtcMidnight = getUtcReminderWindow(new Date('2026-11-08T23:59:59.000Z'));
assert.equal(beforeUtcMidnight.today.toISOString(), '2026-11-08T00:00:00.000Z');
assert.equal(beforeUtcMidnight.tomorrow.toISOString(), '2026-11-09T00:00:00.000Z');

const afterUtcMidnight = getUtcReminderWindow(new Date('2026-11-09T00:00:01.000Z'));
assert.equal(afterUtcMidnight.today.toISOString(), '2026-11-09T00:00:00.000Z');
assert.equal(afterUtcMidnight.tomorrow.toISOString(), '2026-11-10T00:00:00.000Z');

console.log('✓ Country follow-up reminder date tests passed');
