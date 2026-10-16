import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatStaffNumber, inferStaffPrefix, parseStaffNumberSequence } from '../src/services/staff-number.ts';

describe('school staff numbers', () => {
  it('uses configured school initials and a zero-padded sequence', () => {
    assert.equal(inferStaffPrefix('Greenfield Academy', 'GFA'), 'GFA');
    assert.equal(formatStaffNumber('GFA', 2026, 110), 'GFA/ST/2026/00110');
  });

  it('derives a prefix from the school name when initials are not configured', () => {
    assert.equal(inferStaffPrefix('Greenfield Academy'), 'GA');
    assert.equal(inferStaffPrefix('School'), 'S');
    assert.equal(inferStaffPrefix(null), 'SCH');
  });

  it('parses only valid staff numbers for the requested school prefix and year', () => {
    assert.equal(parseStaffNumberSequence('GFA/ST/2026/00110', 'GFA', 2026), 110);
    assert.equal(parseStaffNumberSequence('GFA/ST/2025/00110', 'GFA', 2026), null);
    assert.equal(parseStaffNumberSequence('OTHER/ST/2026/00110', 'GFA', 2026), null);
  });
});