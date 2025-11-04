/**
 * JobMap - Main entry point
 */

function main(): void {
  console.log('Welcome to JobMap!');
  console.log('JobMap is ready to help you manage and map your jobs.');
}

// Run the main function if this file is executed directly
if (require.main === module) {
  main();
}

export { main };
