/** Source requires target. Unknown labels remain knowledge edges, outside learning paths. */
export function isRequirement(relation: string): boolean {
  return ['requires', 'relies on', 'depends on', 'requires understanding']
    .includes(relation.trim().toLowerCase())
}
