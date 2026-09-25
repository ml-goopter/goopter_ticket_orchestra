import { note } from "./note.js";
import { proposeSpec } from "./propose_spec.js";
import { raiseIssue } from "./raise_issue.js";
import { reportComplete } from "./report_complete.js";
import { reportFailed } from "./report_failed.js";
import { reportPrCreated } from "./report_pr_created.js";
import { reportReviewResult } from "./report_review_result.js";
import { reportReviewStarted } from "./report_review_started.js";
import { reportUsage } from "./report_usage.js";

/**
 * The eight tools of design.md §8, in the order of its table, with
 * `report_usage` (§9.7) after the review tools it serves.
 */
export const TOOL_DEFINITIONS = [
  raiseIssue,
  reportReviewStarted,
  reportReviewResult,
  reportUsage,
  reportPrCreated,
  reportComplete,
  reportFailed,
  proposeSpec,
  note,
] as const;
