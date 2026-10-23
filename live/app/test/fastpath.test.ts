// Fast path: which requests skip the composer, and the job text the worker gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSimpleRequest, fastTaskText } from '../src/fastpath.ts';

test('one simple do/make job takes the fast path', () => {
  for (const m of ['Write a short haiku about the ocean to ocean-haiku.md in the work folder.', 'Translate the file notes.txt in the inbox into Spanish and save it as notes-es.md',
    'Summarize the report in the inbox into a one-page PDF for me.'])
    assert.equal(isSimpleRequest(m).ok, true, m);
});

test('steps, research, comparisons, questions, lists and follow-ups go to the composer', () => {
  for (const m of ['Research the best budget 4K monitors and give me a PDF comparison', 'Write a summary of the inbox file, then email-ready notes, then a PDF',
    'What is the team working on right now?', '1. write a poem\n2. make a pdf of it', 'you missed one, do it again', 'Make it shorter and punchier please','Compare Notion and Obsidian for note taking'])
    assert.equal(isSimpleRequest(m).ok, false, m);
});

test('borderline requests are sent to the model to judge (unsure)', () => {
  const d = isSimpleRequest('Could you tidy up the shopping list I put in the inbox for this weekend please');
  assert.equal(d.ok, false); assert.equal(d.unsure, true);
});

test('the worker job names a file to write when jr did not, and asks for a PDF when jr did', () => {
  const t = fastTaskText('Write a limerick about cats as a PDF', 'C:\\w');
  assert.match(t, /Save the result as C:\\w\\limerick-cats-pdf\.md|Save the result as C:\\w\\[\w-]+\.md/);
  assert.match(t, /then make it a PDF with team_pdf$/);
  assert.equal(fastTaskText('Write a poem to C:\\w\\poem.md', 'C:\\w'), 'Write a poem to C:\\w\\poem.md');
  // a bare file name is that file in the work folder (seen live: the worker wrote a made-up name instead)
  assert.equal(fastTaskText('Write a short haiku about autumn leaves to autumn-haiku.md in the work folder.', 'C:\\w'),
    'Write a short haiku about autumn leaves to C:\\w\\autumn-haiku.md in the work folder.');
});
