import type { OpencodeClient } from "@mimo-ai/sdk/v2";

export type RuntimeStatus = "idle" | "starting" | "connected" | "reconnecting" | "error";

export interface RuntimeState {
  root: string;
  status: RuntimeStatus;
  url?: string;
  error?: string;
}

export interface RuntimeEntry extends RuntimeState {
  client?: OpencodeClient;
}

export interface BootstrapData {
  sessions: unknown[];
  providers: unknown;
  commands: unknown[];
  agents: unknown[];
  permissions: unknown[];
  config: unknown;
  sessionStatus: unknown;
}

export interface SessionData {
  session: unknown;
  messages: unknown[];
  todos: unknown[];
  children: unknown[];
  actors: unknown;
  status: unknown;
}
