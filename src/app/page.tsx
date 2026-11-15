import { redirect } from "next/navigation";

/** The app starts in rooms and agents; signed out, that page sends you to sign in. */
export default function Home() {
  redirect("/chat");
}
