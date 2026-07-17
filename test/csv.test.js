import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/csv.js';

test('plain rows', () => {
  assert.equal(toCsv(['a', 'b'], [[1, 'x']]), 'a,b\r\n1,x\r\n');
});
test('quoting commas, quotes, newlines, nulls', () => {
  const out = toCsv(['v'], [['a,b'], ['say "hi"'], ['line\nbreak'], [null]]);
  assert.equal(out, 'v\r\n"a,b"\r\n"say ""hi"""\r\n"line\nbreak"\r\n\r\n');
});
