import { ProbePage } from './probe/ProbePage.js';

/**
 * Sprint 0 shell. The only screen for now is the capability probe, which answers the platform
 * questions the Shabbat and alarm design depends on with evidence from real devices rather than
 * from the spec.
 */
export function App() {
  return <ProbePage />;
}
