// Contract import descriptor for view.ts (LLP 0485 import boundaries).
// Hand-authored; `exact contract meta src/revu/view.ts --write` regenerates it.
import { defineContractModule, mutation, pure } from '@exact/contract/exports';

export default defineContractModule('./view.ts', {
  getView: pure({ params: ['_tick'], depends: 'args' }),
  signIn: mutation({ effects: ['github.auth'] }),
  signOutNow: mutation({ effects: ['github.auth'] }),
  refreshNow: mutation({ effects: ['sidecar.poll'] }),
  markRead: mutation({ params: { id: 'string' }, effects: ['sidecar.prs'] }),
});
