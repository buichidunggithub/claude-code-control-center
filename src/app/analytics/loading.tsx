import { Shell } from "@/components/dashboard/shell";

export default function Loading() {
  return (
    <Shell active="analytics" title="Event facts">
      <p role="status" className="text-sm">Loading event facts…</p>
    </Shell>
  );
}
