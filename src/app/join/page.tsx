import type { Metadata } from "next";
import type { SearchParams } from "@/components/ui";
import { JoinPage } from "./page-shared";

export const metadata: Metadata = { title: "Book your first lesson" };

/** Bare /join: resolves automatically when this deployment hosts exactly one school. */
export default function Join({ searchParams }: { searchParams: SearchParams }) {
  return <JoinPage searchParams={searchParams} />;
}
