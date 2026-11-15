"use client";

/**
 * The signed-in app: who you are (/me), which workspace you are in (its treasury and your role), and the live feed
 * (one SSE stream per open page) that tells every screen when something changed. Signed out → the sign-in page.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, RefreshCw } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, type Me, type WorkspaceDetail } from "@/lib/client/api";
import { invalidate, useData } from "@/lib/client/data";

type Live = "activity" | "proposal.drafted" | "team.message";
type Handler = (data: Record<string, unknown>) => void;
const handlers = new Map<Live, Set<Handler>>();

type Cosign = {
  me: Me;
  ws: WorkspaceDetail;
  wsId: string;
  can: (perm: string) => boolean;
  /** this person's wallet address, lowercase */
  address: string;
};
const Ctx = createContext<Cosign | null>(null);

export function useCosign(): Cosign {
  const c = useContext(Ctx);
  if (!c) throw new Error("useCosign outside CosignProvider");
  return c;
}

/** Run `fn` when the live feed sends `event` (activity, proposal.drafted, team.message). */
export function useLive(event: Live, fn: Handler) {
  useEffect(() => {
    const set = handlers.get(event) ?? new Set();
    set.add(fn);
    handlers.set(event, set);
    return () => {
      set.delete(fn);
    };
  }, [event, fn]);
}

/** What each live event makes stale. */
const STALE: Record<Live, string[]> = {
  activity: ["ws:", "proposals:", "activity:", "spend:", "agent:"],
  "proposal.drafted": ["proposals:", "spend:"],
  "team.message": ["team-messages:", "funding:", "tasks:"],
};

const WS_KEY = "cosign-ws";
const savedWs = () => {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(WS_KEY);
  } catch {
    return null;
  }
};

function FullScreen({ children }: { children: React.ReactNode }) {
  return <main className="flex min-h-screen items-center justify-center bg-background p-8 text-foreground">{children}</main>;
}

export function CosignProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const me = useData("me", api.me);
  const [picked] = useState(savedWs);
  const wsId = me.data ? (me.data.workspaces.find((w) => w.id === picked)?.id ?? me.data.workspaces[0]?.id ?? null) : null;
  const ws = useData(wsId ? `ws:${wsId}` : null, () => api.workspace(wsId!));
  const signedOut = me.error instanceof ApiError && me.error.status === 401;
  const canView = !!ws.data?.me.permissions.includes("treasury.view");

  useEffect(() => {
    if (signedOut) router.replace("/sign-in");
  }, [signedOut, router]);

  useEffect(() => {
    if (wsId) {
      try {
        localStorage.setItem(WS_KEY, wsId);
      } catch {}
    }
  }, [wsId]);

  // the live feed: one stream per page; each event refreshes what it touched, then tells the screens
  useEffect(() => {
    if (!wsId || !canView) return;
    const es = new EventSource(`/api/v1/workspaces/${wsId}/activity/stream`);
    const on = (event: Live) => (e: MessageEvent) => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(e.data);
      } catch {}
      invalidate(...STALE[event]);
      for (const h of handlers.get(event) ?? []) h(data);
    };
    const events: Live[] = ["activity", "proposal.drafted", "team.message"];
    const fns = events.map((ev) => [ev, on(ev)] as const);
    for (const [ev, fn] of fns) es.addEventListener(ev, fn as EventListener);
    return () => {
      for (const [ev, fn] of fns) es.removeEventListener(ev, fn as EventListener);
      es.close();
    };
  }, [wsId, canView]);

  const value = useMemo<Cosign | null>(
    () =>
      me.data && ws.data && wsId
        ? { me: me.data, ws: ws.data, wsId, can: (p: string) => ws.data!.me.permissions.includes(p), address: me.data.address.toLowerCase() }
        : null,
    [me.data, ws.data, wsId],
  );

  if (signedOut || (me.loading && !me.data) || (wsId && ws.loading && !ws.data)) {
    return (
      <FullScreen>
        <Spinner size="sm" label="Opening Cosign" className="text-muted-foreground" />
      </FullScreen>
    );
  }
  // a failed refresh keeps what's on screen; only a first load that fails shows the error
  const err = (!me.data && me.error) || (!ws.data && ws.error);
  if (err) {
    return (
      <FullScreen>
        <Alert
          variant="destructive"
          className="max-w-md"
          action={
            <Button size="sm" variant="outline" onClick={() => (me.error ? me.reload() : ws.reload())}>
              <RefreshCw /> Try again
            </Button>
          }
        >
          <AlertTitle>Couldn&apos;t open Cosign</AlertTitle>
          <AlertDescription>{err.message}</AlertDescription>
        </Alert>
      </FullScreen>
    );
  }
  if (!wsId) {
    return (
      <FullScreen>
        <Empty className="max-w-md border border-dashed">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Building2 />
            </EmptyMedia>
            <EmptyTitle>You&apos;re not in a workspace yet</EmptyTitle>
            <EmptyDescription>
              Ask someone with All access to invite your wallet address ({me.data?.address}). You get in the next time you sign in.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </FullScreen>
    );
  }
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
