"use client";

import { ConversationProvider } from "@elevenlabs/react";

/** ElevenLabs' voice session for the chat page (their package isn't marked client-only, so it's wrapped here). */
export function VoiceProvider({ children }: { children: React.ReactNode }) {
  return <ConversationProvider>{children}</ConversationProvider>;
}
