import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateCI } from './ci-state.mjs';

test('no check results remain no_checks', () => {
  assert.equal(aggregateCI([]), 'no_checks');
});

test('unfinished checks remain pending', () => {
  assert.equal(aggregateCI([
    { name: 'unit tests', status: 'in_progress', conclusion: null },
  ]), 'pending');
});

test('all successful completed checks aggregate to success', () => {
  assert.equal(aggregateCI([
    { name: 'lint', status: 'completed', conclusion: 'success' },
    { name: 'unit tests', status: 'completed', conclusion: 'success' },
  ]), 'success');
});

test('a failed completed check makes the aggregate fail', () => {
  const actual = aggregateCI([
    { name: 'lint', status: 'completed', conclusion: 'success' },
    { name: 'unit tests', status: 'completed', conclusion: 'failure' },
  ]);
  try {
    assert.equal(actual, 'failure');
  } catch (error) {
    console.log(`::error file=acceptance/fixture/ci-state.mjs,line=9,title=B1 CI state assertion::Expected failure but received ${actual}`);
    throw error;
  }
});
