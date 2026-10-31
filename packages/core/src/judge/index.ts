// Judging (ARCHITECTURE §22): the bundle both judges get, and the rules that combine them.
export { judgeBundle, renderJudgeText, type JudgeBundle, type JudgeSide } from "./bundle.ts";
export {
  afterRerecord,
  capVerdict,
  checkJudge,
  combine,
  numbersIn,
  preJudge,
  rerecordFor,
  valueMatches,
  type Checked,
  type Combined,
} from "./rules.ts";
export {
  BASE_VIDEO_HEADING,
  JUDGE_JSON_SCHEMA,
  JUDGE_SYSTEM,
  JUDGE_V1,
  JudgeReply,
  PR_VIDEO_HEADING,
  SCREENSHOT_QUESTION,
} from "../prompts/judge.v1.ts";
