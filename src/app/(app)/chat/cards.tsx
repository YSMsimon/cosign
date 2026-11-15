"use client";

import type { Agent } from "../../mockups/v2/agents";
import type { ToolCall } from "./thread-view";

/** The card under a tool call that needs a person (filled in with the approvals). */
export function ToolCard({ call, agent }: { call: ToolCall; agent: Agent }) {
  void call;
  void agent;
  return null;
}
