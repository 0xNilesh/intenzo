// Coverage (ARCHITECTURE §18): the diff's files and routes for each criterion.
export { COVERAGE_MODEL, mapCoverage, type CoverageResult } from "./coverage.ts";
export { routeCandidates, routeOf } from "./routes.ts";
export {
  COVERAGE_JSON_SCHEMA,
  COVERAGE_SYSTEM,
  COVERAGE_V1,
  CoverageReply,
  DIFF_CHAR_CAP,
  renderCoverage,
} from "../prompts/coverage.v1.ts";
