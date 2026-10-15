import assert from 'node:assert/strict';
import { compactAuditEventFilters } from '../src/services/platform-audit-events.js';

assert.deepEqual(
  compactAuditEventFilters([
    'LOGIN_SUCCESS',
    'API_POST_class-subjects_cmp1234567890123456789_cmq1234567890123456789',
    'API_POST_class-subjects_cmq9876543210987654321_cmq9876543210987654322',
  ]),
  {
    events: ['LOGIN_SUCCESS'],
    eventPrefixes: ['API_POST_class-subjects_'],
  },
);

console.log('Platform audit filter tests passed');
