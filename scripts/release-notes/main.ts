import { run } from "./notes.ts";

/**
 * The entry point, run as `node scripts/release-notes/main.ts`. It is separate
 * from `notes.ts` because the module is what the tests call: importing an entry
 * point that runs on import would run during a test.
 */
const result = await run(process.argv.slice(2));
if (result.stdout !== "") {
	process.stdout.write(result.stdout);
}
if (result.stderr !== "") {
	process.stderr.write(result.stderr);
}
process.exitCode = result.code;
