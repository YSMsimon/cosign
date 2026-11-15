import { CosignProvider } from "./cosign";

/** The signed-in app (chat and permissions): the account, the workspace and the live feed for every page in it. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <CosignProvider>{children}</CosignProvider>;
}
