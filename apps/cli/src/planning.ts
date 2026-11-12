import { randomUUID } from 'node:crypto';
import type {
  ChatClient,
  ConversationSnapshot,
  TranscriptEntry,
} from '../../../packages/shared/src/index.js';

export interface PlanSummary {
  id: string;
  title: string;
  execution: ConversationSnapshot['execution'];
  repository: string;
  ticket?: { title: string; revision: number; text: string };
  /** The planner has asked whether to create the issue and waits for a reply. */
  awaitingApproval: boolean;
  review?: { passed: boolean; open: string[] };
  issue?: { number: number; url: string; state: string };
  runId?: string;
  /** What the planner said since the last message from the person. */
  reply?: string;
}

const SECTIONS: [
  string,
  (
    | 'goal'
    | 'scope'
    | 'acceptanceCriteria'
    | 'validation'
    | 'outOfScope'
    | 'decisions'
    | 'files'
  ),
][] = [
  ['Goal', 'goal'],
  ['Scope', 'scope'],
  ['Acceptance criteria', 'acceptanceCriteria'],
  ['Validation', 'validation'],
  ['Out of scope', 'outOfScope'],
  ['Decisions', 'decisions'],
  ['Planned files', 'files'],
];

/** The planner's words after the last message from the person. */
export function replyOf(entries: TranscriptEntry[]) {
  const last = entries.findLastIndex((entry) => entry.kind === 'pi.user');
  return entries
    .slice(last + 1)
    .filter((entry) => entry.kind === 'pi.assistant' && entry.text.trim())
    .map((entry) => entry.text.trim())
    .join('\n\n');
}

export function summarizePlan(snapshot: ConversationSnapshot): PlanSummary {
  const { conversation, planning } = snapshot;
  const ticket = planning?.ticket;
  const operation = planning?.operation;
  const reply = replyOf(snapshot.entries);
  return {
    id: conversation.id,
    title: conversation.title,
    execution: snapshot.execution,
    repository: conversation.repository.github,
    ...(ticket
      ? {
          ticket: {
            title: ticket.title,
            revision: ticket.revision,
            text: SECTIONS.flatMap(([heading, key]) =>
              ticket[key]?.trim() ? [`${heading}\n${ticket[key]!.trim()}`] : [],
            ).join('\n\n'),
          },
        }
      : {}),
    awaitingApproval: Boolean(planning?.proposal && !planning.authorization),
    ...(planning?.review
      ? {
          review: {
            passed: planning.review.passed,
            open: planning.review.findings
              .filter((finding) => finding.kind !== 'nit')
              .map((finding) => finding.text),
          },
        }
      : {}),
    ...(operation?.issue
      ? { issue: { ...operation.issue, state: operation.state } }
      : operation
        ? { issue: { number: 0, url: '', state: operation.state } }
        : {}),
    ...(planning?.runId ? { runId: planning.runId } : {}),
    ...(reply ? { reply } : {}),
  };
}

export function planText(plan: PlanSummary) {
  return [
    `${plan.id}  ${plan.title}  (${plan.execution})`,
    plan.reply ? `\n${plan.reply}` : '',
    plan.ticket
      ? `\nTicket r${plan.ticket.revision}: ${plan.ticket.title}\n\n${plan.ticket.text}`
      : '',
    plan.review
      ? `\nReadiness review: ${plan.review.passed ? 'passed' : 'open findings'}${plan.review.open.map((text) => `\n  - ${text}`).join('')}`
      : '',
    plan.awaitingApproval
      ? `\nWaiting for approval. Reply yes, or run: factory plan approve ${plan.id}`
      : '',
    plan.issue
      ? `\nIssue ${plan.issue.number ? `#${plan.issue.number} ${plan.issue.url}` : ''} (${plan.issue.state})`
      : '',
    plan.runId ? `\nRun ${plan.runId}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Reads a conversation once, as the browser would on connecting. */
export function readSnapshot(chat: ChatClient, id: string, ms = 15000) {
  return new Promise<ConversationSnapshot>((resolve, reject) => {
    let stop = () => {};
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`No answer from conversation ${id}.`));
    }, ms);
    stop = chat.watch(
      id,
      (snapshot) => {
        clearTimeout(timer);
        stop();
        resolve(snapshot);
      },
      () => {},
      (error) => {
        clearTimeout(timer);
        stop();
        reject(error);
      },
    );
  });
}

const FINAL = ['completed', 'failed', 'interrupted', 'withdrawn'];

/** Sends a message and waits until the planner has finished answering it. */
export async function say(
  chat: ChatClient,
  id: string,
  text: string,
  seconds: number,
  pollMs = 500,
) {
  const requestId = randomUUID();
  await chat.submit(id, text, requestId);
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const submission = await chat.submission(id, requestId);
    if (FINAL.includes(submission.status)) {
      if (submission.status !== 'completed')
        throw new Error(
          `The message was ${submission.status}${submission.reason ? `: ${submission.reason}` : ''}.`,
        );
      break;
    }
    if (Date.now() > deadline)
      throw new Error(`The planner did not finish within ${seconds}s.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  // The reply is visible once the planner is idle again.
  for (;;) {
    const snapshot = await readSnapshot(chat, id);
    if (snapshot.execution === 'idle') return summarizePlan(snapshot);
    if (Date.now() > deadline)
      throw new Error(`The planner did not finish within ${seconds}s.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
