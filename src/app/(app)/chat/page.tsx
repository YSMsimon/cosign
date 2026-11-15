import { Suspense } from "react";
import { ChatView } from "./chat-view";

/** Rooms and agents. ?agent=<id> picks the agent (read with useSearchParams, which needs a Suspense boundary). */
export default function ChatPage() {
  return (
    <Suspense>
      <ChatView />
    </Suspense>
  );
}
