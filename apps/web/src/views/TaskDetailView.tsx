import { useParams } from "react-router";

/**
 * Placeholder for the task detail view (design.md §14, spec §26). Replaced
 * by GOT.38.
 */
export function TaskDetailView() {
  const { id } = useParams();
  return (
    <main>
      <h1>Task detail</h1>
      <p>Task {id}</p>
    </main>
  );
}
