# Future workflow transition table

This is the implementation contract for later scheduler work, not a running scheduler. Pi tasks/documents remain the only durable source of workflow truth. One service owns storage and only one development run may hold the execution slot.

| Current state | Trigger / prerequisite | Next state and required action |
| --- | --- | --- |
| No run | Explicit start or ready-label admission | Queued; deduplicate by repository/issue identity and capture specification, models, execution configuration and base revision |
| Queued | Execution slot acquired | Developer; establish isolated workspace, setup and passing baseline before mutations |
| Developer | Developer stops; mutations confirmed quiescent | Checks; record intended source identity and effective configuration revision |
| Checks | Every required check passes for that identity/configuration | Reviewer; start an independent inspection-only conversation |
| Checks | Required validation fails; repair budget remains | Developer; consume the next repair cycle when repair work starts |
| Reviewer | Structured pass for the same source/configuration | Publication admission; require stopped mutations, no undelivered developer input, current base and matching evidence |
| Reviewer | Changes requested; repair budget remains | Developer; consume the next repair cycle when repair work starts |
| Checks / Reviewer | Initial attempt plus three repair cycles exhausted | Needs input; retain evidence and require explicit recorded continuation |
| Checks / Reviewer | Developer guidance, source change or explicit specification/configuration adoption | Return to Developer at a controlled boundary; invalidate affected evidence; retain repair count |
| Before publication | Base changed | Integrate changes and repeat validation before publication |
| Publication admission | All gates pass atomically | Publishing; reject new implementation input, verify committed tree, reconcile commit/push/PR operations by stored identity |
| Publishing | Push and one non-draft PR confirmed | PR ready; human merge only; implementation changes require explicit new run |
| Publishing | Ambiguous remote response | Remain pending reconciliation; never blindly repeat external creation |
| Any active stage | User pause, question, provider/auth failure or infrastructure blocker | Pausing; stop scheduling, interrupt/account for children, then Paused / Needs input only after quiescence |
| Any active stage | User cancels | Cancelling; stop future work/publication and propagate cancellation; then Cancelled only after quiescence and recording uncertain effects |
| Pausing / Cancelling | Child termination cannot be confirmed | Termination blocker; retain execution slot until inspection confirms no prior mutating work |
| Paused / Needs input | Valid answer/resume against expected revision | Queue for execution slot; resume existing attempt after reacquisition |
| Any unfinished stage | Service restart | Inspect/reconcile existing attempt before scheduling; preserve attempt identity and repair count; increment recovery count only |
| Completed / Cancelled | Explicit new-run instruction | Admit a new run; persistent labels and duplicate requests cannot restart it |

Commit outcomes before scheduling the next stage. A developer statement does not authorize a transition. User guidance, retries and recovery do not reset repair accounting; guidance accompanying a failed-check/reviewer repair still consumes its normal cycle. Setup changes require setup and baseline checks again. Publication-time source or configuration changes invalidate evidence rather than bypassing validation. Active external requests may finish after cancellation; record their outcome without claiming they were undone.
