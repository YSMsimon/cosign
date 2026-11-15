import { Suspense } from "react";
import { ChatView } from "./chat-view";
import { VoiceProvider } from "./voice-provider";

// the page is all client-side data (it waits for your session), so Next's instant-navigation check has nothing to validate
export const instant = false;

/** Rooms and agents. ?agent=<id> picks the agent (read with useSearchParams, which needs a Suspense boundary). */
export default function ChatPage() {
  return (
    /* ElevenLabs' voice session lives above the Suspense boundary, so nothing that suspends inside can end a call */
    <VoiceProvider>
      <Suspense>
        <ChatView />
      </Suspense>
    </VoiceProvider>
  );
}
