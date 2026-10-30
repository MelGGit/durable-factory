import React, { useState } from 'react';
import {
  acceptsTypedAnswer,
  type Intervention,
  type WorkflowRun,
} from '../../../packages/shared/src/index.js';
import { useRunCommand } from './hooks/use-run-command.js';
import { markdown } from './markdown.js';

export function RunQuestion({
  run,
  question,
  onRun,
}: {
  run: WorkflowRun;
  question: Intervention;
  onRun: (run: WorkflowRun) => void;
}) {
  const key = `factory.runAnswer.${run.id}.${question.id}`;
  const { error, busy, act } = useRunCommand(run, onRun, key);
  const [answer, setAnswer] = useState(() => {
    try {
      return localStorage.getItem(`${key}.draft`) ?? '';
    } catch {
      return '';
    }
  });
  const waiting = ['paused', 'needs_input'].includes(run.status);
  const canAnswer = acceptsTypedAnswer(question);
  const attempt = run.attempts.find(
    (attempt) => attempt.id === question.attemptId,
  );
  const author =
    question.reason === 'developer'
      ? 'Developer agent'
      : question.reason === 'reviewer'
        ? 'Review agent'
        : 'Workflow';
  return (
    <article
      className="message assistant-message run-question"
      aria-label="Implementation question"
      data-question-id={question.id}
      data-conversation-item={`timeline:question-${question.id}`}
    >
      <div className="message-author">
        {author}
        {question.createdAt !== undefined && (
          <time dateTime={new Date(question.createdAt).toISOString()}>
            {new Date(question.createdAt).toLocaleTimeString()}
          </time>
        )}
      </div>
      <div
        className="message-text markdown"
        dangerouslySetInnerHTML={{ __html: markdown(question.question) }}
      />
      {question.state === 'resolved' ? (
        <p className="run-detail-note">Answered</p>
      ) : canAnswer ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!answer.trim() || busy || !waiting) return;
            void act('answer', {
              interventionId: question.id,
              interventionRevision: question.revision,
              answer,
            }).then((saved) => {
              if (saved) {
                try {
                  localStorage.removeItem(`${key}.draft`);
                } catch {
                  /* The durable reply is already saved. */
                }
              }
            });
          }}
        >
          <label htmlFor={`answer-${question.id}`}>Answer</label>
          <textarea
            id={`answer-${question.id}`}
            value={answer}
            onChange={(event) => {
              setAnswer(event.target.value);
              try {
                localStorage.setItem(`${key}.draft`, event.target.value);
              } catch {
                /* Keep the in-memory draft. */
              }
            }}
            required
            maxLength={16000}
            rows={3}
            disabled={busy || !waiting}
            placeholder={
              attempt?.stage === 'reviewer'
                ? 'Clarify the review question…'
                : 'Reply to continue the implementation…'
            }
          />
          <button
            type="submit"
            className="primary"
            disabled={busy || !waiting || !answer.trim()}
          >
            {busy ? 'Submitting…' : 'Answer and resume'}
          </button>
        </form>
      ) : (
        <div className="run-question-actions">
          {question.reason === 'repair_exhausted' && (
            <button
              type="button"
              className="primary"
              disabled={busy || !waiting}
              onClick={() => void act('continue')}
            >
              Authorize one additional repair
            </button>
          )}
          {['termination', 'uncertain', 'publication'].includes(
            question.reason,
          ) && (
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                (!['needs_input', 'termination_blocker'].includes(run.status) &&
                  !(
                    run.status === 'paused' &&
                    run.stage === 'publishing' &&
                    run.publication
                  ))
              }
              onClick={() => void act('reconcile')}
            >
              Reconcile run
            </button>
          )}
          {question.reason === 'specification_contract' && (
            <button
              type="button"
              className="secondary"
              disabled={busy || !waiting}
              onClick={() => void act('adopt_specification')}
            >
              Adopt saved specification
            </button>
          )}
          {question.reason === 'adapter' && (
            <a href={`/projects/${encodeURIComponent(run.projectId)}/settings`}>
              Open project settings
            </a>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </article>
  );
}

/** Adopting an issue requires an explicit request to resume, also available in chat. */
export function RunResumePrompt({
  run,
  onRun,
}: {
  run: WorkflowRun;
  onRun: (run: WorkflowRun) => void;
}) {
  const { error, busy, act } = useRunCommand(
    run,
    onRun,
    `factory.runResume.${run.id}`,
  );
  if (
    !['paused', 'needs_input'].includes(run.status) ||
    run.interventions.some((question) => question.state === 'pending') ||
    run.decisions.at(-1)?.action !== 'adopt_specification'
  )
    return null;
  return (
    <article
      className="message assistant-message run-question"
      aria-label="Resume implementation"
      data-conversation-item={`resume:${run.id}:${run.specificationRevision}`}
    >
      <div className="message-author">Workflow</div>
      <p>
        The updated specification is ready. Resume the implementation when
        you’re ready.
      </p>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => void act('resume')}
      >
        Resume run
      </button>
      {error && <p role="alert">{error}</p>}
    </article>
  );
}
