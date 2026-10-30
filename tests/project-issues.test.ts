import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../packages/shared/src/index.js';
import { issuesFixture } from './fixtures/issues.js';
import { ticket } from './fixtures/planning.js';
import { until } from './fixtures/chat.js';

const conflict = (error: unknown) =>
  error instanceof ApiError && error.code === 'CONFLICT';

test('project issues are scoped, paginated, and omit bodies from the list', async () => {
  const fixture = await issuesFixture();
  try {
    const first = await fixture.chat().projectIssues();
    assert.deepEqual(
      first.issues.map((issue) => issue.title),
      ['Find saved work', 'Keep issue context after reconnecting'],
    );
    assert.equal(first.hasNext, true);
    assert.equal('body' in first.issues[0], false);
    assert.equal((await fixture.chat().projectIssues(2)).issues[0].number, 3);
    assert.equal(
      (await fixture.chat(fixture.beta.id).projectIssues()).issues[0].title,
      'Update the project dashboard',
    );
    await assert.rejects(
      fixture.chat().projectIssues(0),
      (error) => error instanceof ApiError && error.code === 'INVALID_INPUT',
    );
    fixture.github.repository('example/alpha').details.set(1, {
      title: 'Closed',
      updatedAt: 'closed',
      state: 'closed',
    });
    assert.ok(
      (await fixture.chat().projectIssues()).issues.every(
        (issue) => issue.number !== 1,
      ),
    );
    await assert.rejects(fixture.chat().planIssue(1, 'closed-issue'), conflict);
  } finally {
    await fixture.close();
  }
});

