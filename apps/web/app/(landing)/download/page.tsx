import { redirect } from "next/navigation";

// BayClaw is server-centric: agents run on shared cloud runtimes, so there
// is no desktop app or CLI to download. Old links land on login instead.
export default function DownloadPage() {
  redirect("/login");
}
