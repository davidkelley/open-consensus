// Plan D18: the default test suite must NEVER run with the live-E2E flag set.
// Live tests cost real money (they spawn real agent CLIs); they run only via
// `npm run test:e2e:live`. If the flag leaks into a normal `npm test`, refuse.
if (process.env.OPEN_CONSENSUS_E2E_LIVE === '1') {
  throw new Error(
    'OPEN_CONSENSUS_E2E_LIVE=1 is set during the default test suite. ' +
      'Live E2E tests must run only via `npm run test:e2e:live`. ' +
      'Refusing to run the default suite to avoid real CLI spend.',
  )
}
