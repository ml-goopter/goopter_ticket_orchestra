import { useParams } from "react-router";

/**
 * Placeholder for the spec builder (design.md §14, §8, D8). Replaced by
 * GOT.41.
 */
export function SpecBuilderView() {
  const { id } = useParams();
  return (
    <main>
      <h1>Spec builder</h1>
      <p>Task {id}</p>
    </main>
  );
}
