import * as path from "node:path";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Only a local, unauthenticated MiMoCode service may be used by this extension. */
export function isLoopbackServiceUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:"
      && LOOPBACK_HOSTS.has(url.hostname)
      && url.port.length > 0
      && !url.username
      && !url.password;
  } catch {
    return false;
  }
}

export function encodedDirectoryHeader(directory: string): string {
  return encodeURIComponent(directory);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Incrementally decodes SSE data frames across arbitrary stream chunk boundaries. */
export class SseFrameDecoder {
  private buffer = "";
  private dataLines: string[] = [];

  public push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return this.consume(lines);
  }

  public finish(): string[] {
    const lines = this.buffer ? [this.buffer, ""] : [];
    this.buffer = "";
    return this.consume(lines);
  }

  private consume(lines: string[]): string[] {
    const events: string[] = [];
    for (const line of lines) {
      if (line === "") {
        if (this.dataLines.length > 0) events.push(this.dataLines.join("\n"));
        this.dataLines = [];
      } else if (line.startsWith("data:")) {
        this.dataLines.push(line.slice(5).trimStart());
      }
    }
    return events;
  }
}
