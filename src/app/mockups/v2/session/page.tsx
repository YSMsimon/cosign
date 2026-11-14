import { Suspense } from "react";
import { SessionView } from "./view";

/** ?agent=<id> picks the agent (the view reads it with useSearchParams, which needs a Suspense boundary). */
export default function SessionPage() {
  return (
    <Suspense>
      <SessionView />
    </Suspense>
  );
}
