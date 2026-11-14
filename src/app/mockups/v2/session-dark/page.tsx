import { Suspense } from "react";
import { SessionView } from "../session/view";

/** The same session in Pesto's dark theme, for comparison with the Grok Bot look. */
export default function SessionDarkPage() {
  return (
    <div className="dark bg-background text-foreground">
      <Suspense>
        <SessionView />
      </Suspense>
    </div>
  );
}
