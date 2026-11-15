import { Suspense } from "react";
import { PermissionsView } from "./permissions-view";

// all client-side data (it waits for your session), so Next's instant-navigation check has nothing to validate
export const instant = false;

/** Who can do what, what each agent may spend, and the treasury. ?tab= picks the tab, ?agent= the agent. */
export default function PermissionsPage() {
  return (
    <Suspense>
      <PermissionsView />
    </Suspense>
  );
}