test('opening an issue edit session is durable and idempotent, without a model call or GitHub write', async () => {
  const fixture = await issuesFixture();
  try {
    const remote = fixture.github.repository('example/beta');
    const chat = fixture.chat(fixture.beta.id);
    const conversation = await chat.planIssue(1, 'edit-beta');
    assert.equal(conversation.projectId, fixture.beta.id);
    assert.equal(conversation.repository.github, 'example/beta');
    assert.match(conversation.title, /Edit #1/);
    assert.equal((await chat.planIssue(1, 'edit-beta')).id, conversation.id);
    assert.equal((await chat.conversations()).conversations.length, 1);
    const state = await fixture.service.planning.read(conversation.id);
    assert.equal(state?.sourceIssue?.title, 'Update the project dashboard');
    assert.equal(state?.operation, undefined);
    assert.equal(state?.authorization, undefined);
    assert.match(
      (await chat.history(conversation.id)).entries
        .map((entry) => entry.text)
        .join('\n'),
      /Update the project dashboard/,
    );
    assert.equal(remote.updates, 0);
    assert.equal(remote.calls, 1);
    await assert.rejects(fixture.chat().planIssue(1, 'edit-beta'), conflict);
    await fixture.restart();
    assert.equal(
      (await fixture.service.planning.read(conversation.id))?.sourceIssue
        ?.title,
      state?.sourceIssue?.title,
    );
    assert.match(
      (await fixture.chat(fixture.beta.id).history(conversation.id)).entries[0]
        .text,
      /Help me revise this issue/,
    );
  } finally {
    await fixture.close();
  }
});

test('issue revisions require approval and reconcile lost update responses without creating a duplicate', async () => {
  const fixture = await issuesFixture();
  try {
    const chat = fixture.chat();
    const conversation = await chat.planIssue(1, 'approved-edit');
    const remote = fixture.github.repository('example/alpha');
    await fixture.service.planning.save(
      conversation.id,
      { ...ticket, title: 'Revised search issue' },
      'save-revision',
    );
    await fixture.service.planning.propose(conversation.id);
    await assert.rejects(
      fixture.service.planning.create(conversation.id, undefined, true),
      conflict,
    );
    await assert.rejects(
      fixture.service.planning.create(conversation.id),
      conflict,
    );
    remote.mode = 'lost';
    await chat.submit(conversation.id, 'update it', 'approve-update');
    await until(
      () => chat.submission(conversation.id, 'approve-update'),
      (result) => result.status === 'completed',
    );
    assert.equal(
      (await fixture.service.planning.read(conversation.id))?.operation?.state,
      'uncertain',
    );
    assert.equal(remote.updates, 1);
    await fixture.restart();
    const recovered = await fixture.service.planning.retry(conversation.id);
    assert.equal(recovered.operation?.state, 'created');
    assert.equal(recovered.operation?.issue?.number, 1);
    assert.equal(remote.updates, 1);
    assert.equal(remote.calls, 3);
    assert.equal(
      (await fixture.github.getIssue('example/alpha', 1)).title,
      'Revised search issue',
    );
  } finally {
    await fixture.close();
  }
});

test('an externally edited issue blocks an approved update rather than overwriting newer content', async () => {
  const fixture = await issuesFixture();
  try {
    const chat = fixture.chat();
    const conversation = await chat.planIssue(1, 'stale-edit');
    await fixture.service.planning.save(conversation.id, ticket, 'revision');
    await fixture.service.planning.propose(conversation.id);
    const remote = fixture.github.repository('example/alpha');
    remote.issues[0].body = 'A newer edit on GitHub';
    await chat.submit(conversation.id, 'update it', 'approve-stale');
    await until(
      () => chat.submission(conversation.id, 'approve-stale'),
      (result) => result.status === 'completed',
    );
    assert.equal(
      (await fixture.service.planning.read(conversation.id))?.operation?.state,
      'blocked',
    );
    assert.equal(remote.updates, 0);
    assert.equal(remote.issues[0].body, 'A newer edit on GitHub');
  } finally {
    await fixture.close();
  }
});

test('starting a listed issue captures its project and reuses existing runs and receipts', async () => {
  const fixture = await issuesFixture();
  try {
    const client = fixture.workflow(fixture.beta.id);
    const first = await client.startIssue(1, 'issue-start');
    assert.equal(first.projectId, fixture.beta.id);
    assert.equal(first.repository.github, 'example/beta');
    assert.equal(first.specification.title, 'Update the project dashboard');
    assert.equal((await client.startIssue(1, 'issue-start')).id, first.id);
    assert.equal(
      (await client.startIssue(1, 'issue-start-again')).id,
      first.id,
    );
    await assert.rejects(
      fixture.workflow().startIssue(1, 'issue-start'),
      conflict,
    );
    await until(
      () => client.run(first.id),
      (run) => run.status === 'pr_ready',
    );
    const next = await client.newRun(first.id, 'new-issue-run');
    assert.notEqual(next.id, first.id);
    assert.equal(next.projectId, fixture.beta.id);
  } finally {
    await fixture.close();
  }
});

for (const mode of ['unknown', 'rejected'] as const) {
  test(`issue update retries preserve ${mode === 'unknown' ? 'uncertain' : 'definitively rejected'} outcomes`, async () => {
    const fixture = await issuesFixture();
    try {
      const chat = fixture.chat();
      const conversation = await chat.planIssue(1, `edit-${mode}`);
      await fixture.service.planning.save(
        conversation.id,
        ticket,
        `save-${mode}`,
      );
      await fixture.service.planning.propose(conversation.id);
      const remote = fixture.github.repository('example/alpha');
      remote.mode = mode;
      await chat.submit(conversation.id, 'update it', `approve-${mode}`);
      await until(
        () => chat.submission(conversation.id, `approve-${mode}`),
        (result) => result.status === 'completed',
      );
      assert.equal(remote.updates, 1);
      remote.mode = 'success';
      const result = await fixture.service.planning.retry(conversation.id);
      assert.equal(
        result.operation?.state,
        mode === 'unknown' ? 'uncertain' : 'created',
      );
      assert.equal(remote.updates, mode === 'unknown' ? 1 : 2);
      assert.equal(remote.calls, 3);
    } finally {
      await fixture.close();
    }
  });
}

test('a request to create something does not approve updating an existing issue', async () => {
  const fixture = await issuesFixture();
  try {
    const chat = fixture.chat();
    const conversation = await chat.planIssue(1, 'edit-intent');
    await fixture.service.planning.save(conversation.id, ticket, 'save-intent');
    await fixture.service.planning.propose(conversation.id);
    await chat.submit(conversation.id, 'create it', 'different-intent');
    await until(
      () => chat.submission(conversation.id, 'different-intent'),
      (result) => result.status === 'completed',
    );
    const state = await fixture.service.planning.read(conversation.id);
    assert.equal(state?.authorization, undefined);
    assert.equal(state?.operation, undefined);
    assert.equal(fixture.github.repository('example/alpha').updates, 0);
    await assert.rejects(
      fixture.service.planning.create(conversation.id, undefined, true),
      conflict,
    );
  } finally {
    await fixture.close();
  }
});
