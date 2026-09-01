"use client";

import { Suspense } from "react";
import SearchPageInner from "./SearchPageInner";

export default function SearchPage() {
  return (
    <Suspense fallback={<main className="card"><p>Loading...</p></main>}>
      <SearchPageInner />
    </Suspense>
  );
}
