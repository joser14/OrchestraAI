import { test } from 'node:test';
import assert from 'node:assert/strict';
import { similar } from '../src/api.ts';

test('duplicate-job detector catches the six planets jobs the brain assigned on 2026-10-11', () => {
  const first = 'List the 8 planets in order from the sun, one line each with one fact';
  for (const again of [
    'Generate a PDF listing the 8 planets in order from the sun, one line each with one fact',
    'Generate a Markdown file listing the 8 planets in order from the sun, one line each with one fact',
  ]) assert.ok(similar(first, again) >= 0.6, again);
});

test('different jobs are not duplicates', () => {
  assert.ok(similar('List the 8 planets in order from the sun', 'Summarize used laptop GPU prices into a table') < 0.2);
  assert.ok(similar('Write the squares of 1 to 12 to D:\\Team\\work\\squares.md', 'Write the days of the week to D:\\Team\\work\\days.md') < 0.6);
});
