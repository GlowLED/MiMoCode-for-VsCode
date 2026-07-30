import { describe, expect, it } from "vitest";
import { encodedDirectoryHeader, isLoopbackServiceUrl, isPathInsideRoot, SseFrameDecoder } from "../../src/runtime/network";

describe("MiMoCode runtime boundary", () => {
  it("accepts only bare HTTP loopback service URLs", () => {
    expect(isLoopbackServiceUrl("http://127.0.0.1:4123")).toBe(true);
    expect(isLoopbackServiceUrl("http://localhost:4123/api")).toBe(true);
    expect(isLoopbackServiceUrl("http://[::1]:4123")).toBe(true);
    expect(isLoopbackServiceUrl("https://127.0.0.1:4123")).toBe(false);
    expect(isLoopbackServiceUrl("http://192.168.1.4:4123")).toBe(false);
    expect(isLoopbackServiceUrl("http://user@127.0.0.1:4123")).toBe(false);
    expect(isLoopbackServiceUrl("http://localhost")).toBe(false);
  });

  it("encodes the directory header and rejects path traversal", () => {
    expect(encodedDirectoryHeader("/work/my project")).toBe("%2Fwork%2Fmy%20project");
    expect(isPathInsideRoot("/work/project", "/work/project/src/app.ts")).toBe(true);
    expect(isPathInsideRoot("/work/project", "/work/project")).toBe(true);
    expect(isPathInsideRoot("/work/project", "/work/private.txt")).toBe(false);
  });
});

describe("SseFrameDecoder", () => {
  it("combines fragmented multi-line SSE data frames", () => {
    const decoder = new SseFrameDecoder();
    expect(decoder.push(`event: message
data: {"part`)).toEqual([]);
    expect(decoder.push(`":"one"}
data: {"part":"two"}

`)).toEqual([
      '{"part":"one"}\n{"part":"two"}'
    ]);
  });

  it("does not lose a final un-delimited data line", () => {
    const decoder = new SseFrameDecoder();
    decoder.push("data: final");
    expect(decoder.finish()).toEqual(["final"]);
  });
});
