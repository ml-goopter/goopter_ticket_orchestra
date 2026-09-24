# Agent Orchestrator — System Specification
## 1. Purpose
The Agent Orchestrator is a control plane for turning Jira tickets into reviewed software changes.
The required workflow is:
```javascript
Jira Ticket
    ↓
Orchestration UI
    ↓
Specification Builder
    ↓
Human-approved specification
    ↓
Automatic task assignment
    ↓
Implementation Agent
    ↓
Validation / Review Agent
    ↓
Ready for Merge

```
At any stage, an agent may surface an issue back to a user:
```javascript
Agent
  ↓
Issue / Question
  ↓
User
  ↓
Resolution
  ↓
Agent resumes

```
The orchestrator manages workflow and state. It does not perform software-engineering reasoning itself.
---
# 2. Core Principles
## 2.1 Jira is the source of incoming work
Tickets originate in Jira.
A Jira ticket does not automatically become executable.
A ticket first enters the orchestrator as:
```javascript
NEEDS_SPEC

```
---
## 2.2 Every executable task requires an approved specification
The fundamental execution gate is:
```javascript
Jira Ticket
    ↓
Draft Specification
    ↓
APPROVED SPECIFICATION
    ↓
Eligible for Assignment

```
No implementation agent may receive a task without an approved specification.
---
## 2.3 Specification building is part of the orchestrator UI
The orchestration application provides a UI where users can work with an LLM to convert a Jira ticket into an implementation-ready specification.
The specification process is interactive.
The LLM may:
- read the Jira ticket
- read ticket comments
- inspect the relevant repository
- inspect existing implementation patterns
- identify ambiguity
- suggest scope
- suggest acceptance criteria
- suggest validation steps
- identify dependencies
- identify risks
- ask the user questions
The LLM produces a draft.
Only a human can approve the specification.
---
## 2.4 Agents may escalate to humans
Implementation and review agents must have a structured mechanism for raising questions, blockers, ambiguities, and decisions.
Agents should not be forced to guess when the correct solution requires product or human input.
---
## 2.5 Tickets are durable; executions are disposable
A ticket may have many agent executions.
```javascript
GOOP-421
   │
   ├── implementation execution #1
   ├── review execution #1
   ├── implementation execution #2
   └── review execution #2

```
The ticket remains the durable workflow object.
Agent sessions may fail, restart, or be replaced.
---
## 2.6 The orchestrator is deterministic
The orchestrator handles:
```javascript
assignment
locking
state transitions
dependencies
retries
capacity
agent lifecycle
human escalation

```
Agents handle:
```javascript
reasoning
coding
testing
review
git
PR creation
investigation

```
---
# 3. High-Level Architecture
```javascript
                         Jira
                           │
                           ▼
                ┌─────────────────────┐
                │   Orchestrator UI   │
                │                     │
                │ tickets             │
                │ specifications      │
                │ issues/questions    │
                │ execution status    │
                └──────────┬──────────┘
                           │
                  Specification Builder
                           │
                     User ↔ Spec LLM
                           │
                           ▼
                   Approved Spec
                           │
                           ▼
                ┌─────────────────────┐
                │    Orchestrator     │
                │                     │
                │ scheduler           │
                │ task claiming       │
                │ agent lifecycle     │
                │ retries             │
                │ dependencies        │
                │ issue routing       │
                └──────────┬──────────┘
                           │
                     Agent Adapter
                           │
             ┌─────────────┴─────────────┐
             ▼                           ▼
      Implementation Agent          Review Agent
             │                           │
             └─────────────┬─────────────┘
                           │
                           ▼
                      GitHub / CI

```
---
# 4. Primary Workflow
## Phase 1 — Jira Ticket
A Jira ticket enters the orchestration system.
Example:
```javascript
GOOP-421

Allow receipt language to be selected per POS device.

```
Initial internal state:
```javascript
NEEDS_SPEC

```
---
# 5. Phase 2 — Specification Builder
The user opens the ticket in the orchestration UI.
Suggested interface:
```javascript
┌───────────────────────────────────────────────────────────────┐
│ GOOP-421 — Receipt Language                                   │
├──────────────────────────┬────────────────────────────────────┤
│ Spec Agent               │ Specification                      │
│                          │                                    │
│ User ↔ LLM               │ Objective                          │
│                          │ Scope                              │
│                          │ Out of Scope                       │
│                          │ Requirements                       │
│                          │ Acceptance Criteria                │
│                          │ Validation                         │
│                          │ Constraints                        │
│                          │ Dependencies                       │
├──────────────────────────┴────────────────────────────────────┤
│       Save Draft        Request Review        Approve Spec    │
└───────────────────────────────────────────────────────────────┘

```
---
# 6. Specification Structure
Specifications should be stored as structured data.
Example:
```javascript
ticket: GOOP-421

repository: goopter_odoo_modules

objective:
  Allow each POS device to select the language used for
  customer receipts.

scope:
  - POS device configuration
  - receipt rendering
  - persistence of selected language

out_of_scope:
  - backend report language
  - customer account language

requirements:
  - each POS device may have its own receipt language
  - selection persists across reloads
  - English remains the default
  - existing installations remain compatible

acceptance_criteria:
  - user can select receipt language
  - setting persists after reload
  - receipt renders in selected language
  - existing receipt behavior remains unchanged by default

validation:
  - backend tests pass
  - relevant HOOT tests pass

constraints:
  - do not modify Odoo core

```
The implementation and review agents receive the exact same approved specification.
---
# 7. Specification States
```javascript
NEEDS_SPEC
    ↓
SPEC_IN_PROGRESS
    ↓
SPEC_REVIEW
    ↓
SPEC_APPROVED

```
Only:
```javascript
SPEC_APPROVED

```
may transition into:
```javascript
READY

```
---
# 8. Human Approval Gate
Specification approval is explicit.
The UI should clearly identify:
```javascript
Draft
Approved
Superseded

```
An approved specification should be immutable for that execution cycle.
If requirements change after approval, create a new specification revision.
Example:
```javascript
Spec v1 — approved
Spec v2 — draft
Spec v2 — approved

```
Every execution records which specification revision it used.
---
# 9. Scheduler
Once a specification is approved:
```javascript
SPEC_APPROVED
      ↓
READY
      ↓
scheduler claims task
      ↓
ASSIGNED

```
The scheduler selects tasks based on deterministic criteria such as:
1. dependency readiness
2. priority
3. repository capacity
4. age
---
# 10. Duplicate Prevention
Task assignment must be atomic.
Only one active implementation execution may own a task unless explicitly configured otherwise.
Example database operation:
```javascript
SELECT id
FROM tasks
WHERE state = 'READY'
FOR UPDATE SKIP LOCKED
LIMIT 1;

```
The orchestrator creates a task lease when assignment succeeds.
---
# 11. Agent Execution
The implementation agent receives:
```javascript
Jira ticket

approved specification

repository

base branch

existing relevant context

execution instructions

```
The agent is responsible for:
- investigating the codebase
- implementing changes
- writing/updating tests
- running validation
- committing changes
- pushing a branch
- opening a PR
- responding to review feedback
---
# 12. Agent Adapter
Agent systems must sit behind a common interface.
Conceptually:
```javascript
start_execution(
    task,
    specification,
    repository,
    role,
    context
)

get_status(execution)

send_message(execution, message)

cancel(execution)

get_result(execution)

```
Adapters may support:
```javascript
Claude Code
Codex
FirstMate
OpenCode
future agent systems

```
---
# 13. Agent Issue Escalation
Agents require a first-class way to raise issues to users.
This is not equivalent to execution failure.
An agent may encounter a situation such as:
- ambiguous product behavior
- two valid architecture choices
- missing credentials
- missing external information
- contradictory requirements
- destructive migration
- unclear acceptance criteria
- unexpected existing behavior
- dependency on another team
- decision requiring business input
Instead of guessing, the agent creates an **Issue**.
---
# 14. Issue Object
Issues should be structured records.
Example:
```javascript
id: issue_784

task: GOOP-421

execution: exec_456

type: decision_required

severity: blocking

title:
  Receipt language ownership is ambiguous

description:
  The existing POS configuration is shared across devices,
  while the specification requires device-specific behavior.

question:
  Should the setting be stored locally per browser/device
  or persisted server-side against a registered device?

options:
  - id: local
    description: Store the setting on the POS device.
    tradeoff: Does not synchronize between browsers.

  - id: server
    description: Introduce a device record in Odoo.
    tradeoff: Requires additional backend architecture.

recommended_option:
  local

status: OPEN

```
The agent may provide a recommendation, but the user makes the decision.
---
# 15. Issue Types
Initial issue types should include:
```javascript
QUESTION

DECISION_REQUIRED

BLOCKER

SPEC_AMBIGUITY

MISSING_INFORMATION

MISSING_ACCESS

UNEXPECTED_BEHAVIOR

SCOPE_CONFLICT

DEPENDENCY

RISK

VALIDATION_FAILURE

```
---
# 16. Blocking vs Non-Blocking Issues
Issues have two categories.
## Blocking
The agent cannot safely continue.
```javascript
execution
    ↓
WAITING_FOR_USER

```
Examples:
- requirement ambiguity
- missing credential
- destructive operation requiring approval
- architecture decision
---
## Non-Blocking
The agent can continue but wants the user informed.
Examples:
- discovered technical debt
- unrelated bug
- possible future improvement
- degraded test coverage
The task continues normally.
---
# 17. Issue Workflow
Blocking issue:
```javascript
Agent running
    ↓
Issue raised
    ↓
WAITING_FOR_USER
    ↓
User notified
    ↓
User opens issue
    ↓
User responds
    ↓
Issue RESOLVED
    ↓
response sent to agent
    ↓
Agent resumes

```
The task should not be restarted unnecessarily.
Whenever supported by the agent runtime, the same execution/session should resume.
---
# 18. Issue UI
The orchestration dashboard should prominently surface unresolved issues.
Example:
```javascript
┌──────────────────────────────────────────────────────────────┐
│ Needs Your Attention                                         │
├───────────┬────────────────────────────┬─────────────────────┤
│ Ticket    │ Issue                      │ Waiting             │
├───────────┼────────────────────────────┼─────────────────────┤
│ GOOP-421  │ Device persistence choice │ 14 min              │
│ GOOP-447  │ Missing Stripe test key    │ 32 min              │
└───────────┴────────────────────────────┴─────────────────────┘

```
Opening an issue should show:
```javascript
Agent explanation

relevant context

question

suggested options

agent recommendation

free-form response box

Resolve / Send Response

```
---
# 19. Conversation Around Issues
Users should be able to have a short conversation with the execution agent if necessary.
Example:
```javascript
Agent:
The existing model does not distinguish POS devices.
Should this setting be browser-local or server-persisted?

User:
Browser-local is fine. It only needs to persist on that iPad.

Agent:
Understood. Should reinstalling the app reset the value?

User:
Yes.

[Resolve Issue]

```
The resulting decision should be preserved in the task's durable context.
---
# 20. Decision Memory
Responses to issues become part of the task execution context.
Example:
```javascript
decisions:

  - issue: issue_784

    decision:
      Receipt language is device-local.

    clarification:
      Persistence across app reinstall is not required.

    decided_by: user_123

    decided_at: ...

```
Implementation agents and reviewers must see these decisions.
The original approved spec remains unchanged, but the execution has an explicit **clarification record**.
If a clarification materially changes scope, the system should require a specification revision instead.
---
# 21. Spec Change Detection
An issue response may produce one of two outcomes.
### Clarification
No change to intended requirements.
```javascript
issue resolved
    ↓
agent resumes

```
### Requirement change
Changes the approved contract.
```javascript
issue
  ↓
user changes requirement
  ↓
SPEC_REVISION_REQUIRED
  ↓
new draft specification
  ↓
human approval
  ↓
agent resumes using new spec revision

```
The orchestrator should explicitly distinguish these cases.
---
# 22. Notifications
Blocking agent issues should trigger notifications.
Potential channels:
```javascript
Orchestrator UI

email

Slack

Jira comment

browser notification

```
The initial MVP only requires an in-app notification system.
External channels may be added later.
---
# 23. Main Task State Machine
```javascript
NEEDS_SPEC
    ↓
SPEC_IN_PROGRESS
    ↓
SPEC_REVIEW
    ↓
SPEC_APPROVED
    ↓
READY
    ↓
ASSIGNED
    ↓
IMPLEMENTING
    │
    ├──── blocking issue ───→ WAITING_FOR_USER
    │                              │
    │                              └──→ IMPLEMENTING
    │
    ▼
IMPLEMENTATION_COMPLETE
    ↓
CI_RUNNING
    ↓
REVIEWING
    │
    ├──── blocking issue ───→ WAITING_FOR_USER
    │                              │
    │                              └──→ REVIEWING
    │
    ├──── changes requested ─→ IMPLEMENTING
    │
    ▼
APPROVED
    ↓
READY_FOR_MERGE
    ↓
DONE

```
Exceptional states:
```javascript
BLOCKED
FAILED
CANCELLED
NEEDS_HUMAN

```
`WAITING_FOR_USER` is different from `NEEDS_HUMAN`.
`WAITING_FOR_USER` means:
> There is a specific actionable question that can allow execution to resume.
`NEEDS_HUMAN` means:
> Automated execution has stopped and requires manual intervention.
---
# 24. Review Workflow
The reviewer receives:
- Jira ticket
- approved specification
- specification revision
- clarifications/decisions
- implementation branch
- PR
- test results
The review agent verifies implementation against the approved contract.
Review results:
```javascript
APPROVED

CHANGES_REQUESTED

ISSUE_RAISED

```
If changes are requested:
```javascript
REVIEWING
    ↓
CHANGES_REQUESTED
    ↓
IMPLEMENTING
    ↓
CI
    ↓
REVIEWING

```
---
# 25. Task Dashboard
The main UI should make human intervention obvious.
Suggested views:
```javascript
Needs Spec

Spec In Progress

Awaiting Spec Approval

Ready

Implementing

Waiting for You

Reviewing

Ready for Merge

Needs Human

Done

```
Example:
```javascript
┌──────────────────────────────────────────────────────────────────────────┐
│ Agent Orchestrator                                                       │
├────────────┬────────────┬───────────────┬──────────────┬────────────────┤
│ Needs Spec │ Ready      │ Running       │ Waiting User │ Review         │
├────────────┼────────────┼───────────────┼──────────────┼────────────────┤
│ GOOP-451   │ GOOP-421   │ GOOP-430      │ GOOP-418     │ GOOP-401       │
│ GOOP-452   │ GOOP-422   │ GOOP-441      │ GOOP-420     │                │
└────────────┴────────────┴───────────────┴──────────────┴────────────────┘

```
---
# 26. Task Detail Page
Each ticket should provide a single chronological view containing:
```javascript
Jira ticket

specification

spec revisions

user approvals

execution history

agent currently assigned

agent logs

agent-raised issues

user responses

recorded decisions

branch

PR

CI

review findings

retries

final result

```
This becomes the audit trail for the entire autonomous-development lifecycle.
---
# 27. Agent Results
Agents should communicate through structured events rather than requiring the orchestrator to parse natural language.
Example events:
```javascript
execution.started

execution.heartbeat

implementation.completed

pull_request.created

ci.started

ci.failed

ci.passed

review.started

review.changes_requested

review.approved

issue.created

issue.resolved

execution.failed

execution.completed

```
---
# 28. Dependencies
Tickets may depend on one another.
```javascript
GOOP-100
    ↓
GOOP-101
    ↓
GOOP-102

```
Only tickets whose dependencies are satisfied may enter `READY`.
---
# 29. Retries
Infrastructure failures should retry automatically.
Examples:
```javascript
agent runtime crashed
network failure
worker unavailable
temporary API error

```
Business or specification uncertainty must **not** be treated as infrastructure failure.
Those become agent issues instead.
This distinction is important:
```javascript
machine crashed
    → retry

agent doesn't know what user wants
    → ask user

agent discovers requirement conflict
    → ask user / revise spec

agent cannot solve problem after repeated attempts
    → NEEDS_HUMAN

```
---
# 30. MVP Database Entities
The initial system should contain:
```javascript
projects

repositories

tasks

specifications

specification_revisions

specification_approvals

task_dependencies

executions

task_leases

agent_workers

issues

issue_messages

task_decisions

pull_requests

review_results

execution_events

audit_events

```
---
# 31. Issue Schema
Suggested fields:
```javascript
issues

id
task_id
execution_id
type
severity
blocking
title
description
question
suggested_options_json
recommended_option
status
created_at
resolved_at
resolved_by
resolution

```
---
# 32. MVP User Journey
The complete first-version workflow should be:
```javascript
1. User creates Jira ticket.

2. Ticket appears in Orchestrator as NEEDS_SPEC.

3. User opens ticket.

4. User collaborates with Spec LLM.

5. Structured specification is generated.

6. User reviews specification.

7. User explicitly approves specification.

8. Ticket becomes READY.

9. Scheduler automatically claims ticket.

10. Implementation agent starts.

11. Agent implements and validates change.

12. If agent needs input:
        create issue
        notify user
        pause execution
        receive answer
        resume execution

13. Agent creates PR.

14. CI runs.

15. Independent review agent starts.

16. Reviewer either:
        approves,
        requests changes,
        or raises a user issue.

17. Requested changes go back to implementation.

18. Approved ticket becomes READY_FOR_MERGE.

19. Human merges PR.

20. Ticket becomes DONE.

```
---
# 33. Core Architectural Boundary
The responsibilities should remain:
```javascript
JIRA
defines incoming work

SPEC BUILDER
defines exactly what should be built

HUMAN
approves requirements and resolves decisions

ORCHESTRATOR
decides who works on what and when

IMPLEMENTATION AGENT
figures out how to build it

REVIEW AGENT
determines whether the implementation satisfies the contract

GITHUB / CI
stores and validates the resulting code

```
The orchestrator's job is therefore not simply:
```javascript
ticket → agent

```
It is:
```javascript
ticket
  ↓
human + LLM specification
  ↓
human approval
  ↓
safe automated assignment
  ↓
agent execution
  ↕
human escalation
  ↓
independent validation
  ↓
completed engineering work

```
# 34. Definition of Success
The platform succeeds when a user can create a Jira ticket, turn it into an approved specification through the orchestrator UI, and then allow the system to autonomously execute the work.
The user should only need to return when:
- the specification requires approval,
- an agent raises a meaningful question,
- execution genuinely requires intervention,
- or a completed PR is ready for merge.
Agents should never silently invent product decisions simply because no mechanism exists to ask the user.