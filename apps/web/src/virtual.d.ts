declare module 'virtual:git-snapshot' {
  import type { GitSnapshot } from './protocol';
  const snapshot: GitSnapshot;
  export default snapshot;
}
