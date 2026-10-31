import { describe, expect, it } from "vitest";

import { ArtifactRef, takePath } from "./artifact.ts";

const RUN = "ea44d35d-4baa-4f81-ac92-08285fae4058";

describe("takePath (§28)", () => {
  it("puts each take of each side in its own folder under the run", () => {
    expect(takePath(RUN, "C2", "pr", 1, "human.mp4")).toBe(`runs/${RUN}/C2/pr/take-1/human.mp4`);
    expect(takePath(RUN, "C2", "pr", 2, "human.mp4")).toBe(`runs/${RUN}/C2/pr/take-2/human.mp4`);
    expect(takePath(RUN, "C2", "base", 1, "human.mp4")).not.toBe(
      takePath(RUN, "C2", "pr", 1, "human.mp4"),
    );
  });

  it.each([0, -1, 1.5])("refuses take %s", (take) => {
    expect(() => takePath(RUN, "C2", "pr", take, "human.mp4")).toThrow(/take must be/);
  });

  it.each(["../x.mp4", "a/b.mp4", ""])("refuses the file name %j", (file) => {
    expect(() => takePath(RUN, "C2", "pr", 1, file)).toThrow(/plain file name/);
  });

  it("makes paths ArtifactRef accepts", () => {
    const path = takePath(RUN, "C2", "pr", 1, "human.mp4");
    expect(ArtifactRef.parse({ store: "private", path, contentType: "video/mp4" }).path).toBe(path);
  });
});
