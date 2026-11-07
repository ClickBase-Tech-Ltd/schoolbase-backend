import assert from 'node:assert/strict';
import { selectLeastLoadedRepresentative } from '../src/services/country-work-assignment.js';

const representatives = [
  { id: 'rep-c', name: 'C' },
  { id: 'rep-a', name: 'A' },
  { id: 'rep-b', name: 'B' },
];

assert.deepEqual(
  selectLeastLoadedRepresentative(representatives, new Map([
    ['rep-a', 4],
    ['rep-b', 2],
    ['rep-c', 1],
  ])),
  { id: 'rep-c', name: 'C' },
);
assert.deepEqual(
  selectLeastLoadedRepresentative(representatives, new Map()),
  { id: 'rep-a', name: 'A' },
  'equal workloads must break ties deterministically by representative ID',
);
assert.equal(selectLeastLoadedRepresentative([], new Map()), null);

console.log('✓ Country work assignment tests passed');
