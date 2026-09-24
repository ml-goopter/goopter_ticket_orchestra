import { useParams } from "react-router";

/**
 * Placeholder for the issue detail view (design.md §14, spec §18, §19).
 * Replaced by GOT.42.
 */
export function IssueDetailView() {
  const { id } = useParams();
  return (
    <main>
      <h1>Issue detail</h1>
      <p>Issue {id}</p>
    </main>
  );
}
