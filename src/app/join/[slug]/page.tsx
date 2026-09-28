import type { Metadata } from "next";
import type { SearchParams } from "@/components/ui";
import { JoinPage } from "../page-shared";

export const metadata: Metadata = { title: "Book your first lesson" };

/** /join/<school-slug>: the link a school shares with prospective students. */
export default async function JoinSchool({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: SearchParams }) {
  const { slug } = await params;
  return <JoinPage slug={slug} searchParams={searchParams} />;
}
