// Isolated B1 acceptance fixture; not PR dashboard product code.
export function aggregateCI(checks) {
  if (checks.length === 0) {
    return 'no_checks';
  }
  if (checks.some((check) => check.status !== 'completed')) {
    return 'pending';
  }
  if (checks.some((check) => check.conclusion === 'failure')) {
    return 'failure';
  }
  return 'success';
}
