// Seed Free/Pro plans + demo tenant - TODO Phase 2 (writes via repos).
// Run: npm run seed
async function main(): Promise<void> {
  console.log('seed: not_implemented (Phase 2)');
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
