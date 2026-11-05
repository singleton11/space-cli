/**
 * Space project identifier normalization.
 *
 * Pinned live (Step 0 + M2 probe, jetbrains.team):
 * - `key:XX`, `id:XX`, and bare project **ids** all work in API paths;
 * - bare project **keys** (e.g. `IJ`) do NOT — Space answers
 *   `not-found: "Active project with ID IJ not found"`.
 *
 * The CLI's `--project` is documented as a project *key* (that is what
 * agents have — Space URLs expose keys, not ids), so colon-less values are
 * given the `key:` prefix. Use `id:<projectId>` to force the raw-id
 * interpretation; any `key:`/`id:`-prefixed value passes through untouched.
 */
export function projectParam(project: string): string {
  if (project.includes(':')) return project;
  return `key:${project}`;
}
