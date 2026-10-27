import { test } from 'node:test';
import { request, type IncomingMessage } from 'node:http';
import assert from 'node:assert/strict';
import { workflowFixture } from './fixtures/workflow.js';
import { lastEventId } from '../apps/server/src/sse.js';

interface Message {
  id?: string;
  event?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
}

/** Opens a stream the way a reconnecting client would. */
function open(base: string, path: string, resume?: string) {
  const messages: Message[] = [];
  const waiting: (() => void)[] = [];
  let response: IncomingMessage | undefined;
  let buffer = '';
  const req = request(
    `${base}${path}`,
    { headers: resume === undefined ? {} : { 'Last-Event-ID': resume } },
    (res) => {
      response = res;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
        for (
          let end = buffer.indexOf('\n\n');
          end >= 0;
          end = buffer.indexOf('\n\n')
        ) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const message: Message = {};
          for (const line of block.split('\n')) {
            if (line.startsWith('id: ')) message.id = line.slice(4);
            else if (line.startsWith('event: ')) message.event = line.slice(7);
            else if (line.startsWith('data: '))
              message.data = JSON.parse(line.slice(6));
          }
          if (message.data !== undefined && message.event !== 'heartbeat')
            messages.push(message);
        }
        for (const wake of waiting.splice(0)) wake();
      });
    },
  );
  req.on('error', () => undefined);
  req.end();
  return {
    /** The next frame, or undefined if none arrives in time. */
    async next(timeout: number) {
      const deadline = Date.now() + timeout;
      while (!messages.length && Date.now() < deadline)
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 25);
        });
      return messages.shift();
    },
    close() {
      response?.destroy();
      req.destroy();
    },
  };
}

test('the Last-Event-ID header is read as given, and ignored when empty or oversized', () => {
  const read = (value: string | undefined) =>
    lastEventId({ headers: { 'last-event-id': value } } as never);
  assert.equal(read('42'), '42');
  assert.equal(read(''), undefined);
  assert.equal(read(undefined), undefined);
  assert.equal(read('x'.repeat(129)), undefined);
});

test('the workflow stream labels frames with the revision and skips a snapshot the client already holds', async () => {
  const s = await workflowFixture();
  try {
    const fresh = open(s.service.url, '/api/v1/runs/events');
    const first = await fresh.next(3000);
    fresh.close();
    assert.equal(first?.data.type, 'snapshot');
    assert.equal(first?.data.sequence, 1);
    assert.equal(first?.id, String(first?.data.snapshot.revision));

    const resumed = open(s.service.url, '/api/v1/runs/events', first!.id);
    assert.equal(await resumed.next(500), undefined, 'nothing has changed');
    const conversation = await s.issue();
    await s.client.startRun(conversation, 'resume-run');
    const change = await resumed.next(5000);
    resumed.close();
    assert.equal(change?.data.type, 'snapshot', 'the next frame stands alone');
    assert.equal(change?.data.sequence, 1);
    assert.ok(Number(change?.id) > Number(first?.id));
    assert.equal(change?.id, String(change?.data.snapshot.revision));

    // The simulated run keeps advancing, so the live revision is at least this.
    const current = Number(change?.id);
    const ahead = String(current + 1000);
    for (const held of [String(current - 1), ahead, 'abc', '']) {
      const stale = open(s.service.url, '/api/v1/runs/events', held);
      const frame = await stale.next(3000);
      stale.close();
      assert.equal(frame?.data.type, 'snapshot', `resume from "${held}"`);
      assert.equal(frame?.data.sequence, 1, `resume from "${held}"`);
      assert.ok(frame?.data.snapshot.revision >= current, `from "${held}"`);
    }
  } finally {
    await s.close();
  }
});

test('activity and conversation streams skip a snapshot only when the client holds exactly that state', async () => {
  const s = await workflowFixture();
  try {
    const conversation = await s.issue();
    const run = await s.client.startRun(conversation, 'resume-streams');
    for (const path of [
      `/api/v1/runs/${run.id}/activity/events`,
      `/api/v1/conversations/${conversation}/events`,
    ]) {
      const fresh = open(s.service.url, path);
      const first = await fresh.next(3000);
      fresh.close();
      assert.equal(first?.data.type, 'snapshot', path);
      assert.ok(first?.id && first.id.length > 10, `${path} has an id`);

      const resumed = open(s.service.url, path, first!.id);
      const next = await resumed.next(1200);
      resumed.close();
      // Background work may change the state, but the held state is never re-sent.
      if (next) {
        assert.notEqual(next.id, first!.id, `${path} re-sent held state`);
        assert.equal(next.data.type, 'snapshot', path);
        assert.equal(next.data.sequence, 1, path);
      }

      const stale = open(s.service.url, path, 'not-the-current-version');
      const frame = await stale.next(3000);
      stale.close();
      assert.equal(frame?.data.type, 'snapshot', path);
      assert.equal(frame?.data.sequence, 1, path);
    }
  } finally {
    await s.close();
  }
});

test('a conversation stream resumed at the current state delivers the next change as a snapshot', async () => {
  const s = await workflowFixture();
  try {
    const conversation = await s.issue();
    const path = `/api/v1/conversations/${conversation}/events`;
    const fresh = open(s.service.url, path);
    const first = await fresh.next(3000);
    fresh.close();
    const resumed = open(s.service.url, path, first!.id);
    await s.chat.submit(conversation, 'one more thing', 'resume-change');
    let frame = await resumed.next(5000);
    while (frame && frame.id === first!.id) frame = await resumed.next(5000);
    resumed.close();
    assert.ok(frame, 'the change arrived');
    assert.equal(frame.data.type, 'snapshot');
    assert.equal(frame.data.sequence, 1);
    assert.notEqual(frame.id, first!.id);
  } finally {
    await s.close();
  }
});

test('AG-UI streams are unchanged: no ids, and the snapshot is always sent', async () => {
  const s = await workflowFixture();
  try {
    const conversation = await s.issue();
    const stream = open(
      s.service.url,
      `/api/v1/conversations/${conversation}/ag-ui/events`,
      'anything',
    );
    const first = await stream.next(3000);
    stream.close();
    assert.ok(first, 'the snapshot is sent');
    assert.equal(first.id, undefined);
  } finally {
    await s.close();
  }
});
