/**
 * Look at the browser-test workspace from the terminal (signs in as its throwaway owner):
 *   pnpm tsx --env-file=.env.local tests/browser/peek.ts thread|proposals|approvals|tasks|funding|agent
 */
import { api, signIn } from "../e2e/helpers";
import { personFromKey, readState } from "./shared";

(async () => {
const what = process.argv[2] ?? "thread";
const s = readState();
const owner = personFromKey("owner", s.ownerKey);
await signIn(owner);
const paths: Record<string, string> = {
  thread: `/agents/${s.agent}/thread`,
  proposals: `/workspaces/${s.ws}/proposals`,
  approvals: `/workspaces/${s.ws}/approvals?status=all`,
  tasks: `/workspaces/${s.ws}/tasks`,
  funding: `/workspaces/${s.ws}/funding-requests`,
  agent: `/agents/${s.agent}`,
};
const r = await api(owner, "GET", paths[what]);
const out = what === "thread" ? { ...r.json, messages: r.json.messages.slice(-Number(process.argv[3] ?? 8)) } : r.json;
console.log(JSON.stringify(out, null, 1).slice(0, what === "thread" ? 6000 : 200000));
process.exit(0);
})();
