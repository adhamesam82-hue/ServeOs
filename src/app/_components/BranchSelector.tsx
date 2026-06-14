"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";

type Branch = { id: string; name: string };

function BranchSelectorInner({
  branches,
  currentBranchId,
}: {
  branches: Branch[];
  currentBranchId?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function handleChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const params = new URLSearchParams(searchParams.toString());
    if (e.target.value) {
      params.set("branch", e.target.value);
    } else {
      params.delete("branch");
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <label>
      Branch:{" "}
      <select value={currentBranchId ?? ""} onChange={handleChange}>
        <option value="">All branches</option>
        {branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BranchSelector(props: { branches: Branch[]; currentBranchId?: string }) {
  return (
    <Suspense fallback={<select disabled><option>Loading…</option></select>}>
      <BranchSelectorInner {...props} />
    </Suspense>
  );
}
