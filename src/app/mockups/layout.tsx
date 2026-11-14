import { TooltipProvider } from "@/components/ui/tooltip";

/** Design mockups only (static data, no backend calls). Not part of the product build. */
export default function MockupsLayout({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}
